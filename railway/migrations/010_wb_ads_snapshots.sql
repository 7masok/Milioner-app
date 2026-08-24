CREATE TABLE IF NOT EXISTS wb_ads_snapshots (
  market TEXT PRIMARY KEY,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at BIGINT NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  next_attempt_at BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_wb_ads_snapshots_next_attempt
  ON wb_ads_snapshots(next_attempt_at);
