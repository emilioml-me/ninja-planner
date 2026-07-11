-- Lets crm-ninja's inbound webhook match a planner client back to its CRM deal/contact record.
BEGIN;

ALTER TABLE clients ADD COLUMN IF NOT EXISTS external_crm_id TEXT;

-- Scoped to workspace (unlike the ninja-task webhook's global external-id match, which was the
-- exact cross-tenant bug fixed for tasks earlier) — the same external_crm_id could legitimately
-- exist in two different workspaces' CRM data.
CREATE UNIQUE INDEX IF NOT EXISTS clients_workspace_external_crm_id_unique
  ON clients (workspace_id, external_crm_id) WHERE external_crm_id IS NOT NULL;

COMMIT;
