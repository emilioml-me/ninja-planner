-- 058: replaces the 057 code-uniqueness index (review M10).
-- 057 had two problems:
--  * on duplicate codes its DO block only RAISE NOTICE'd, so the file was recorded as applied
--    with no index at all;
--  * its filter `admin_override = FALSE` excluded rows whose real code sits underneath an admin
--    override (ninjaStack.ts keeps the real code when overriding an activated workspace), so a
--    second workspace could activate the same code and revoking the override then hit 23505.
-- The only placeholder value is the literal code 'admin-override' (written by the override
-- route for workspaces that never had a real code), so that is the only thing excluded now.
-- Duplicates fail the migration loudly (nothing is recorded) instead of being skipped.

DROP INDEX IF EXISTS uq_ninja_stack_subscriptions_code;

-- Codes are bearer secrets, so the error reports affected workspace ids, never the codes.
DO $$
DECLARE
  dup TEXT;
BEGIN
  SELECT string_agg(s.workspace_id::text, ', ')
  INTO dup
  FROM ninja_stack_subscriptions s
  JOIN (
    SELECT upper(trim(code)) AS code_key
    FROM ninja_stack_subscriptions
    WHERE code IS NOT NULL AND code <> 'admin-override'
    GROUP BY upper(trim(code))
    HAVING COUNT(*) > 1
  ) d ON upper(trim(s.code)) = d.code_key;

  IF dup IS NOT NULL THEN
    RAISE EXCEPTION 'ninja_stack_subscriptions: workspaces % share a subscription code; resolve before re-running this migration', dup;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_ninja_stack_subscriptions_code
  ON ninja_stack_subscriptions (upper(trim(code)))
  WHERE code <> 'admin-override';
