import { Router } from 'express';
import { z } from 'zod';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import { pool } from '../config/db.js';

const router = Router();
router.use(requireWorkspace);

const querySchema = z.object({
  from:  z.string().date().optional(),
  to:    z.string().date().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

interface ChangelogTask {
  id: string;
  title: string;
  priority: string;
  story_points: number | null;
  assignee_name: string | null;
  completed_at: string;
  sprint_name: string | null;
  epic_id: string | null;
  epic_title: string | null;
  epic_color: string | null;
}

interface ChangelogGroup {
  sprint_id: string | null;
  sprint_name: string | null;
  epic_id: string | null;
  epic_title: string | null;
  epic_color: string | null;
  tasks: ChangelogTask[];
  total_points: number;
}

// GET /api/changelog
router.get('/', async (req, res, next) => {
  try {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

    const { from, to, limit = 200 } = parsed.data;
    // H6: Use explicit UTC timestamps to avoid session-timezone ambiguity
    // Pass date strings and let PostgreSQL cast with timezone: date+time+offset
    const toDate   = to   ? `${to}T23:59:59Z`   : new Date().toISOString();
    const fromDate = from ? `${from}T00:00:00Z`  : new Date(Date.now() - 30 * 86400_000).toISOString();
    // Exclusive upper bound: midnight UTC of the day AFTER `to`. A `<= to 23:59:59` bound dropped
    // completions in the final (sub-)second of the day (timestamptz has microsecond precision).
    let toExclusive: string;
    if (to) {
      const next = new Date(`${to}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      toExclusive = next.toISOString();
    } else {
      // "now" + 1ms so a completion logged in the current millisecond is still included.
      toExclusive = new Date(Date.now() + 1).toISOString();
    }

    // Completion time = start of each done task's current "done" streak: the first status='done'
    // row after its last non-done status row. Taking the LATEST status='done' row instead moved a
    // task's completion forward every time a done task was edited (or dragged within Done).
    // 'created' covers tasks created directly as done (M5); historical 'moved' rows carry the
    // status of Kanban drags logged before the reorder path switched to logging 'updated'.
    const result = await pool.query<ChangelogTask & { sprint_id: string | null }>(
      `WITH status_rows AS (
         SELECT ta.task_id, ta.created_at, ta.payload->>'status' AS status
         FROM task_activity ta
         JOIN tasks t ON t.id = ta.task_id
         WHERE t.workspace_id = $1
           AND t.status = 'done'
           AND t.deleted_at IS NULL
           AND ta.action IN ('updated', 'created', 'moved')
           AND (ta.payload->>'status') IS NOT NULL
       ),
       last_reopen AS (
         SELECT task_id, MAX(created_at) AS reopened_at
         FROM status_rows
         WHERE status <> 'done'
         GROUP BY task_id
       ),
       done_times AS (
         SELECT sr.task_id, MIN(sr.created_at) AS completed_at
         FROM status_rows sr
         LEFT JOIN last_reopen lr ON lr.task_id = sr.task_id
         WHERE sr.status = 'done'
           AND (lr.reopened_at IS NULL OR sr.created_at > lr.reopened_at)
         GROUP BY sr.task_id
       )
       SELECT
         t.id,
         t.title,
         t.priority,
         t.story_points,
         t.sprint_id,
         wm.display_name                   AS assignee_name,
         dt.completed_at,
         sp.name                           AS sprint_name,
         e.id::text                        AS epic_id,
         e.title                           AS epic_title,
         e.color                           AS epic_color
       FROM done_times dt
       JOIN tasks t ON t.id = dt.task_id
       LEFT JOIN workspace_members wm ON wm.clerk_user_id = t.assignee_clerk_id AND wm.workspace_id = t.workspace_id
       LEFT JOIN sprints sp            ON sp.id = t.sprint_id
       LEFT JOIN epics   e             ON e.id  = t.epic_id
       WHERE t.workspace_id = $1
         AND dt.completed_at >= $2
         AND dt.completed_at < $3
       ORDER BY dt.completed_at DESC
       LIMIT $4`,
      [req.workspace.id, fromDate, toExclusive, limit],
    );

    // One group per sprint; tasks with no sprint are grouped by their epic instead (or into a
    // single ungrouped bucket). Epic info inside a sprint group is carried per task
    // (epic_title/epic_color on each row), not as nested sub-groups.
    const groupMap = new Map<string, ChangelogGroup>();

    for (const row of result.rows) {
      const key = row.sprint_id ?? `epic:${row.epic_id ?? 'none'}`;
      if (!groupMap.has(key)) {
        groupMap.set(key, {
          sprint_id:   row.sprint_id,
          sprint_name: row.sprint_name,
          epic_id:     row.sprint_id ? null : (row.epic_id ?? null),
          epic_title:  row.sprint_id ? null : (row.epic_title ?? null),
          epic_color:  row.sprint_id ? null : (row.epic_color ?? null),
          tasks:       [],
          total_points: 0,
        });
      }
      const group = groupMap.get(key)!;
      group.tasks.push(row);
      group.total_points += row.story_points ?? 0;
    }

    res.json({
      from: fromDate.slice(0, 10),
      to:   toDate.slice(0, 10),
      total_tasks: result.rows.length,
      total_points: result.rows.reduce((s, r) => s + (r.story_points ?? 0), 0),
      groups: Array.from(groupMap.values()),
      // Signals the UI that total_tasks/total_points/groups reflect only the most-recent
      // `limit` completions within the range, not the true total — same class of silent
      // undercount that analytics.ts's time-report fixed (this endpoint just uses a "most
      // recent N" cap by design rather than an unbounded aggregate, so a `truncated` flag is
      // the right fix here rather than a second unbounded query).
      truncated: result.rows.length === limit,
    });
  } catch (err) { next(err); }
});

export default router;
