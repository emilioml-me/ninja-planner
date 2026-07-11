BEGIN;
-- Generalizes custom fields beyond tasks. Existing rows default to 'task' so nothing already
-- defined/stored changes meaning. Kept task_id's hard FK as-is (safer than migrating existing
-- data onto a fully generic entity_id column) and added a parallel nullable client_id FK for the
-- first non-task entity — same shape, one more column, rather than a broader schema rewrite.
ALTER TABLE custom_field_defs ADD COLUMN IF NOT EXISTS entity_type TEXT NOT NULL DEFAULT 'task'
  CHECK (entity_type IN ('task', 'client'));

ALTER TABLE custom_field_values ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES clients(id) ON DELETE CASCADE;
ALTER TABLE custom_field_values ALTER COLUMN task_id DROP NOT NULL;
ALTER TABLE custom_field_values ADD CONSTRAINT custom_field_values_one_entity
  CHECK ((task_id IS NOT NULL) <> (client_id IS NOT NULL));

CREATE UNIQUE INDEX IF NOT EXISTS custom_field_values_client_unique
  ON custom_field_values(field_def_id, client_id) WHERE client_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS custom_field_values_client_idx ON custom_field_values(client_id);
CREATE INDEX IF NOT EXISTS custom_field_defs_entity_type_idx ON custom_field_defs(workspace_id, entity_type);
COMMIT;
