CREATE TABLE IF NOT EXISTS warehouse_sales (
  id TEXT PRIMARY KEY,
  external_key TEXT NOT NULL DEFAULT '',
  product_id TEXT NOT NULL DEFAULT '',
  channel TEXT NOT NULL DEFAULT '',
  qty DOUBLE PRECISION NOT NULL DEFAULT 0,
  sale_date BIGINT NOT NULL DEFAULT 0,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at BIGINT NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS warehouse_sales_external_key_idx
  ON warehouse_sales (external_key)
  WHERE external_key <> '';
CREATE INDEX IF NOT EXISTS warehouse_sales_product_idx
  ON warehouse_sales (product_id, sale_date DESC, id);
CREATE INDEX IF NOT EXISTS warehouse_sales_date_idx
  ON warehouse_sales (sale_date DESC, id);

-- Copy sales out of the warehouse document. The application stops writing them
-- back into that document once this table can be read.
INSERT INTO warehouse_sales(id,external_key,product_id,channel,qty,sale_date,payload,created_at,updated_at)
SELECT DISTINCT ON (id)
  id, external_key, product_id, channel, qty, sale_date, payload, created_at, updated_at
FROM (
  SELECT DISTINCT ON (sale_key)
    COALESCE(NULLIF(sale->>'id',''), NULLIF(sale->>'externalKey','')) AS id,
    COALESCE(sale->>'externalKey','') AS external_key,
    COALESCE(sale->>'productId','') AS product_id,
    COALESCE(NULLIF(sale->>'channel',''), NULLIF(sale->>'market',''), '') AS channel,
    CASE WHEN COALESCE(sale->>'qty','') ~ '^-?[0-9]+([.][0-9]+)?$' THEN (sale->>'qty')::double precision ELSE 0 END AS qty,
    CASE WHEN COALESCE(sale->>'date','') ~ '^-?[0-9]+$' THEN (sale->>'date')::bigint ELSE 0 END AS sale_date,
    CASE
      WHEN COALESCE(sale->>'id','') <> '' THEN sale
      ELSE jsonb_set(sale, '{id}', to_jsonb(sale->>'externalKey'))
    END AS payload,
    CASE WHEN COALESCE(sale->>'date','') ~ '^-?[0-9]+$' THEN (sale->>'date')::bigint ELSE 0 END AS created_at,
    (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS updated_at,
    CASE
      WHEN COALESCE(sale->>'externalKey','') <> '' THEN sale->>'externalKey'
      ELSE COALESCE(NULLIF(sale->>'id',''), sale->>'externalKey')
    END AS sale_key
  FROM warehouse_state ws
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE((ws.payload::jsonb)->'sales','[]'::jsonb)) AS sale
  WHERE ws.id=1 AND COALESCE(NULLIF(sale->>'id',''), NULLIF(sale->>'externalKey','')) IS NOT NULL
  ORDER BY sale_key, CASE WHEN COALESCE(sale->>'date','') ~ '^-?[0-9]+$' THEN (sale->>'date')::bigint ELSE 0 END DESC
) keyed
ORDER BY id
ON CONFLICT(id) DO UPDATE SET
  external_key=excluded.external_key,
  product_id=excluded.product_id,
  channel=excluded.channel,
  qty=excluded.qty,
  sale_date=excluded.sale_date,
  payload=excluded.payload,
  updated_at=excluded.updated_at;
