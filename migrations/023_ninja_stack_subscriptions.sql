-- ninja-stack subscription tracking (one row per workspace)
CREATE TABLE IF NOT EXISTS ninja_stack_subscriptions (
  workspace_id      TEXT        PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  code              TEXT        NOT NULL,
  plan              TEXT        NOT NULL DEFAULT 'starter',
  allowed_apps      TEXT[]      NOT NULL DEFAULT '{}',
  customer_email    TEXT,
  expires_at        TIMESTAMPTZ,
  activated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_verified_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  admin_override    BOOLEAN     NOT NULL DEFAULT FALSE,
  overridden_by     TEXT
);
