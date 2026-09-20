CREATE TABLE IF NOT EXISTS finance_audit (
  id BIGSERIAL PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  before_payload JSONB,
  after_payload JSONB,
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS finance_audit_entity_idx
  ON finance_audit (entity_type, entity_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS finance_audit_created_at_idx
  ON finance_audit (created_at DESC, id DESC);
