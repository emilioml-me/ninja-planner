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
  created_at: Date;
  updated_at: Date;
}

export async function getClients(workspaceId: string, stage?: string): Promise<Client[]> {
  const conditions = ['workspace_id = $1'];
  const values: unknown[] = [workspaceId];

  if (stage) {
    conditions.push(`stage = $2`);
    values.push(stage);
  }

  const result = await pool.query<Client>(
    `SELECT * FROM clients WHERE ${conditions.join(' AND ')} ORDER BY name`,
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

export async function updateClient(
  id: string,
  workspaceId: string,
  data: Partial<Pick<Client, 'name' | 'contact_name' | 'contact_email' | 'stage' | 'notes'> & { mrr: number }>,
): Promise<Client | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) {
      fields.push(`${key} = $${i++}`);
      values.push(value);
    }
  }
  if (fields.length === 0) return null;

  values.push(id, workspaceId);
  const result = await pool.query<Client>(
    `UPDATE clients SET ${fields.join(', ')} WHERE id = $${i++} AND workspace_id = $${i} RETURNING *`,
    values,
  );
  return result.rows[0] ?? null;
}

export async function deleteClient(id: string, workspaceId: string): Promise<boolean> {
  const result = await pool.query(
    'DELETE FROM clients WHERE id = $1 AND workspace_id = $2',
    [id, workspaceId],
  );
  return (result.rowCount ?? 0) > 0;
}
