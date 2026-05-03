-- Phase 5: Webhook Outbox + Roadmap external refs

-- ─── webhook_endpoints ────────────────────────────────────────────────────────

CREATE TABLE webhook_endpoints (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id uuid          NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  url          varchar(2048) NOT NULL,
  secret       varchar(255)  NOT NULL,  -- HMAC-SHA256 signing secret
  events       text[]        NOT NULL DEFAULT '{}',  -- empty array = subscribe to all events
  active       boolean       NOT NULL DEFAULT true,
  created_by   varchar(255)  NOT NULL,
  created_at   timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX idx_webhook_endpoints_workspace ON webhook_endpoints(workspace_id) WHERE active = true;

-- ─── webhook_deliveries ───────────────────────────────────────────────────────

CREATE TABLE webhook_deliveries (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  endpoint_id  uuid          NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event_type   varchar(100)  NOT NULL,
  payload      jsonb         NOT NULL,
  status       varchar(20)   NOT NULL DEFAULT 'pending',  -- success | failed
  http_status  integer,
  error        text,
  delivered_at timestamptz,
  created_at   timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX idx_webhook_deliveries_endpoint ON webhook_deliveries(endpoint_id, created_at DESC);

-- ─── roadmap_items: external reference ───────────────────────────────────────
-- GitHub issue/PR URL, Linear ticket URL, or any external link

ALTER TABLE roadmap_items ADD COLUMN external_ref varchar(500);

-- ─── revenue_targets: unique constraint for CRM sync upsert ──────────────────

ALTER TABLE revenue_targets
  ADD CONSTRAINT uq_revenue_targets_period UNIQUE (workspace_id, period_type, period_start);
