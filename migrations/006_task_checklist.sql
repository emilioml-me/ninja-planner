-- Migration 006: checklist column on tasks
-- Stores an ordered list of checklist items as JSONB: [{id, text, done}]

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS checklist JSONB NOT NULL DEFAULT '[]'::jsonb;
