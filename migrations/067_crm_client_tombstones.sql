-- 067: remember CRM-linked clients deleted in the planner, so the CRM sync/webhook doesn't
-- silently re-create them. external_crm_id matches clients.external_crm_id (TEXT, 046).
CREATE TABLE IF NOT EXISTS crm_client_tombstones (
  workspace_id    UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  external_crm_id TEXT        NOT NULL,
  deleted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, external_crm_id)
);
