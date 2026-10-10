-- Warehouse-only labels survive WB snapshot refreshes. No marketplace mutations.
CREATE TABLE IF NOT EXISTS wb_card_group_names (
  market text NOT NULL CHECK (market IN ('WB','WB2')),
  imt_id text NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  updated_at bigint NOT NULL,
  PRIMARY KEY (market, imt_id)
);
