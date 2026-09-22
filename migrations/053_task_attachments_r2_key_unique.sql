-- One task_attachments row per R2 object. Previously the same r2_key could be confirmed more
-- than once (double submit / replayed confirm), so deleting one row's attachment deleted the
-- object out from under the other row. The confirm route now rejects duplicates and only deletes
-- R2 objects that no row references; this constraint enforces it at the DB level.

-- Dedupe first: keep the earliest row for each r2_key.
DELETE FROM task_attachments a
USING task_attachments b
WHERE a.r2_key = b.r2_key
  AND (a.created_at > b.created_at OR (a.created_at = b.created_at AND a.id > b.id));

CREATE UNIQUE INDEX IF NOT EXISTS task_attachments_r2_key_unique ON task_attachments (r2_key);
