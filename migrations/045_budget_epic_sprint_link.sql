-- Links a budget to a single epic or sprint so its actual spend can be rolled up from the
-- billable time already logged against that initiative, instead of only manual budget_entries.
BEGIN;

ALTER TABLE budgets ADD COLUMN IF NOT EXISTS epic_id   UUID REFERENCES epics(id)   ON DELETE SET NULL;
ALTER TABLE budgets ADD COLUMN IF NOT EXISTS sprint_id UUID REFERENCES sprints(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS budgets_epic_idx   ON budgets(epic_id)   WHERE epic_id   IS NOT NULL;
CREATE INDEX IF NOT EXISTS budgets_sprint_idx ON budgets(sprint_id) WHERE sprint_id IS NOT NULL;

COMMIT;
