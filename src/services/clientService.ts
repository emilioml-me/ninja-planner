import { pool } from '../config/db.js';

export interface Client {
  id: string;
  workspace_id: string;
  name: string;
  contact_name: string | null;
  contact_email: string | null;
  stage: string;
  mrr: string;
  notes: string | null;
  external_crm_id: string | null;
  created_at: Date;
  updated_at: Date;
}

// sync-clients mirrors at most 2000 CRM contacts, so this cap covers a fully synced roster plus
// manual entries while still bounding the response.
const CLIENTS_LIST_LIMIT = 5000;

export async function getClients(workspaceId: string, stage?: string, limit = CLIENTS_LIST_LIMIT): Promise<Client[]> {
  const conditions = ['workspace_id = $1'];
  const values: unknown[] = [workspaceId];

  if (stage) {
    conditions.push(`stage = $2`);
    values.push(stage);
  }
  values.push(Math.min(Math.max(1, limit), CLIENTS_LIST_LIMIT));

  const result = await pool.query<Client>(
    `SELECT * FROM clients WHERE ${conditions.join(' AND ')} ORDER BY name, id LIMIT $${values.length}`,
    values,
  );
  return result.rows;
}

export async function createClient(
  workspaceId: string,
  data: {
    name: string;
    contact_name?: string;
    contact_email?: string;
    stage?: string;
    mrr?: number;
    notes?: string;
  },
): Promise<Client> {
  const result = await pool.query<Client>(
    `INSERT INTO clients (workspace_id, name, contact_name, contact_email, stage, mrr, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      workspaceId,
      data.name,
      data.contact_name ?? null,
      data.contact_email ?? null,
      data.stage ?? 'prospect',
      data.mrr ?? 0,
      data.notes ?? null,
    ],
  );
  return result.rows[0];
}

const CLIENT_UPDATABLE_COLUMNS = new Set(['name', 'contact_name', 'contact_email', 'stage', 'mrr', 'notes']);

export async function updateClient(
  id: string,
  workspaceId: string,
  data: Partial<Pick<Client, 'name' | 'contact_name' | 'contact_email' | 'stage' | 'notes'> & { mrr: number }>,
): Promise<Client | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  // undefined = leave unchanged; null = clear the column (nullable columns only).
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined && CLIENT_UPDATABLE_COLUMNS.has(key)) {
      fields.push(`${key} = $${i++}`);
      values.push(value);
    }
  }
  if (fields.length === 0) return null;
  fields.push('updated_at = now()');

  values.push(id, workspaceId);
  const result = await pool.query<Client>(
    `UPDATE clients SET ${fields.join(', ')} WHERE id = $${i++} AND workspace_id = $${i} RETURNING *`,
    values,
  );
  return result.rows[0] ?? null;
}

/**
 * Deletes a client. A CRM-mirrored client (external_crm_id set) also gets a tombstone in the same
 * transaction so the next sync-clients run / client.upserted webhook doesn't re-create it.
 */
export async function deleteClient(id: string, workspaceId: string): Promise<boolean> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const result = await db.query<{ external_crm_id: string | null }>(
      'DELETE FROM clients WHERE id = $1 AND workspace_id = $2 RETURNING external_crm_id',
      [id, workspaceId],
    );
    const externalId = result.rows[0]?.external_crm_id;
    if (externalId) {
      await db.query(
        `INSERT INTO crm_client_tombstones (workspace_id, external_crm_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [workspaceId, externalId],
      );
    }
    await db.query('COMMIT');
    return result.rows.length > 0;
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}
