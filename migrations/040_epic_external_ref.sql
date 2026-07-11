BEGIN;
-- Mirrors roadmap_items.external_ref — link an epic to a GitHub issue/PR, Linear ticket, etc.
ALTER TABLE epics ADD COLUMN IF NOT EXISTS external_ref varchar(500);
COMMIT;
