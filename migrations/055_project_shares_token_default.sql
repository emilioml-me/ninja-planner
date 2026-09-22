-- 030_project_shares.sql originally defaulted project_shares.token to
-- encode(gen_random_bytes(24), 'base64url'): gen_random_bytes() needs pgcrypto (never installed)
-- and the 'base64url' encoding only exists in Postgres 18+. 030 has been corrected for fresh
-- databases; this migration fixes databases that already recorded 030 as applied.
-- base64 of 24 bytes is 32 chars (no line wrapping, no padding), made URL-safe by hand.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE project_shares
  ALTER COLUMN token SET DEFAULT rtrim(translate(encode(gen_random_bytes(24), 'base64'), '+/', '-_'), '=');
