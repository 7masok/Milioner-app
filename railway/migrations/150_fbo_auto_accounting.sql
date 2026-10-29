CREATE TABLE IF NOT EXISTS fbo_auto_accounting (
 account TEXT PRIMARY KEY,
 client_id TEXT NOT NULL,
 enabled BOOLEAN NOT NULL DEFAULT FALSE,
 enabled_at BIGINT NOT NULL DEFAULT 0,
 excluded_orders TEXT[] NOT NULL DEFAULT '{}',
 checked_at BIGINT NOT NULL DEFAULT 0,
 last_results JSONB NOT NULL DEFAULT '[]'
);
