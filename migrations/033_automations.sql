-- Automation rules: trigger/action pairs fired on workspace events
CREATE TABLE IF NOT EXISTS automation_rules (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name           TEXT        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  trigger_type   TEXT        NOT NULL,
  trigger_config JSONB       NOT NULL DEFAULT '{}',
  action_type    TEXT        NOT NULL,
  action_config  JSONB       NOT NULL DEFAULT '{}',
  active         BOOLEAN     NOT NULL DEFAULT true,
  created_by     TEXT        NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS automation_logs (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id          UUID        NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
  workspace_id     UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  trigger_payload  JSONB,
  result           TEXT        NOT NULL DEFAULT 'ok' CHECK (result IN ('ok','error','skipped')),
  error_message    TEXT,
  ran_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS automation_rules_workspace_idx ON automation_rules(workspace_id);
CREATE INDEX IF NOT EXISTS automation_logs_rule_idx       ON automation_logs(rule_id);
CREATE INDEX IF NOT EXISTS automation_logs_workspace_idx  ON automation_logs(workspace_id, ran_at DESC);
