import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import { pool } from '../config/db.js';

const router = Router({ mergeParams: true });
router.use(requireWorkspace);

const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://10.10.2.20:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'qwen2.5:14b';

// 5 AI requests per minute per IP — Ollama holds each request for up to 30 s
const aiLimiter = rateLimit({
  windowMs: 60_000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many AI summary requests, please try again later' },
});

// POST /api/sprints/:sprintId/ai-summary
router.post('/', aiLimiter, async (req, res, next) => {
  try {
    const { sprintId } = req.params as Record<string, string>;
    // Load sprint + task breakdown
    const sprintResult = await pool.query<{
      name: string;
      goal: string | null;
      status: string;
      start_date: string | null;
      end_date: string | null;
      total_tasks: number;
      done_tasks: number;
      total_points: number;
      done_points: number;
      blocked_tasks: number;
    }>(
      `SELECT
         s.name, s.goal, s.status, s.start_date, s.end_date,
         COUNT(t.id)::int                                                      AS total_tasks,
         COUNT(t.id) FILTER (WHERE t.status = 'done')::int                    AS done_tasks,
         COALESCE(SUM(t.story_points), 0)::int                                AS total_points,
         COALESCE(SUM(t.story_points) FILTER (WHERE t.status = 'done'), 0)::int AS done_points,
         COUNT(t.id) FILTER (WHERE t.status = 'blocked')::int                 AS blocked_tasks
       FROM sprints s
       LEFT JOIN tasks t ON t.sprint_id = s.id AND t.deleted_at IS NULL
       WHERE s.id = $1 AND s.workspace_id = $2
       GROUP BY s.id`,
      [sprintId, req.workspace.id],
    );

    if (sprintResult.rows.length === 0) {
      res.status(404).json({ error: 'Sprint not found' }); return;
    }
    const sprint = sprintResult.rows[0];

    // Load incomplete high/urgent tasks for context
    const incompleteResult = await pool.query<{ title: string; priority: string; status: string }>(
      `SELECT title, priority, status
       FROM tasks
       WHERE sprint_id = $1 AND workspace_id = $2
         AND status <> 'done' AND deleted_at IS NULL
         AND priority IN ('high', 'urgent')
       ORDER BY CASE priority WHEN 'urgent' THEN 0 ELSE 1 END, title
       LIMIT 10`,
      [sprintId, req.workspace.id],
    );
    const incompleteTasks = incompleteResult.rows;

    const pct = sprint.total_tasks > 0
      ? Math.round((sprint.done_tasks / sprint.total_tasks) * 100)
      : 0;

    const prompt = `You are a scrum master assistant. Summarize the following sprint data concisely in 3-5 sentences. Focus on health, risks, and one actionable recommendation. Be direct and professional.

Sprint: "${sprint.name}"
Goal: ${sprint.goal ?? 'none'}
Status: ${sprint.status}
Progress: ${sprint.done_tasks}/${sprint.total_tasks} tasks done (${pct}%)
Story points: ${sprint.done_points}/${sprint.total_points} pts done
Blocked tasks: ${sprint.blocked_tasks}
${incompleteTasks.length > 0 ? `High-priority incomplete tasks: ${incompleteTasks.map((t) => `"${t.title}" (${t.priority}, ${t.status})`).join(', ')}` : ''}`;

    // Call Ollama (non-streaming)
    const ollamaRes = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!ollamaRes.ok) {
      res.status(502).json({ error: 'AI service unavailable' }); return;
    }

    const ollamaData = await ollamaRes.json() as { response?: string };
    const summary = ollamaData.response?.trim() ?? 'No summary generated.';

    res.json({ summary, sprint_name: sprint.name });
  } catch (err) {
    const e = err as Error;
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      res.status(504).json({ error: 'AI service timed out' }); return;
    }
    next(err);
  }
});

export default router;
