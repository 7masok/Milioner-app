CREATE TABLE IF NOT EXISTS purchase_shipment_numbers (
  shipment_key text PRIMARY KEY,
  shipment_number bigint NOT NULL UNIQUE CHECK (shipment_number >= 101)
);
