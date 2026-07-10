BEGIN;
-- Tracks when a row's actual_amount was last written by a CRM sync, so a slower/delayed sync
-- request can't silently overwrite a newer sync's figure with stale data if two /sync-revenue
-- calls (or a retry) land out of order.
ALTER TABLE revenue_targets ADD COLUMN IF NOT EXISTS crm_synced_at TIMESTAMPTZ;
COMMIT;
