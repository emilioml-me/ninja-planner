-- Migration 020's comment already claimed "per sprint per member" capacity, but the table only
-- ever had one row per (workspace, user) — there was no way to override capacity for a specific
-- sprint (e.g. a member on reduced hours for one sprint only). This adds that.
BEGIN;

ALTER TABLE member_capacity DROP CONSTRAINT member_capacity_pkey;
ALTER TABLE member_capacity ADD COLUMN IF NOT EXISTS id UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE member_capacity ADD PRIMARY KEY (id);
ALTER TABLE member_capacity ADD COLUMN IF NOT EXISTS sprint_id UUID REFERENCES sprints(id) ON DELETE CASCADE;

-- One workspace-wide default row per member (sprint_id IS NULL)...
CREATE UNIQUE INDEX IF NOT EXISTS member_capacity_default_unique
  ON member_capacity (workspace_id, user_clerk_id) WHERE sprint_id IS NULL;
-- ...and at most one override row per (member, sprint).
CREATE UNIQUE INDEX IF NOT EXISTS member_capacity_sprint_unique
  ON member_capacity (workspace_id, user_clerk_id, sprint_id) WHERE sprint_id IS NOT NULL;

COMMIT;
