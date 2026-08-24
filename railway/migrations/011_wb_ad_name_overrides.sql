CREATE TABLE IF NOT EXISTS wb_ad_name_overrides (
  market TEXT NOT NULL,
  campaign_id BIGINT NOT NULL,
  display_name TEXT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (market, campaign_id)
);

-- The WB promotion portal shows this renamed title, while the public API still
-- returns the campaign's older cached title.
INSERT INTO wb_ad_name_overrides(market, campaign_id, display_name, updated_at)
VALUES ('WB2', 38568665, 'Пуля нож', 1787564455087)
ON CONFLICT (market, campaign_id) DO NOTHING;
