-- Reporting-only cache. Never feed these orders into warehouse reconciliation.
CREATE TABLE IF NOT EXISTS kaspi_order_history (
 order_id text PRIMARY KEY,
 creation_date bigint NOT NULL,
 completion_date bigint NOT NULL DEFAULT 0,
 payload jsonb NOT NULL,
 updated_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS kaspi_order_history_date ON kaspi_order_history(creation_date);
CREATE INDEX IF NOT EXISTS kaspi_order_history_completed ON kaspi_order_history(completion_date);
CREATE TABLE IF NOT EXISTS kaspi_order_history_state (
 id integer PRIMARY KEY CHECK(id=1),
 payload jsonb NOT NULL,
 updated_at bigint NOT NULL
);
