-- Names verified by campaign ID in the WB1 promotion portal on 2026-09-13.
-- Public API still returns the older generic titles for these campaigns.
INSERT INTO wb_ad_name_overrides(market, campaign_id, display_name, updated_at)
VALUES
  ('WB', 38498119, 'тетрис 1', (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint),
  ('WB', 38498135, 'Крылья', (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint),
  ('WB', 38498148, 'Складной нож', (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint),
  ('WB', 38498149, 'Пуля нож', (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint)
ON CONFLICT (market, campaign_id) DO UPDATE
SET display_name = EXCLUDED.display_name, updated_at = EXCLUDED.updated_at;
