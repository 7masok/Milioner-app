-- Read-only upstream tariff cache, shared by identical credentials across shops.
CREATE TABLE IF NOT EXISTS wb_delivery_tariffs (
  scope text PRIMARY KEY,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  fetched_at bigint NOT NULL DEFAULT 0,
  next_allowed_at bigint NOT NULL DEFAULT 0,
  last_error text NOT NULL DEFAULT ''
);
