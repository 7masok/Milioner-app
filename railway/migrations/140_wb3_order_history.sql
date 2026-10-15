CREATE TABLE IF NOT EXISTS wb3_order_history (
 srid TEXT PRIMARY KEY, creation_date BIGINT NOT NULL, payload JSONB NOT NULL, updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS wb3_order_history_date ON wb3_order_history(creation_date DESC);
CREATE TABLE IF NOT EXISTS wb3_order_history_sync (
 source TEXT PRIMARY KEY, cursor JSONB NOT NULL DEFAULT '{}'::jsonb,
 last_success_at BIGINT NOT NULL DEFAULT 0, next_allowed_at BIGINT NOT NULL DEFAULT 0,
 last_error TEXT NOT NULL DEFAULT '', updated_at BIGINT NOT NULL
);
