CREATE TABLE IF NOT EXISTS marketplace_credentials (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  label TEXT NOT NULL,
  encrypted_token TEXT NOT NULL,
  updated_at BIGINT NOT NULL,
  last_tested_at BIGINT,
  last_test_ok SMALLINT NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS marketplace_credentials_provider_idx
  ON marketplace_credentials(provider);
