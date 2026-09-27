CREATE TABLE IF NOT EXISTS wb_price_snapshots (
  market TEXT PRIMARY KEY,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  fetched_at BIGINT NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL DEFAULT 0,
  CHECK (market IN ('WB','WB2'))
);

CREATE TABLE IF NOT EXISTS wb_price_sync_state (
  market TEXT PRIMARY KEY,
  next_allowed_at BIGINT NOT NULL DEFAULT 0,
  last_attempt_at BIGINT NOT NULL DEFAULT 0,
  last_success_at BIGINT NOT NULL DEFAULT 0,
  last_action TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  read_offset INTEGER NOT NULL DEFAULT 0,
  read_buffer JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at BIGINT NOT NULL DEFAULT 0,
  CHECK (market IN ('WB','WB2')),
  CHECK (read_offset >= 0)
);

CREATE TABLE IF NOT EXISTS wb_price_update_queue (
  market TEXT NOT NULL,
  nm_id BIGINT NOT NULL,
  desired_price DOUBLE PRECISION,
  desired_discount INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  queued_at BIGINT NOT NULL DEFAULT 0,
  sent_at BIGINT NOT NULL DEFAULT 0,
  upload_id BIGINT NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  updated_at BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (market,nm_id),
  CHECK (market IN ('WB','WB2')),
  CHECK (nm_id > 0),
  CHECK (desired_price IS NULL OR desired_price > 0),
  CHECK (desired_discount IS NULL OR (desired_discount >= 0 AND desired_discount <= 99)),
  CHECK (status IN ('pending','sent')),
  CHECK (desired_price IS NOT NULL OR desired_discount IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS wb_price_update_queue_market_status_idx
  ON wb_price_update_queue(market,status,queued_at);
