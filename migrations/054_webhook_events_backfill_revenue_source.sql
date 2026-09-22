-- webhook_endpoints.events = '{}' originally meant "subscribe to ALL events" (see 004_phase5.sql).
-- Delivery now treats an empty array as "subscribed to nothing" and the API requires at least one
-- event, so legacy endpoints created with the old wildcard default would silently stop receiving
-- anything. Backfill them to the full current event list (must match ALL_EVENTS in
-- src/services/webhookService.ts).
UPDATE webhook_endpoints
SET events = ARRAY[
  'task.created', 'task.updated', 'task.completed', 'task.deleted',
  'review.submitted',
  'epic.created', 'epic.updated', 'epic.deleted',
  'sprint.completed', 'goal.completed'
]::text[]
WHERE events = '{}' OR events IS NULL;

-- Revenue sync source tracking. Both the CRM deal sync and the payments sync write
-- revenue_targets.actual_amount for the same monthly rows, and previously whichever ran last
-- silently replaced the other's figure. actual_source records which integration owns a synced
-- month ('crm' | 'payments'); a sync from the other source no longer overwrites it (see
-- upsertActualRevenue in src/services/revenueService.ts). NULL = manual entry or synced before
-- this column existed (either source may claim it).
ALTER TABLE revenue_targets ADD COLUMN IF NOT EXISTS actual_source TEXT
  CHECK (actual_source IS NULL OR actual_source IN ('crm', 'payments'));
