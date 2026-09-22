-- Bind a ninja-stack subscription code to a single workspace (closes the race in the
-- application-level "code already in use" check in subscriptionService.activateSubscription).
-- Admin-override rows all share the placeholder code 'admin-override', so they are excluded.
-- If live data already has a code shared by several workspaces, the index is skipped with a
-- NOTICE instead of failing the deploy; resolve the duplicates manually and re-create it.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM ninja_stack_subscriptions
    WHERE admin_override = FALSE
    GROUP BY upper(trim(code))
    HAVING COUNT(*) > 1
  ) THEN
    RAISE NOTICE 'ninja_stack_subscriptions has duplicate codes; skipping uq_ninja_stack_subscriptions_code';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS uq_ninja_stack_subscriptions_code
      ON ninja_stack_subscriptions (upper(trim(code)))
      WHERE admin_override = FALSE;
  END IF;
END $$;
