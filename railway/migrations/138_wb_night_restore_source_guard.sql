-- Source-level night restore is the primary guard. This trigger is a second line
-- of defence so an unfinished baseline can never be overwritten by a later window.
CREATE OR REPLACE FUNCTION guard_wb_night_schedule_restore()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.base_price IS NOT NULL AND OLD.base_price > 0 THEN
    IF NEW.phase = 'error' THEN
      NEW.phase := 'restoring';
    END IF;

    IF NEW.phase = 'raising'
       AND NEW.window_key IS DISTINCT FROM OLD.window_key
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

-- Anything that still has a remembered baseline must keep restoring rather than
-- remaining terminally errored. The scheduler decides whether the current minute
-- is inside a valid night window before sending any new raise.
UPDATE wb_price_schedules
SET phase='restoring', updated_at=(extract(epoch from now()) * 1000)::bigint
WHERE base_price IS NOT NULL
  AND base_price > 0
  AND phase='error';
