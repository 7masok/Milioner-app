CREATE TABLE IF NOT EXISTS warehouse_purchases (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  qty DOUBLE PRECISION NOT NULL DEFAULT 0,
  purchase_date BIGINT NOT NULL DEFAULT 0,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at BIGINT NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS warehouse_purchases_product_idx
  ON warehouse_purchases (product_id, purchase_date DESC, id);
CREATE INDEX IF NOT EXISTS warehouse_purchases_status_idx
  ON warehouse_purchases (status, purchase_date DESC, id);

-- Copy purchases out of the warehouse document. Leave the document untouched
-- here; the application removes the embedded copy after the table is readable.
INSERT INTO warehouse_purchases(id,product_id,status,qty,purchase_date,payload,created_at,updated_at)
SELECT
  purchase->>'id',
  COALESCE(purchase->>'productId',''),
  COALESCE(purchase->>'status',''),
  CASE WHEN COALESCE(purchase->>'qty','') ~ '^-?[0-9]+([.][0-9]+)?$' THEN (purchase->>'qty')::double precision ELSE 0 END,
  CASE
    WHEN COALESCE(purchase->>'date','') ~ '^-?[0-9]+$' THEN (purchase->>'date')::bigint
    WHEN COALESCE(purchase->>'orderedAt','') ~ '^-?[0-9]+$' THEN (purchase->>'orderedAt')::bigint
    WHEN COALESCE(purchase->>'createdAt','') ~ '^-?[0-9]+$' THEN (purchase->>'createdAt')::bigint
    ELSE 0
  END,
  purchase,
  CASE WHEN COALESCE(purchase->>'createdAt','') ~ '^-?[0-9]+$' THEN (purchase->>'createdAt')::bigint ELSE 0 END,
  (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint
FROM warehouse_state ws
CROSS JOIN LATERAL jsonb_array_elements(COALESCE((ws.payload::jsonb)->'purchases','[]'::jsonb)) AS purchase
WHERE ws.id=1 AND COALESCE(purchase->>'id','')<>''
ON CONFLICT(id) DO UPDATE SET
  product_id=excluded.product_id,
  status=excluded.status,
  qty=excluded.qty,
  purchase_date=excluded.purchase_date,
  payload=excluded.payload,
  updated_at=excluded.updated_at;
