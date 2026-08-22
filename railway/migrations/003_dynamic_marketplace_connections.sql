ALTER TABLE marketplace_credentials
  ALTER COLUMN encrypted_token DROP NOT NULL;

ALTER TABLE marketplace_credentials
  ADD COLUMN IF NOT EXISTS enabled SMALLINT NOT NULL DEFAULT 1;

ALTER TABLE marketplace_credentials
  ADD COLUMN IF NOT EXISTS created_at BIGINT;

UPDATE marketplace_credentials
SET created_at = COALESCE(created_at, updated_at);
