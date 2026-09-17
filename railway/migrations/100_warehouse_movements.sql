CREATE TABLE IF NOT EXISTS warehouse_movements (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL DEFAULT '',
  movement_date BIGINT NOT NULL DEFAULT 0,
  movement_type TEXT NOT NULL DEFAULT '',
  qty DOUBLE PRECISION NOT NULL DEFAULT 0,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at BIGINT NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS warehouse_movements_date_idx
  ON warehouse_movements (movement_date DESC, id);
CREATE INDEX IF NOT EXISTS warehouse_movements_product_date_idx
  ON warehouse_movements (product_id, movement_date DESC, id);
CREATE INDEX IF NOT EXISTS warehouse_movements_type_date_idx
  ON warehouse_movements (movement_type, movement_date DESC, id);

-- Backfill every movement currently embedded in the legacy warehouse snapshot.
-- Do not remove it from the snapshot here: application code performs the
-- cutover transactionally after it has verified and mirrored the rows.
INSERT INTO warehouse_movements(id,product_id,movement_date,movement_type,qty,payload,created_at,updated_at)
SELECT
  movement->>'id',
  COALESCE(movement->>'productId',''),
  CASE WHEN COALESCE(movement->>'date','') ~ '^[0-9]+$' THEN (movement->>'date')::bigint ELSE 0 END,
  COALESCE(movement->>'type',''),
  CASE WHEN COALESCE(movement->>'qty','') ~ '^-?[0-9]+([.][0-9]+)?$' THEN (movement->>'qty')::double precision ELSE 0 END,
  movement,
  CASE WHEN COALESCE(movement->>'date','') ~ '^[0-9]+$' THEN (movement->>'date')::bigint ELSE 0 END,
  (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint
FROM warehouse_state ws
CROSS JOIN LATERAL jsonb_array_elements(COALESCE((ws.payload::jsonb)->'movements','[]'::jsonb)) AS movement
WHERE ws.id=1 AND COALESCE(movement->>'id','')<>''
ON CONFLICT(id) DO UPDATE SET
  product_id=excluded.product_id,
  movement_date=excluded.movement_date,
  movement_type=excluded.movement_type,
  qty=excluded.qty,
  payload=excluded.payload,
  updated_at=excluded.updated_at;
