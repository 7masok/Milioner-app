ALTER TABLE wb_ad_limits
  ADD COLUMN IF NOT EXISTS auto_paused BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS auto_paused_day TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS last_action_type TEXT NOT NULL DEFAULT '';

-- Before this migration only the automatic limiter wrote last_action_at.
-- Preserve those pauses so campaigns stopped yesterday can resume immediately
-- after the first deploy of the new worker.
UPDATE wb_ad_limits
SET auto_paused = TRUE,
    auto_paused_day = to_char(
      to_timestamp(last_action_at / 1000.0) AT TIME ZONE 'Asia/Qyzylorda',
      'YYYY-MM-DD'
    ),
    last_action_type = 'auto_pause'
WHERE enabled = TRUE
  AND daily_limit > 0
  AND last_action_at > 0
  AND auto_paused = FALSE;
