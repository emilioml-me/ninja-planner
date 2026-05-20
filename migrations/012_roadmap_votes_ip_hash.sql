-- Migration 012: Add ip_hash to roadmap_votes for IP-based vote dedup
-- SHA-256 hash of the requester's IP (never stored in plain text).
-- Partial unique index prevents duplicate votes from the same IP per item
-- while allowing NULL (legacy rows or proxied IPs where IP cannot be determined).

ALTER TABLE roadmap_votes
  ADD COLUMN IF NOT EXISTS ip_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS roadmap_votes_item_ip_uidx
  ON roadmap_votes (roadmap_item_id, ip_hash)
  WHERE ip_hash IS NOT NULL;
