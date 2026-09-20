CREATE TABLE IF NOT EXISTS finance_backups (
  id BIGSERIAL PRIMARY KEY,
  label TEXT NOT NULL DEFAULT 'manual',
  accounts JSONB NOT NULL DEFAULT '[]'::jsonb,
  categories JSONB NOT NULL DEFAULT '[]'::jsonb,
  transactions JSONB NOT NULL DEFAULT '[]'::jsonb,
  imports JSONB NOT NULL DEFAULT '{}'::jsonb,
  revision BIGINT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS finance_backups_created_at_idx
  ON finance_backups (created_at DESC);
