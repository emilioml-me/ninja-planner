-- Project shares: token-based guest links with configurable scopes

-- gen_random_bytes() lives in pgcrypto; encode(..., 'base64url') is Postgres 18+ only, so the
-- token default is built from standard base64 made URL-safe by hand (see also 055).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS project_shares (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  token        TEXT        NOT NULL UNIQUE DEFAULT rtrim(translate(encode(gen_random_bytes(24), 'base64'), '+/', '-_'), '='),
  label        TEXT        NOT NULL DEFAULT 'Guest Link' CHECK (char_length(label) <= 100),
  scopes       TEXT[]      NOT NULL DEFAULT ARRAY['tasks:read','roadmap:read'],
  expires_at   TIMESTAMPTZ,
  created_by   TEXT        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS project_shares_workspace_idx ON project_shares(workspace_id);
CREATE INDEX IF NOT EXISTS project_shares_token_idx     ON project_shares(token);
