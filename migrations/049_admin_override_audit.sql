-- Append-only audit trail for admin subscription overrides. ninja_stack_subscriptions itself
-- only holds current state (overridden_by gets clobbered by the next ON CONFLICT UPDATE), so
-- there was no record of who granted/revoked a free-access override, or when.
BEGIN;

CREATE TABLE IF NOT EXISTS admin_override_audit (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  action        TEXT        NOT NULL CHECK (action IN ('granted', 'revoked')),
  plan          TEXT,
  actor_clerk_id TEXT       NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS admin_override_audit_workspace_idx ON admin_override_audit(workspace_id, created_at DESC);

COMMIT;
