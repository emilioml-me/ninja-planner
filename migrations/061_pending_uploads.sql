-- 061: track presigned attachment uploads until they are confirmed (review M39).
-- A presigned PUT whose upload is never confirmed left an orphan R2 object forever. A row is
-- inserted at presign time and deleted on confirm; attachmentCleanup.sweepPendingUploads()
-- deletes the R2 object + row for anything older than 24h.
CREATE TABLE IF NOT EXISTS pending_uploads (
  r2_key       TEXT        PRIMARY KEY,
  workspace_id UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id      UUID,
  created_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pending_uploads_created_at_idx ON pending_uploads (created_at);
