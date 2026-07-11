-- Per-user, per-type notification mute preferences. Absence of a row means enabled
-- (opt-out model) — this avoids having to backfill a row per user per type on rollout.
BEGIN;

CREATE TABLE IF NOT EXISTS notification_preferences (
  workspace_id     UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  clerk_user_id    TEXT NOT NULL,
  type             TEXT NOT NULL,
  enabled          BOOLEAN NOT NULL DEFAULT true,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, clerk_user_id, type)
);

COMMIT;
