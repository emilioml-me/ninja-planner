-- Migration 024: display_name and email on workspace_members
-- These fields are cached from Clerk and updated lazily on first request
-- (and eagerly via the organizationMembership webhook going forward).
-- Nullable so existing rows are not broken.

ALTER TABLE workspace_members
  ADD COLUMN IF NOT EXISTS display_name TEXT,
  ADD COLUMN IF NOT EXISTS email        TEXT,
  ADD COLUMN IF NOT EXISTS avatar_url   TEXT;

CREATE INDEX IF NOT EXISTS workspace_members_display_name_idx
  ON workspace_members (workspace_id, display_name)
  WHERE display_name IS NOT NULL;
