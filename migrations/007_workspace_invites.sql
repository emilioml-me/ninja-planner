-- Migration 007: workspace invite links
-- Token-based join links with 7-day expiry; one-time use tracked via used_at

CREATE TABLE IF NOT EXISTS workspace_invites (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  token        UUID        NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  created_by   TEXT        NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '7 days',
  used_at      TIMESTAMPTZ,
  used_by      TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workspace_invites_workspace_id_idx ON workspace_invites(workspace_id);
CREATE INDEX IF NOT EXISTS workspace_invites_token_idx        ON workspace_invites(token);
