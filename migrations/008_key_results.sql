-- Migration 008: OKR key results
-- Each goal can have multiple key results with numeric targets and progress

CREATE TABLE IF NOT EXISTS key_results (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  goal_id       UUID        NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  workspace_id  UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title         TEXT        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 500),
  target_value  NUMERIC     NOT NULL DEFAULT 100,
  current_value NUMERIC     NOT NULL DEFAULT 0,
  unit          TEXT        NOT NULL DEFAULT '%' CHECK (char_length(unit) <= 30),
  position      INT         NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS key_results_goal_id_idx      ON key_results(goal_id);
CREATE INDEX IF NOT EXISTS key_results_workspace_id_idx ON key_results(workspace_id);
