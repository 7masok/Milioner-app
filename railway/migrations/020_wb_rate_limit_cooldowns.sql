-- Persist Wildberries rate-limit cooldowns so restarts and manual refreshes
-- cannot immediately retry endpoints after HTTP 429.
ALTER TABLE wb_finance_sync_runs
  ADD COLUMN IF NOT EXISTS retry_at BIGINT NOT NULL DEFAULT 0;

ALTER TABLE wb_sales_live_state
  ADD COLUMN IF NOT EXISTS next_allowed_at BIGINT NOT NULL DEFAULT 0;
