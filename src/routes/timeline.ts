import { Router } from 'express';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import { pool } from '../config/db.js';

const router = Router();
router.use(requireWorkspace);

interface TimelineTask {
  id: string;
  title: string;
  status: string;
  priority: string;
  start_date: string | null;
  due_date: string | null;
  assignee_clerk_id: string | null;
  assignee_name: string | null;
  sprint_id: string | null;
  sprint_name: string | null;
  epic_id: string | null;
  epic_title: string | null;
  epic_color: string | null;
  story_points: number | null;
}

interface TimelineSprint {
  id: string;
  name: string;
  status: string;
  start_date: string | null;
  end_date: string | null;
}

const TASK_CAP = 500;

// GET /api/timeline — tasks with at least one date, plus sprints
router.get('/', async (req, res, next) => {
  try {
    // Capped at TASK_CAP rows. The cap used to be applied after ORDER BY date ASC, which kept the
    // OLDEST tasks and silently dropped current/future work once a workspace had enough history.
    // Instead keep the TASK_CAP tasks whose date range is closest to today (distance 0 when the
    // range spans today), then return them in chronological order. One extra row is fetched
    // only to detect truncation exactly.
    const tasksResult = await pool.query<TimelineTask & { sort_date: string }>(
      `SELECT
         t.id, t.title, t.status, t.priority,
         t.start_date::text, t.due_date::text,
         t.assignee_clerk_id, t.sprint_id, t.epic_id, t.story_points,
         wm.display_name                   AS assignee_name,
         sp.name                           AS sprint_name,
         e.title                           AS epic_title,
         e.color                           AS epic_color,
         COALESCE(t.start_date, t.due_date)::text AS sort_date
       FROM tasks t
       LEFT JOIN workspace_members wm ON wm.clerk_user_id = t.assignee_clerk_id AND wm.workspace_id = t.workspace_id
       LEFT JOIN sprints sp            ON sp.id = t.sprint_id
       LEFT JOIN epics   e             ON e.id  = t.epic_id
       WHERE t.workspace_id = $1
         AND t.deleted_at IS NULL
         AND (t.start_date IS NOT NULL OR t.due_date IS NOT NULL)
       ORDER BY
         CASE
           WHEN COALESCE(t.due_date, t.start_date) < CURRENT_DATE
             THEN CURRENT_DATE - COALESCE(t.due_date, t.start_date)
           WHEN COALESCE(t.start_date, t.due_date) > CURRENT_DATE
             THEN COALESCE(t.start_date, t.due_date) - CURRENT_DATE
           ELSE 0
         END ASC,
         t.id
       LIMIT $2`,
      [req.workspace.id, TASK_CAP + 1],
    );
    const truncated = tasksResult.rows.length > TASK_CAP;
    // Drop the farthest-from-today extra row (rows are in distance order), then re-sort
    // chronologically for the chart.
    const tasks = tasksResult.rows
      .slice(0, TASK_CAP)
      .sort((a, b) => (a.sort_date < b.sort_date ? -1 : a.sort_date > b.sort_date ? 1 : a.id.localeCompare(b.id)))
      .map(({ sort_date: _sortDate, ...t }) => t);

    const sprintsResult = await pool.query<TimelineSprint>(
      `SELECT id, name, status, start_date::text, end_date::text
       FROM sprints
       WHERE workspace_id = $1
         AND (start_date IS NOT NULL OR end_date IS NOT NULL)
       ORDER BY start_date ASC NULLS LAST`,
      [req.workspace.id],
    );

    res.json({
      tasks,
      sprints:   sprintsResult.rows,
      truncated,  // M4: signal to UI that tasks far from today were left out
    });
  } catch (err) { next(err); }
});

export default router;
