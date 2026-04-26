-- ninja-planner initial schema
-- Run once against plan_ninja_db on ninja-db001

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─── workspaces ──────────────────────────────────────────────────────────────

CREATE TABLE workspaces (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  name          varchar(255)  NOT NULL,
  clerk_org_id  varchar(255)  NOT NULL UNIQUE,
  plan          varchar(50)   NOT NULL DEFAULT 'free',
  created_at    timestamptz   NOT NULL DEFAULT now(),
  updated_at    timestamptz   NOT NULL DEFAULT now()
);

-- ─── workspace_members ───────────────────────────────────────────────────────

CREATE TABLE workspace_members (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id    uuid          NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  clerk_user_id   varchar(255)  NOT NULL,
  role            varchar(50)   NOT NULL DEFAULT 'member',
  created_at      timestamptz   NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, clerk_user_id)
);

CREATE INDEX idx_workspace_members_workspace ON workspace_members(workspace_id);
CREATE INDEX idx_workspace_members_user      ON workspace_members(clerk_user_id);

-- ─── tasks ───────────────────────────────────────────────────────────────────

CREATE TABLE tasks (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id      uuid          NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title             varchar(500)  NOT NULL,
  description       text,
  status            varchar(50)   NOT NULL DEFAULT 'todo',     -- todo | in_progress | done | blocked
  priority          varchar(50)   NOT NULL DEFAULT 'medium',   -- low | medium | high | urgent
  assignee_clerk_id varchar(255),
  due_date          date,
  tags              text[]        NOT NULL DEFAULT '{}',
  position          integer       NOT NULL DEFAULT 0,
  created_by        varchar(255)  NOT NULL,
  deleted_at        timestamptz,
  created_at        timestamptz   NOT NULL DEFAULT now(),
  updated_at        timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX idx_tasks_workspace   ON tasks(workspace_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_tasks_status      ON tasks(workspace_id, status) WHERE deleted_at IS NULL;
CREATE INDEX idx_tasks_assignee    ON tasks(workspace_id, assignee_clerk_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_tasks_due_date    ON tasks(workspace_id, due_date) WHERE deleted_at IS NULL;

-- ─── task_activity ───────────────────────────────────────────────────────────

CREATE TABLE task_activity (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  task_id         uuid          NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  actor_clerk_id  varchar(255)  NOT NULL,
  action          varchar(100)  NOT NULL,
  payload         jsonb,
  created_at      timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX idx_task_activity_task ON task_activity(task_id);

-- ─── revenue_targets ─────────────────────────────────────────────────────────

CREATE TABLE revenue_targets (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id    uuid          NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  period_type     varchar(20)   NOT NULL,                      -- monthly | quarterly | yearly
  period_start    date          NOT NULL,
  target_amount   numeric(12,2) NOT NULL,
  actual_amount   numeric(12,2) NOT NULL DEFAULT 0,
  notes           text,
  created_at      timestamptz   NOT NULL DEFAULT now(),
  updated_at      timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX idx_revenue_targets_workspace ON revenue_targets(workspace_id);

-- ─── clients ─────────────────────────────────────────────────────────────────

CREATE TABLE clients (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id    uuid          NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name            varchar(255)  NOT NULL,
  contact_name    varchar(255),
  contact_email   varchar(255),
  stage           varchar(50)   NOT NULL DEFAULT 'prospect',   -- prospect | proposal | active | churned
  mrr             numeric(12,2) NOT NULL DEFAULT 0,
  notes           text,
  created_at      timestamptz   NOT NULL DEFAULT now(),
  updated_at      timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX idx_clients_workspace ON clients(workspace_id);
CREATE INDEX idx_clients_stage     ON clients(workspace_id, stage);

-- ─── roadmap_items ───────────────────────────────────────────────────────────

CREATE TABLE roadmap_items (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id    uuid          NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title           varchar(500)  NOT NULL,
  description     text,
  phase           varchar(100),
  status          varchar(50)   NOT NULL DEFAULT 'idea',       -- idea | building | live | archived
  priority        integer       NOT NULL DEFAULT 0,
  created_at      timestamptz   NOT NULL DEFAULT now(),
  updated_at      timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX idx_roadmap_workspace ON roadmap_items(workspace_id);
CREATE INDEX idx_roadmap_status    ON roadmap_items(workspace_id, status);

-- ─── weekly_reviews ──────────────────────────────────────────────────────────

CREATE TABLE weekly_reviews (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id    uuid          NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  week_start      date          NOT NULL,
  wins            text,
  blockers        text,
  focus_next      text,
  health_score    integer       CHECK (health_score BETWEEN 1 AND 5),
  created_by      varchar(255)  NOT NULL,
  created_at      timestamptz   NOT NULL DEFAULT now(),
  updated_at      timestamptz   NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, week_start)
);

CREATE INDEX idx_weekly_reviews_workspace ON weekly_reviews(workspace_id);

-- ─── updated_at trigger ──────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_workspaces_updated_at
  BEFORE UPDATE ON workspaces
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_tasks_updated_at
  BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_revenue_targets_updated_at
  BEFORE UPDATE ON revenue_targets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_clients_updated_at
  BEFORE UPDATE ON clients
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_roadmap_items_updated_at
  BEFORE UPDATE ON roadmap_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_weekly_reviews_updated_at
  BEFORE UPDATE ON weekly_reviews
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
