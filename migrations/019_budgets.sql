-- Project budgets: target vs actual spend tracking
CREATE TABLE IF NOT EXISTS budgets (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   UUID         NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name           TEXT         NOT NULL CHECK (char_length(name) <= 255),
  description    TEXT,
  target_amount  NUMERIC(14,2) NOT NULL CHECK (target_amount >= 0),
  currency       TEXT         NOT NULL DEFAULT 'USD',
  period_start   DATE,
  period_end     DATE,
  status         TEXT         NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  created_by     TEXT         NOT NULL,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS budget_entries (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  budget_id      UUID         NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  workspace_id   UUID         NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  description    TEXT         NOT NULL CHECK (char_length(description) <= 500),
  amount         NUMERIC(14,2) NOT NULL,
  category       TEXT         CHECK (char_length(category) <= 100),
  entry_date     DATE         NOT NULL DEFAULT CURRENT_DATE,
  created_by     TEXT         NOT NULL,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS budgets_workspace_idx       ON budgets(workspace_id);
CREATE INDEX IF NOT EXISTS budget_entries_budget_idx   ON budget_entries(budget_id);
CREATE INDEX IF NOT EXISTS budget_entries_workspace_idx ON budget_entries(workspace_id);
