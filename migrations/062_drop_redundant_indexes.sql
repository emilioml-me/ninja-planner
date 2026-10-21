-- 062: drop plain indexes that duplicate a UNIQUE constraint's index (review L76).
-- Each UNIQUE column already has an implicit btree index whose leading column is the same, so
-- these only cost write amplification and disk. Every drop is guarded: it only happens when a
-- valid, non-partial unique index on the same table still leads with that column; otherwise a
-- NOTICE is raised and the index is kept.
--   share_tokens.token            (003: UNIQUE + idx_share_tokens_token)
--   goal_links.goal_id            (003: UNIQUE (goal_id, entity_type, entity_id) + idx_goal_links_goal)
--   workspace_invites.token       (007: UNIQUE + workspace_invites_token_idx)
--   project_shares.token          (030: UNIQUE + project_shares_token_idx)
--   api_keys.key_hash             (031: UNIQUE + api_keys_hash_idx)
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('share_tokens',      'idx_share_tokens_token',      'token'),
      ('goal_links',        'idx_goal_links_goal',         'goal_id'),
      ('workspace_invites', 'workspace_invites_token_idx', 'token'),
      ('project_shares',    'project_shares_token_idx',    'token'),
      ('api_keys',          'api_keys_hash_idx',           'key_hash')
    ) AS v(tbl, idx, col)
  LOOP
    IF to_regclass(r.idx) IS NULL THEN
      CONTINUE;
    END IF;
    IF EXISTS (
      SELECT 1
      FROM pg_index i
      JOIN pg_class ic    ON ic.oid = i.indexrelid
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
      WHERE i.indrelid = to_regclass(r.tbl)
        AND i.indisunique
        AND i.indisvalid
        AND i.indpred IS NULL
        AND ic.relname <> r.idx
        AND a.attname = r.col
    ) THEN
      EXECUTE format('DROP INDEX IF EXISTS %I', r.idx);
    ELSE
      RAISE NOTICE 'keeping %: no unique index on %.% found', r.idx, r.tbl, r.col;
    END IF;
  END LOOP;
END $$;
