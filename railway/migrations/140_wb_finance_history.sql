-- Persistent resumable finance imports; no warehouse or source rows are changed.
CREATE TABLE IF NOT EXISTS wb_finance_history (
  market TEXT PRIMARY KEY,
  state JSONB NOT NULL
);
