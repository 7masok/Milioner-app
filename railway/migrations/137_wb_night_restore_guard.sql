-- Guard WB night schedules from getting permanently stuck on a raised price.
-- 1) A schedule with a remembered base_price must keep trying to restore even if
--    one WB upload/verification attempt returns an error.
-- 2) A new night window must never replace an unfinished restore baseline with
--    the currently raised WB price.

CREATE OR REPLACE FUNCTION guard_wb_night_schedule_restore()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.base_price IS NOT NULL AND OLD.base_price > 0 THEN
    -- A transient/non-gradual WB error must not make restoration terminal.
    IF NEW.phase = 'error' THEN
      NEW.phase := 'restoring';
    END IF;

    -- If the previous night has not restored yet, preserve its original base.
    -- The normal successful-restore path (phase -> idle/off, base_price -> NULL)
    -- is intentionally not touched.
    IF OLD.phase IN ('restoring','error')
       AND NEW.phase = 'raising'
       AND NEW.window_key IS DISTINCT FROM OLD.window_key
       AND NEW.base_price IS NOT NULL
       AND NEW.base_price IS DISTINCT FROM OLD.base_price THEN
      NEW.base_price := OLD.base_price;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_wb_night_schedule_restore_guard ON wb_price_schedules;
CREATE TRIGGER trg_wb_night_schedule_restore_guard
BEFORE UPDATE ON wb_price_schedules
FOR EACH ROW
EXECUTE FUNCTION guard_wb_night_schedule_restore();

-- Recover schedules that were already left terminally errored while they still
-- have a known baseline to restore.
UPDATE wb_price_schedules
SET phase='restoring', updated_at=(extract(epoch from now()) * 1000)::bigint
WHERE base_price IS NOT NULL
  AND base_price > 0
  AND phase='error';
