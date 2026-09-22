-- These tables all have an updated_at column but never got the BEFORE UPDATE trigger that
-- 001_init.sql defines (set_updated_at()), so updated_at stayed at the insert time unless a
-- route remembered to set it by hand. DROP ... IF EXISTS keeps this re-runnable.

DROP TRIGGER IF EXISTS trg_epics_updated_at ON epics;
CREATE TRIGGER trg_epics_updated_at
  BEFORE UPDATE ON epics
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_budgets_updated_at ON budgets;
CREATE TRIGGER trg_budgets_updated_at
  BEFORE UPDATE ON budgets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_sprint_retros_updated_at ON sprint_retros;
CREATE TRIGGER trg_sprint_retros_updated_at
  BEFORE UPDATE ON sprint_retros
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_epic_retros_updated_at ON epic_retros;
CREATE TRIGGER trg_epic_retros_updated_at
  BEFORE UPDATE ON epic_retros
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_automation_rules_updated_at ON automation_rules;
CREATE TRIGGER trg_automation_rules_updated_at
  BEFORE UPDATE ON automation_rules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_meeting_notes_updated_at ON meeting_notes;
CREATE TRIGGER trg_meeting_notes_updated_at
  BEFORE UPDATE ON meeting_notes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_epic_templates_updated_at ON epic_templates;
CREATE TRIGGER trg_epic_templates_updated_at
  BEFORE UPDATE ON epic_templates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
