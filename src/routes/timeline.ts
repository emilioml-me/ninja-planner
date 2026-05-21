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

// GET /api/timeline — tasks with at least one date, plus sprints
router.get('/', async (req, res, next) => {
  try {
    const tasksResult = await pool.query<TimelineTask>(
      `SELECT
         t.id, t.title, t.status, t.priority,
         t.start_date::text, t.due_date::text,
         t.assignee_clerk_id, t.sprint_id, t.epic_id, t.story_points,
         wm.display_name                   AS assignee_name,
         sp.name                           AS sprint_name,
         e.title                           AS epic_title,
         e.color                           AS epic_color
       FROM tasks t
       LEFT JOIN workspace_members wm ON wm.clerk_user_id = t.assignee_clerk_id AND wm.workspace_id = t.workspace_id
       LEFT JOIN sprints sp            ON sp.id = t.sprint_id
       LEFT JOIN epics   e             ON e.id  = t.epic_id
       WHERE t.workspace_id = $1
         AND t.deleted_at IS NULL
         AND (t.start_date IS NOT NULL OR t.due_date IS NOT NULL)
       ORDER BY COALESCE(t.start_date, t.due_date) ASC
       LIMIT 500`,
      [req.workspace.id],
    );

    const sprintsResult = await pool.query<TimelineSprint>(
      `SELECT id, name, status, start_date::text, end_date::text
       FROM sprints
       WHERE workspace_id = $1
         AND (start_date IS NOT NULL OR end_date IS NOT NULL)
       ORDER BY start_date ASC NULLS LAST`,
      [req.workspace.id],
    );

    res.json({
      tasks:   tasksResult.rows,
      sprints: sprintsResult.rows,
    });
  } catch (err) { next(err); }
});

export default router;
