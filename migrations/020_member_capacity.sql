-- Member capacity: configurable story-point capacity per sprint per member
CREATE TABLE IF NOT EXISTS member_capacity (
  workspace_id    UUID    NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_clerk_id   TEXT    NOT NULL,
  capacity_points INTEGER NOT NULL DEFAULT 20 CHECK (capacity_points >= 0 AND capacity_points <= 500),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_clerk_id)
);
