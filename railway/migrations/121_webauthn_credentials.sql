CREATE TABLE IF NOT EXISTS webauthn_credentials (
  credential_id TEXT PRIMARY KEY,
  public_key TEXT NOT NULL,
  counter BIGINT NOT NULL DEFAULT 0,
  transports TEXT,
  device_name TEXT,
  created_at BIGINT NOT NULL,
  last_used_at BIGINT
);

CREATE INDEX IF NOT EXISTS webauthn_credentials_last_used_idx
  ON webauthn_credentials (last_used_at DESC);
