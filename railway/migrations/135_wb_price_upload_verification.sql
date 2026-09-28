ALTER TABLE wb_price_update_queue
  DROP CONSTRAINT IF EXISTS wb_price_update_queue_status_check;

ALTER TABLE wb_price_update_queue
  ADD CONSTRAINT wb_price_update_queue_status_check
  CHECK (status IN ('pending','sent','checking','held'));
