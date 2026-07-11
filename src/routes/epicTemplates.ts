// Epic templates: save/apply a project-kickoff blueprint composing an epic shell with a set of
// task templates and (optionally) a sprint template — instantiated together via POST /:id/use.
import { Router } from 'express';
import { z } from 'zod';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { pool } from '../config/db.js';
import { createEpic } from '../services/epicService.js';
import { createTask } from '../services/taskService.js';

const router = Router();
router.use(requireWorkspace);

const schema = z.object({
  name:               z.string().min(1).max(255),
  epic_title:          z.string().min(1).max(500),
  epic_description:    z.string().max(5000).nullable().optional(),
  epic_color:          z.string().max(20).optional(),
  sprint_template_id:  z.string().uuid().nullable().optional(),
  task_template_ids:   z.array(z.string().uuid()).max(50).default([])
    .refine((ids) => new Set(ids).size === ids.length, { message: 'task_template_ids must not contain duplicates' }),
});

const useTemplateSchema = z.object({
  epic_title:  z.string().min(1).max(500).optional(),
  start_date:  z.string().date().optional(),
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
    const withTasks = await Promise.all(rows.map(async (t) => ({
      ...t,
      task_template_ids: await getTaskTemplateIds(t.id),
    })));
    res.json(withTasks);
  } catch (err) { next(err); }
});

// POST /api/epic-templates  [admin]
router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    const { name, epic_title, epic_description, epic_color, sprint_template_id, task_template_ids } = parsed.data;

    if (sprint_template_id) {
      const check = await pool.query('SELECT 1 FROM sprint_templates WHERE id = $1 AND workspace_id = $2', [sprint_template_id, req.workspace.id]);
      if (check.rows.length === 0) { res.status(400).json({ error: 'Invalid sprint_template_id' }); return; }
    }
    if (task_template_ids.length > 0) {
      const check = await pool.query('SELECT id FROM task_templates WHERE workspace_id = $1 AND id = ANY($2)', [req.workspace.id, task_template_ids]);
      if (check.rows.length !== task_template_ids.length) { res.status(400).json({ error: 'Invalid task_template_ids' }); return; }
    }

    const { rows } = await pool.query<EpicTemplateRow>(
      `INSERT INTO epic_templates (workspace_id, name, epic_title, epic_description, epic_color, sprint_template_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.workspace.id, name, epic_title, epic_description ?? null, epic_color ?? '#6366f1', sprint_template_id ?? null, req.auth.userId],
    );
    const template = rows[0];

    if (task_template_ids.length > 0) {
      const values: unknown[] = [];
      const placeholders = task_template_ids.map((id, i) => {
        values.push(template.id, id, i);
        return `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`;
      });
      await pool.query(
        `INSERT INTO epic_template_tasks (epic_template_id, task_template_id, position) VALUES ${placeholders.join(',')}`,
        values,
      );
    }

    res.status(201).json({ ...template, task_template_ids });
  } catch (err) { next(err); }
});

// PATCH /api/epic-templates/:id  [admin]
router.patch('/:id', requireAdmin, async (req, res, next) => {
  try {
    const parsed = schema.partial().safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    if (Object.keys(parsed.data).length === 0) { res.status(400).json({ error: 'No fields to update' }); return; }

    const { task_template_ids, ...rest } = parsed.data;
    const fields: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    const UPDATABLE = new Set(['name', 'epic_title', 'epic_description', 'epic_color', 'sprint_template_id']);
    for (const [k, v] of Object.entries(rest)) {
      if (!UPDATABLE.has(k)) continue;
      fields.push(`${k} = $${i++}`);
      values.push(v ?? null);
    }
    fields.push(`updated_at = now()`);
    values.push(req.params.id, req.workspace.id);

    const { rows } = await pool.query<EpicTemplateRow>(
      `UPDATE epic_templates SET ${fields.join(', ')} WHERE id = $${i++} AND workspace_id = $${i} RETURNING *`,
      values,
    );
    if (rows.length === 0) { res.status(404).json({ error: 'Not found' }); return; }

    if (task_template_ids !== undefined) {
      if (task_template_ids.length > 0) {
        const check = await pool.query('SELECT id FROM task_templates WHERE workspace_id = $1 AND id = ANY($2)', [req.workspace.id, task_template_ids]);
        if (check.rows.length !== task_template_ids.length) { res.status(400).json({ error: 'Invalid task_template_ids' }); return; }
      }
      await pool.query('DELETE FROM epic_template_tasks WHERE epic_template_id = $1', [rows[0].id]);
      if (task_template_ids.length > 0) {
        const values2: unknown[] = [];
        const placeholders = task_template_ids.map((id, idx) => {
          values2.push(rows[0].id, id, idx);
          return `($${idx * 3 + 1}, $${idx * 3 + 2}, $${idx * 3 + 3})`;
        });
        await pool.query(
          `INSERT INTO epic_template_tasks (epic_template_id, task_template_id, position) VALUES ${placeholders.join(',')}`,
          values2,
        );
      }
    }

    res.json({ ...rows[0], task_template_ids: await getTaskTemplateIds(rows[0].id) });
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
          const startDate = parsed.data.start_date ?? new Date().toISOString().split('T')[0];
          const end = new Date(startDate);
          end.setDate(end.getDate() + st.duration_days - 1);
          const endDate = end.toISOString().split('T')[0];
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
      res.status(201).json({ epic, sprint_id: sprintId, tasks: createdTasks });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) { next(err); }
});

export default router;
