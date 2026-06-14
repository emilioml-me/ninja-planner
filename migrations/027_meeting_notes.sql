-- Meeting notes: attach notes to sprints or epics
CREATE TABLE IF NOT EXISTS meeting_notes (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sprint_id    UUID        REFERENCES sprints(id) ON DELETE SET NULL,
  epic_id      UUID        REFERENCES epics(id) ON DELETE SET NULL,
  title        TEXT        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 255),
  content      TEXT        NOT NULL DEFAULT '',
  created_by   TEXT        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS meeting_notes_workspace_idx ON meeting_notes(workspace_id);
CREATE INDEX IF NOT EXISTS meeting_notes_sprint_idx    ON meeting_notes(sprint_id) WHERE sprint_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS meeting_notes_epic_idx      ON meeting_notes(epic_id)   WHERE epic_id IS NOT NULL;
