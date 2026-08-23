CREATE TABLE IF NOT EXISTS wb_ad_limits (
  market TEXT NOT NULL,
  campaign_id BIGINT NOT NULL,
  daily_limit NUMERIC NOT NULL DEFAULT 0,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at BIGINT NOT NULL,
  last_checked_at BIGINT NOT NULL DEFAULT 0,
  last_action_at BIGINT NOT NULL DEFAULT 0,
  last_action_error TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (market, campaign_id)
);
