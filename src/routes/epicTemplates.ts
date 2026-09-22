// Epic templates: save/apply a project-kickoff blueprint composing an epic shell with a set of
// task templates and (optionally) a sprint template — instantiated together via POST /:id/use.
import { Router } from 'express';
import { z } from 'zod';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { pool } from '../config/db.js';
import { createEpic } from '../services/epicService.js';
import { createTask, logTaskActivity } from '../services/taskService.js';
import { fireWebhooks } from '../services/webhookService.js';
import { logger } from '../config/logger.js';

const router = Router();
router.use(requireWorkspace);

const schema = z.object({
  name:               z.string().trim().min(1).max(255),
  epic_title:          z.string().trim().min(1).max(500),
  epic_description:    z.preprocess((v) => (v === '' ? null : v), z.string().max(5000).nullable().optional()),
  // Must match epics.ts's own format guarantee — epicService.createEpic() does no revalidation
  // of its own, and this value flows straight into epics.color both when the template is saved
  // and when it's instantiated via POST /:id/use, so a loose bound here (previously just
  // max(20), no format check) let a non-hex value bypass the format invariant epics.ts enforces
  // app-wide for every other epic-creation path.
  epic_color:          z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  sprint_template_id:  z.string().uuid().nullable().optional(),
  task_template_ids:   z.array(z.string().uuid()).max(50).default([])
    .refine((ids) => new Set(ids).size === ids.length, { message: 'task_template_ids must not contain duplicates' }),
});

const useTemplateSchema = z.object({
  epic_title:  z.string().trim().min(1).max(500).optional(),
  start_date:  z.preprocess((v) => (v === '' ? undefined : v), z.string().date().optional()),
});

interface EpicTemplateRow {
  id: string;
  workspace_id: string;
  name: string;
  epic_title: string;
  epic_description: string | null;
  epic_color: string;
  sprint_template_id: string | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

type Queryable = Pick<import('pg').PoolClient, 'query'>;

/** Returns an error message if any sprint/task template reference isn't in this workspace. */
async function validateTemplateRefs(
  workspaceId: string,
  sprintTemplateId: string | null | undefined,
  taskTemplateIds: string[] | undefined,
): Promise<string | null> {
  if (sprintTemplateId) {
    const check = await pool.query('SELECT 1 FROM sprint_templates WHERE id = $1 AND workspace_id = $2', [sprintTemplateId, workspaceId]);
    if (check.rows.length === 0) return 'Invalid sprint_template_id';
  }
  if (taskTemplateIds && taskTemplateIds.length > 0) {
    const check = await pool.query('SELECT id FROM task_templates WHERE workspace_id = $1 AND id = ANY($2)', [workspaceId, taskTemplateIds]);
    if (check.rows.length !== taskTemplateIds.length) return 'Invalid task_template_ids';
  }
  return null;
}

async function insertTaskTemplateLinks(db: Queryable, epicTemplateId: string, taskTemplateIds: string[]): Promise<void> {
  if (taskTemplateIds.length === 0) return;
  const values: unknown[] = [];
  const placeholders = taskTemplateIds.map((id, i) => {
    values.push(epicTemplateId, id, i);
    return `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`;
  });
  await db.query(
    `INSERT INTO epic_template_tasks (epic_template_id, task_template_id, position) VALUES ${placeholders.join(',')}`,
    values,
  );
}

/** Pure calendar arithmetic on a 'YYYY-MM-DD' string (no server-timezone dependence). */
function addDaysToDateString(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

async function getTaskTemplateIds(epicTemplateId: string, db: Pick<import('pg').PoolClient, 'query'> = pool): Promise<string[]> {
  const { rows } = await db.query<{ task_template_id: string }>(
    'SELECT task_template_id FROM epic_template_tasks WHERE epic_template_id = $1 ORDER BY position',
    [epicTemplateId],
  );
  return rows.map((r) => r.task_template_id);
}

// GET /api/epic-templates
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query<EpicTemplateRow>(
      'SELECT * FROM epic_templates WHERE workspace_id = $1 ORDER BY created_at DESC',
      [req.workspace.id],
    );

    // Previously one extra getTaskTemplateIds query per template (N+1) — a workspace with many
    // saved epic templates turned this single list endpoint into 1 + N round-trips. One batched
    // query grouped in application code instead.
    const { rows: taskLinks } = await pool.query<{ epic_template_id: string; task_template_id: string }>(
      `SELECT epic_template_id, task_template_id FROM epic_template_tasks
       WHERE epic_template_id = ANY($1) ORDER BY epic_template_id, position`,
      [rows.map((t) => t.id)],
    );
    const idsByTemplate = new Map<string, string[]>();
    for (const link of taskLinks) {
      const list = idsByTemplate.get(link.epic_template_id) ?? [];
      list.push(link.task_template_id);
      idsByTemplate.set(link.epic_template_id, list);
    }

    const withTasks = rows.map((t) => ({
      ...t,
      task_template_ids: idsByTemplate.get(t.id) ?? [],
    }));
    res.json(withTasks);
  } catch (err) { next(err); }
});

// POST /api/epic-templates  [admin]
router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    const { name, epic_title, epic_description, epic_color, sprint_template_id, task_template_ids } = parsed.data;

    const refError = await validateTemplateRefs(req.workspace.id, sprint_template_id, task_template_ids);
    if (refError) { res.status(400).json({ error: refError }); return; }

    // Template row + its task links are written in one transaction so a failed link insert
    // can't leave a template saved without its tasks.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<EpicTemplateRow>(
        `INSERT INTO epic_templates (workspace_id, name, epic_title, epic_description, epic_color, sprint_template_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [req.workspace.id, name, epic_title, epic_description ?? null, epic_color ?? '#6366f1', sprint_template_id ?? null, req.auth.userId],
      );
      const template = rows[0];
      await insertTaskTemplateLinks(client, template.id, task_template_ids);
      await client.query('COMMIT');
      res.status(201).json({ ...template, task_template_ids });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } catch (err) { next(err); }
});

// PATCH /api/epic-templates/:id  [admin]
router.patch('/:id', requireAdmin, async (req, res, next) => {
  try {
    const parsed = schema.partial().safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    if (Object.values(parsed.data).every((v) => v === undefined)) { res.status(400).json({ error: 'No fields to update' }); return; }

    // Validate every reference BEFORE writing anything - previously the row update was
    // committed first and an invalid task_template_ids then returned 400, half-applying the
    // PATCH. Same workspace check POST applies to sprint_template_id.
    const { task_template_ids, ...rest } = parsed.data;
    const refError = await validateTemplateRefs(req.workspace.id, rest.sprint_template_id, task_template_ids);
    if (refError) { res.status(400).json({ error: refError }); return; }

    const fields: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    // undefined = unchanged; null = clear (epic_description, sprint_template_id).
    const UPDATABLE = new Set(['name', 'epic_title', 'epic_description', 'epic_color', 'sprint_template_id']);
    for (const [k, v] of Object.entries(rest)) {
      if (!UPDATABLE.has(k) || v === undefined) continue;
      fields.push(`${k} = $${i++}`);
      values.push(v);
    }
    fields.push(`updated_at = now()`);
    values.push(req.params.id, req.workspace.id);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<EpicTemplateRow>(
        `UPDATE epic_templates SET ${fields.join(', ')} WHERE id = $${i++} AND workspace_id = $${i} RETURNING *`,
        values,
      );
      if (rows.length === 0) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: 'Not found' });
        return;
      }
      if (task_template_ids !== undefined) {
        await client.query('DELETE FROM epic_template_tasks WHERE epic_template_id = $1', [rows[0].id]);
        await insertTaskTemplateLinks(client, rows[0].id, task_template_ids);
      }
      const ids = await getTaskTemplateIds(rows[0].id, client);
      await client.query('COMMIT');
      res.json({ ...rows[0], task_template_ids: ids });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } catch (err) { next(err); }
});

// DELETE /api/epic-templates/:id  [admin]
router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    const result = await pool.query(
      'DELETE FROM epic_templates WHERE id = $1 AND workspace_id = $2',
      [req.params.id, req.workspace.id],
    );
    if ((result.rowCount ?? 0) === 0) { res.status(404).json({ error: 'Not found' }); return; }
    res.status(204).send();
  } catch (err) { next(err); }
});

// POST /api/epic-templates/:id/use  [admin] — creates an epic (+ optional sprint) and all
// linked task templates as tasks under it, in one call.
router.post('/:id/use', requireAdmin, async (req, res, next) => {
  try {
    const parsed = useTemplateSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

    const { rows: tplRows } = await pool.query<EpicTemplateRow>(
      'SELECT * FROM epic_templates WHERE id = $1 AND workspace_id = $2',
      [req.params.id, req.workspace.id],
    );
    if (tplRows.length === 0) { res.status(404).json({ error: 'Template not found' }); return; }
    const tpl = tplRows[0];

    // Wrapped in a transaction: epic creation, sprint creation, and each task-template
    // instantiation used to run as separate un-transacted statements — if any createTask call
    // failed partway through the loop (e.g. a stale template row), the epic and every task
    // created before the failure stayed committed, leaving a silently half-built project with
    // no rollback and no indication of what actually succeeded.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const epic = await createEpic(
        req.workspace.id,
        { title: parsed.data.epic_title ?? tpl.epic_title, description: tpl.epic_description ?? undefined, color: tpl.epic_color },
        req.auth.userId,
        client,
      );

      let sprintId: string | null = null;
      if (tpl.sprint_template_id) {
        const { rows: sprintTplRows } = await client.query(
          'SELECT * FROM sprint_templates WHERE id = $1 AND workspace_id = $2',
          [tpl.sprint_template_id, req.workspace.id],
        );
        if (sprintTplRows.length > 0) {
          const st = sprintTplRows[0];
          // Both ends are plain calendar dates: end = start + duration - 1 (inclusive), matching
          // sprintTemplates' /use. The old `new Date(start)` + setDate() mixed a UTC-parsed date
          // with local-time arithmetic, which can shift the end date by a day.
          const startDate = parsed.data.start_date ?? new Date().toISOString().slice(0, 10);
          const endDate = addDaysToDateString(startDate, st.duration_days - 1);
          const { rows: sprintRows } = await client.query(
            `INSERT INTO sprints (workspace_id, name, goal, status, start_date, end_date, created_by)
             VALUES ($1,$2,$3,'planning',$4,$5,$6) RETURNING id`,
            [req.workspace.id, st.name, st.goal, startDate, endDate, req.auth.userId],
          );
          sprintId = sprintRows[0].id;
        }
      }

      const taskTemplateIds = await getTaskTemplateIds(tpl.id, client);
      const createdTasks = [];
      if (taskTemplateIds.length > 0) {
        const { rows: taskTpls } = await client.query(
          'SELECT * FROM task_templates WHERE workspace_id = $1 AND id = ANY($2)',
          [req.workspace.id, taskTemplateIds],
        );
        const byId = new Map(taskTpls.map((t) => [t.id, t]));
        for (const id of taskTemplateIds) {
          const tt = byId.get(id);
          if (!tt) continue;
          const task = await createTask(
            req.workspace.id,
            {
              title: tt.title,
              description: tt.description ?? undefined,
              priority: tt.priority,
              tags: tt.tags,
              checklist: tt.checklist,
              epic_id: epic.id,
              sprint_id: sprintId,
            },
            req.auth.userId,
            client,
          );
          createdTasks.push(task);
        }
      }

      await client.query('COMMIT');

      // Same post-create side effects as POST /api/tasks, run only after the commit so
      // nothing is logged/announced for tasks that were rolled back.
      for (const task of createdTasks) {
        logTaskActivity(task.id, req.auth.userId, 'created', { status: task.status, source: 'epic_template' })
          .catch((err) => logger.warn({ err, taskId: task.id }, 'Failed to log task activity for epic template task'));
        fireWebhooks(req.workspace.id, 'task.created', { task });
      }

      res.status(201).json({ epic, sprint_id: sprintId, tasks: createdTasks });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } catch (err) { next(err); }
});

export default router;
