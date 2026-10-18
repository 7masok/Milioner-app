-- Reporting-only archive. Never used by stock, reservations or sale reconciliation.
CREATE TABLE IF NOT EXISTS wb_order_history (
 market text NOT NULL CHECK(market IN ('WB','WB2')),
 order_id text NOT NULL,
 creation_date bigint NOT NULL,
 payload jsonb NOT NULL,
 updated_at bigint NOT NULL,
 PRIMARY KEY(market,order_id)
);
CREATE INDEX IF NOT EXISTS wb_order_history_date ON wb_order_history(market,creation_date);
CREATE TABLE IF NOT EXISTS wb_order_history_state (
 market text PRIMARY KEY CHECK(market IN ('WB','WB2')),
 payload jsonb NOT NULL,
 updated_at bigint NOT NULL
);
