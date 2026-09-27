CREATE TABLE IF NOT EXISTS wb_promo_preferences (
  market TEXT NOT NULL,
  nm_id BIGINT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  base_discount INTEGER,
  promotion_id BIGINT NOT NULL DEFAULT 0,
  promotion_name TEXT NOT NULL DEFAULT '',
  plan_price DOUBLE PRECISION,
  plan_discount INTEGER,
  status TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  updated_at BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (market,nm_id),
  CHECK (market IN ('WB','WB2')),
  CHECK (nm_id > 0),
  CHECK (base_discount IS NULL OR (base_discount >= 0 AND base_discount <= 99)),
  CHECK (plan_discount IS NULL OR (plan_discount >= 0 AND plan_discount <= 99))
);

CREATE TABLE IF NOT EXISTS wb_promo_sync_state (
  market TEXT PRIMARY KEY,
  next_sync_at BIGINT NOT NULL DEFAULT 0,
  last_sync_at BIGINT NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  updated_at BIGINT NOT NULL DEFAULT 0,
  CHECK (market IN ('WB','WB2'))
);

ALTER TABLE wb_price_update_queue
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual';

ALTER TABLE wb_price_update_queue
  ADD COLUMN IF NOT EXISTS promotion_id BIGINT NOT NULL DEFAULT 0;

ALTER TABLE wb_price_update_queue
  DROP CONSTRAINT IF EXISTS wb_price_update_queue_source_check;

ALTER TABLE wb_price_update_queue
  ADD CONSTRAINT wb_price_update_queue_source_check CHECK (source IN ('manual','promo'));

CREATE INDEX IF NOT EXISTS wb_promo_preferences_enabled_idx
  ON wb_promo_preferences(market,enabled,nm_id);
