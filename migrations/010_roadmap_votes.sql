-- Migration 010: roadmap votes
-- Allows public visitors to upvote roadmap items.
-- visitor_id is a UUID generated client-side and stored in localStorage.

CREATE TABLE IF NOT EXISTS roadmap_votes (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  roadmap_item_id UUID        NOT NULL REFERENCES roadmap_items(id) ON DELETE CASCADE,
  visitor_id      TEXT        NOT NULL CHECK (char_length(visitor_id) BETWEEN 1 AND 128),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (roadmap_item_id, visitor_id)
);

CREATE INDEX IF NOT EXISTS roadmap_votes_item_idx ON roadmap_votes(roadmap_item_id);
