CREATE TABLE IF NOT EXISTS wb_order_stickers (
  market TEXT NOT NULL,
  order_id TEXT NOT NULL,
  barcode TEXT NOT NULL DEFAULT '',
  part_a TEXT NOT NULL DEFAULT '',
  part_b TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (market, order_id)
);

CREATE INDEX IF NOT EXISTS wb_order_stickers_barcode_idx
  ON wb_order_stickers (market, barcode)
  WHERE barcode <> '';

CREATE INDEX IF NOT EXISTS wb_order_stickers_parts_idx
  ON wb_order_stickers (market, part_a, part_b)
  WHERE part_a <> '' OR part_b <> '';
