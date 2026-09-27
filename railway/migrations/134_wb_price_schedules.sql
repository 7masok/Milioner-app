CREATE TABLE IF NOT EXISTS wb_price_schedules (
  market TEXT NOT NULL,
  nm_id BIGINT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  start_minute INTEGER NOT NULL DEFAULT 240,
  end_minute INTEGER NOT NULL DEFAULT 360,
  target_price DOUBLE PRECISION NOT NULL DEFAULT 5000,
  base_price DOUBLE PRECISION,
  window_key TEXT NOT NULL DEFAULT '',
  manual_override_window TEXT NOT NULL DEFAULT '',
  phase TEXT NOT NULL DEFAULT 'off',
  last_error TEXT NOT NULL DEFAULT '',
  updated_at BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (market,nm_id),
  CHECK (market IN ('WB','WB2')),
  CHECK (nm_id > 0),
  CHECK (start_minute >= 0 AND start_minute < 1440),
  CHECK (end_minute >= 0 AND end_minute < 1440),
  CHECK (start_minute <> end_minute),
  CHECK (target_price > 0),
  CHECK (base_price IS NULL OR base_price > 0)
);

CREATE INDEX IF NOT EXISTS wb_price_schedules_enabled_idx
  ON wb_price_schedules(market,enabled,nm_id);

ALTER TABLE wb_price_update_queue
  DROP CONSTRAINT IF EXISTS wb_price_update_queue_source_check;

ALTER TABLE wb_price_update_queue
  ADD CONSTRAINT wb_price_update_queue_source_check
  CHECK (source IN ('manual','promo','schedule'));

ALTER TABLE wb_price_update_queue
  DROP CONSTRAINT IF EXISTS wb_price_update_queue_status_check;

ALTER TABLE wb_price_update_queue
  ADD CONSTRAINT wb_price_update_queue_status_check
  CHECK (status IN ('pending','sent','held'));
