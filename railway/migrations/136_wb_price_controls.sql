CREATE TABLE IF NOT EXISTS wb_price_protection (
  market TEXT NOT NULL,
  nm_id BIGINT NOT NULL,
  manual_price_lock BOOLEAN NOT NULL DEFAULT FALSE,
  auto_zero_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  auto_zero_lock BOOLEAN NOT NULL DEFAULT FALSE,
  promo_block BOOLEAN NOT NULL DEFAULT FALSE,
  locked_price DOUBLE PRECISION,
  locked_discount INTEGER,
  own_stock_known BOOLEAN NOT NULL DEFAULT FALSE,
  own_available INTEGER,
  stock_checked_at BIGINT NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (market,nm_id),
  CHECK (market IN ('WB','WB2')),
  CHECK (nm_id > 0),
  CHECK (locked_price IS NULL OR locked_price > 0),
  CHECK (locked_discount IS NULL OR (locked_discount >= 0 AND locked_discount <= 99)),
  CHECK (own_available IS NULL OR own_available >= 0)
);

CREATE INDEX IF NOT EXISTS wb_price_protection_auto_idx
  ON wb_price_protection(market,auto_zero_enabled,nm_id);

CREATE TABLE IF NOT EXISTS wb_card_group_snapshots (
  market TEXT PRIMARY KEY,
  payload JSONB NOT NULL DEFAULT '{"cards":[]}'::jsonb,
  fetched_at BIGINT NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  updated_at BIGINT NOT NULL DEFAULT 0,
  CHECK (market IN ('WB','WB2'))
);

CREATE TABLE IF NOT EXISTS wb_control_history (
  id BIGSERIAL PRIMARY KEY,
  market TEXT NOT NULL,
  nm_id BIGINT,
  action TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'owner',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at BIGINT NOT NULL DEFAULT 0,
  CHECK (market IN ('WB','WB2'))
);

CREATE INDEX IF NOT EXISTS wb_control_history_market_created_idx
  ON wb_control_history(market,created_at DESC);

ALTER TABLE wb_price_update_queue
  DROP CONSTRAINT IF EXISTS wb_price_update_queue_source_check;

ALTER TABLE wb_price_update_queue
  ADD CONSTRAINT wb_price_update_queue_source_check
  CHECK (source IN ('manual','promo','schedule','protection'));
