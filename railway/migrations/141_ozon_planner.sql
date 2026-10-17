-- Separate read-only planning snapshots; no warehouse stock/FIFO changes.
CREATE TABLE IF NOT EXISTS ozon_planner_sources (
 account TEXT PRIMARY KEY, client_id TEXT NOT NULL, payload JSONB,
 updated_at BIGINT NOT NULL DEFAULT 0, next_allowed_at BIGINT NOT NULL DEFAULT 0,
 attempt_at BIGINT NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS ozon_planner_bundles (
 account TEXT NOT NULL, client_id TEXT NOT NULL, supply_id TEXT NOT NULL,
 payload JSONB NOT NULL, PRIMARY KEY(account,client_id,supply_id)
);
CREATE TABLE IF NOT EXISTS ozon_planner_devices (
 id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, account TEXT NOT NULL,
 client_id TEXT NOT NULL, configuration JSONB NOT NULL, config_hash TEXT NOT NULL,
 prepared JSONB, source_updated_at BIGINT NOT NULL DEFAULT 0,
 calculated_day TEXT NOT NULL DEFAULT '', revision BIGINT NOT NULL DEFAULT 0,
 created_at BIGINT NOT NULL, last_used_at BIGINT NOT NULL, revoked BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS ozon_planner_devices_account ON ozon_planner_devices(account) WHERE NOT revoked;
