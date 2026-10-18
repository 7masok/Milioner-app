-- Existing schedules retain their daily behavior. The local start date owns an overnight window.
ALTER TABLE wb_price_schedules ADD COLUMN IF NOT EXISTS weekdays INTEGER[] NOT NULL DEFAULT ARRAY[1,2,3,4,5,6,7];
ALTER TABLE wb_price_schedules ADD CONSTRAINT wb_price_schedules_weekdays_check
  CHECK (cardinality(weekdays) BETWEEN 1 AND 7 AND weekdays <@ ARRAY[1,2,3,4,5,6,7] AND array_position(weekdays,NULL) IS NULL);
