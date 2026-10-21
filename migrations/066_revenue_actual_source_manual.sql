-- 066: revenue_targets fixes backing review M5/L23 (K26).
-- Runs inside the migration runner's own transaction (no BEGIN/COMMIT here).

-- ─── actual_source: allow 'manual' ──────────────────────────────────────────────
-- 054 added an inline CHECK allowing only 'crm'/'payments' (auto-named, normally
-- revenue_targets_actual_source_check). A manual PATCH of actual_amount now records
-- actual_source = 'manual' so a later sync doesn't overwrite it. The old constraint is looked
-- up in pg_constraint rather than assumed by name; re-runnable.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'revenue_targets'::regclass
      AND contype = 'c'
      AND conname <> 'revenue_targets_actual_source_valid'
      AND pg_get_constraintdef(oid) LIKE '%actual_source%'
  LOOP
    EXECUTE format('ALTER TABLE revenue_targets DROP CONSTRAINT %I', r.conname);
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'revenue_targets'::regclass AND conname = 'revenue_targets_actual_source_valid'
  ) THEN
    ALTER TABLE revenue_targets
      ADD CONSTRAINT revenue_targets_actual_source_valid
      CHECK (actual_source IS NULL OR actual_source IN ('crm', 'payments', 'manual'));
  END IF;
END $$;

-- ─── period_start: normalize to the start of its period ─────────────────────────
-- The API used to store whatever date was sent, so a "monthly" row could start on the 15th and
-- never line up with the sync's first-of-month rows (duplicates per month, sync updates the
-- wrong row). The server now normalizes on write; this fixes existing rows.
-- Rows whose normalized key would collide with another row on uq_revenue_targets_period
-- (workspace_id, period_type, period_start) are NOT merged automatically - picking which
-- target/actual figures win is a financial judgement call - they are left untouched and
-- counted in a NOTICE so an admin can reconcile them on the Revenue page.
DO $$
DECLARE
  updated_count INTEGER;
  skipped_count INTEGER;
BEGIN
  WITH normalized AS (
    SELECT id,
           workspace_id,
           period_type,
           period_start,
           CASE period_type
             WHEN 'monthly'   THEN date_trunc('month',   period_start)::date
             WHEN 'quarterly' THEN date_trunc('quarter', period_start)::date
             WHEN 'yearly'    THEN date_trunc('year',    period_start)::date
             ELSE period_start
           END AS norm_start
    FROM revenue_targets
  ), ranked AS (
    SELECT n.*,
           COUNT(*) OVER (PARTITION BY workspace_id, period_type, norm_start) AS group_size
    FROM normalized n
  )
  UPDATE revenue_targets t
  SET period_start = r.norm_start
  FROM ranked r
  WHERE t.id = r.id
    AND r.period_start <> r.norm_start
    AND r.group_size = 1;
  GET DIAGNOSTICS updated_count = ROW_COUNT;

  SELECT COUNT(*) INTO skipped_count
  FROM revenue_targets
  WHERE (period_type = 'monthly'   AND period_start <> date_trunc('month',   period_start)::date)
     OR (period_type = 'quarterly' AND period_start <> date_trunc('quarter', period_start)::date)
     OR (period_type = 'yearly'    AND period_start <> date_trunc('year',    period_start)::date);

  RAISE NOTICE 'revenue_targets: normalized % row(s); % misaligned row(s) left as-is because they collide with another row for the same period', updated_count, skipped_count;
END $$;
