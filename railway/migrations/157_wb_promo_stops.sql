CREATE TABLE IF NOT EXISTS wb_promo_stops (
  market TEXT NOT NULL CHECK (market IN ('WB','WB2')),
  nm_id BIGINT NOT NULL CHECK (nm_id > 0),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  mode TEXT NOT NULL DEFAULT 'price' CHECK (mode IN ('price','percent')),
  value DOUBLE PRECISION NOT NULL CHECK (value >= 0),
  base_price DOUBLE PRECISION NOT NULL CHECK (base_price > 0),
  min_price DOUBLE PRECISION NOT NULL CHECK (min_price > 0 AND min_price <= base_price),
  triggered_at BIGINT NOT NULL DEFAULT 0,
  restoring BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (market,nm_id),
  CHECK (mode <> 'percent' OR value < 100)
);
