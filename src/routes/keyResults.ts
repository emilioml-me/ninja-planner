import { Router } from 'express';
import { z } from 'zod';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import { pool } from '../config/db.js';

// Mounted at /api/goals/:goalId/key-results  (mergeParams: true)
const router = Router({ mergeParams: true });
router.use(requireWorkspace);

interface KeyResult {
  id: string;
  goal_id: string;
  workspace_id: string;
  title: string;
  target_value: number;
  current_value: number;
  unit: string;
  position: number;
  created_at: Date;
  updated_at: Date;
}

const createSchema = z.object({
  title:         z.string().min(1).max(500),
  target_value:  z.number().min(0).max(1_000_000_000).optional(),
  current_value: z.number().min(0).max(1_000_000_000).optional(),
  unit:          z.string().min(1).max(30).optional(),
  position:      z.number().int().min(0).optional(),
});

const updateSchema = z.object({
  title:         z.string().min(1).max(500).optional(),
  target_value:  z.number().min(0).max(1_000_000_000).optional(),
  current_value: z.number().min(0).max(1_000_000_000).optional(),
  unit:          z.string().min(1).max(30).optional(),
  position:      z.number().int().min(0).optional(),
});

/** Verify the goal belongs to the current workspace */
async function verifyGoal(goalId: string, workspaceId: string): Promise<boolean> {
  const r = await pool.query(
    'SELECT id FROM goals WHERE id = $1 AND workspace_id = $2',
    [goalId, workspaceId],
  );
  return r.rows.length > 0;
}

// GET /api/goals/:goalId/key-results
router.get('/', async (req, res, next) => {
  try {
    const { goalId } = req.params as Record<string, string>;
    if (!(await verifyGoal(goalId, req.workspace.id))) {
      res.status(404).json({ error: 'Goal not found' });
      return;
    }
    const result = await pool.query<KeyResult>(
      `SELECT * FROM key_results WHERE goal_id = $1 AND workspace_id = $2
       ORDER BY position, created_at`,
      [goalId, req.workspace.id],
    );
    res.json(result.rows);
  } catch (err) { next(err); }
});

// POST /api/goals/:goalId/key-results
router.post('/', async (req, res, next) => {
  try {
    const { goalId } = req.params as Record<string, string>;
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    if (!(await verifyGoal(goalId, req.workspace.id))) {
      res.status(404).json({ error: 'Goal not found' });
      return;
    }
    const { title, target_value = 100, current_value = 0, unit = '%', position = 0 } = parsed.data;
    const result = await pool.query<KeyResult>(
      `INSERT INTO key_results (goal_id, workspace_id, title, target_value, current_value, unit, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [goalId, req.workspace.id, title, target_value, current_value, unit, position],
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { next(err); }
});

// PATCH /api/goals/:goalId/key-results/:id
router.patch('/:id', async (req, res, next) => {
  try {
    const { goalId, id } = req.params as Record<string, string>;
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    if (Object.keys(parsed.data).length === 0) { res.status(400).json({ error: 'No fields to update' }); return; }

    const UPDATABLE = new Set(['title', 'target_value', 'current_value', 'unit', 'position']);
    const fields: string[] = ['updated_at = now()'];
    const values: unknown[] = [];
    let i = 1;
    for (const [key, value] of Object.entries(parsed.data)) {
      if (value !== undefined && UPDATABLE.has(key)) {
        fields.push(`${key} = $${i++}`);
        values.push(value);
      }
    }
    values.push(id, goalId, req.workspace.id);
    const result = await pool.query<KeyResult>(
      `UPDATE key_results SET ${fields.join(', ')}
       WHERE id = $${i++} AND goal_id = $${i++} AND workspace_id = $${i} RETURNING *`,
      values,
    );
    if (result.rows.length === 0) { res.status(404).json({ error: 'Key result not found' }); return; }
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/goals/:goalId/key-results/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const { goalId, id } = req.params as Record<string, string>;
    const result = await pool.query(
      'DELETE FROM key_results WHERE id = $1 AND goal_id = $2 AND workspace_id = $3',
      [id, goalId, req.workspace.id],
    );
    if ((result.rowCount ?? 0) === 0) { res.status(404).json({ error: 'Key result not found' }); return; }
    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
