-- Read-only integrity gate for the Kaspi advertising import.
DO $kaspi_ads_verify$
DECLARE
  batch_count INTEGER;
  total_amount NUMERIC;
  backup_count INTEGER;
BEGIN
  SELECT COUNT(*), COALESCE(SUM((item->>'amount')::numeric), 0)
    INTO batch_count, total_amount
    FROM warehouse_state,
         LATERAL jsonb_array_elements(
           COALESCE((payload::jsonb)->'kaspiAdExpenses', '[]'::jsonb)
         ) AS ads(item)
    WHERE warehouse_state.id = 1
      AND item->>'fromDate' = '2026-08-10'
      AND item->>'toDate' = '2026-08-16';

  SELECT COUNT(*)
    INTO backup_count
    FROM warehouse_backups
    WHERE label = 'before-kaspi-ads-2026-08-10--2026-08-16';

  IF batch_count <> 4 THEN
    RAISE EXCEPTION 'Kaspi ads verification failed: expected 4 batches, found %', batch_count;
  END IF;
  IF ABS(total_amount - 22521.40) >= 0.01 THEN
    RAISE EXCEPTION 'Kaspi ads verification failed: expected 22521.40, found %', total_amount;
  END IF;
  IF backup_count < 1 THEN
    RAISE EXCEPTION 'Kaspi ads verification failed: backup is missing';
  END IF;
END
$kaspi_ads_verify$;
