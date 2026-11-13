CREATE TABLE IF NOT EXISTS kaspi_purchase_settlements (
  operation_key TEXT PRIMARY KEY,
  payload JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kaspi_purchase_settlements_order
  ON kaspi_purchase_settlements ((payload->>'orderId'));
