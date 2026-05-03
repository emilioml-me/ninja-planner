-- Phase 4: Power Features
-- Goals/OKRs, Sprints, Recurring Tasks, Public Roadmap share tokens

-- ─── goals ───────────────────────────────────────────────────────────────────

CREATE TABLE goals (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id uuid          NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title        varchar(500)  NOT NULL,
  description  text,
  status       varchar(50)   NOT NULL DEFAULT 'active',  -- active | completed | cancelled
  due_date     date,
  created_by   varchar(255)  NOT NULL,
  created_at   timestamptz   NOT NULL DEFAULT now(),
  updated_at   timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX idx_goals_workspace ON goals(workspace_id);

CREATE TRIGGER trg_goals_updated_at
  BEFORE UPDATE ON goals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── goal_links ───────────────────────────────────────────────────────────────
-- links tasks or roadmap_items to a goal

CREATE TABLE goal_links (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  goal_id     uuid          NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  entity_type varchar(50)   NOT NULL,  -- task | roadmap_item
  entity_id   uuid          NOT NULL,
  created_at  timestamptz   NOT NULL DEFAULT now(),
  UNIQUE (goal_id, entity_type, entity_id)
);

CREATE INDEX idx_goal_links_goal ON goal_links(goal_id);

-- ─── sprints ─────────────────────────────────────────────────────────────────

CREATE TABLE sprints (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id uuid          NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         varchar(255)  NOT NULL,
  goal         text,
  status       varchar(50)   NOT NULL DEFAULT 'planning',  -- planning | active | completed
  start_date   date,
  end_date     date,
  created_by   varchar(255)  NOT NULL,
  created_at   timestamptz   NOT NULL DEFAULT now(),
  updated_at   timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX idx_sprints_workspace ON sprints(workspace_id);

CREATE TRIGGER trg_sprints_updated_at
  BEFORE UPDATE ON sprints
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── tasks: new columns ───────────────────────────────────────────────────────

-- sprint_id — which sprint this task belongs to
ALTER TABLE tasks ADD COLUMN sprint_id uuid REFERENCES sprints(id) ON DELETE SET NULL;
CREATE INDEX idx_tasks_sprint ON tasks(sprint_id) WHERE deleted_at IS NULL;

-- recurrence_rule — daily | weekly | biweekly | monthly  (NULL = no recurrence)
-- when a recurring task is completed, the server automatically spawns a fresh copy
ALTER TABLE tasks ADD COLUMN recurrence_rule varchar(50);

-- ─── share_tokens (public roadmap links) ─────────────────────────────────────

CREATE TABLE share_tokens (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id uuid          NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  token        varchar(64)   NOT NULL UNIQUE,
  resource     varchar(50)   NOT NULL DEFAULT 'roadmap',
  created_by   varchar(255)  NOT NULL,
  expires_at   timestamptz,
  created_at   timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX idx_share_tokens_token ON share_tokens(token);
-- one active share per workspace per resource
CREATE UNIQUE INDEX idx_share_tokens_workspace_resource ON share_tokens(workspace_id, resource);
