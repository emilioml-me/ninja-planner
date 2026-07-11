BEGIN;
-- comments.ts accepted, validated, and used a `mentions` array to fan out notifications, but
-- never persisted it — there was no way to later query "who was mentioned" on a comment.
ALTER TABLE task_comments ADD COLUMN IF NOT EXISTS mentions TEXT[] NOT NULL DEFAULT '{}';
COMMIT;
