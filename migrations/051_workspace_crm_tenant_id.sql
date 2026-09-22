-- crm-ninja has no multi-tenant/org concept of its own — its "tenant" is a single crm-ninja
-- user account (contacts/deals scoped by created_by/owner_id). To pull that account's data into
-- a specific ninja-planner workspace, we need an explicit mapping from workspace -> crm-ninja
-- user id, since the single global CRM_NINJA_URL/CRM_NINJA_API_KEY env vars say nothing about
-- which crm-ninja account a given workspace should see.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS crm_ninja_tenant_id INTEGER;
