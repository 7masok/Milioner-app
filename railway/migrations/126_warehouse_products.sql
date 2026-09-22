CREATE TABLE IF NOT EXISTS warehouse_products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  stock DOUBLE PRECISION NOT NULL DEFAULT 0,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at BIGINT NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS warehouse_products_name_idx
  ON warehouse_products (name, id);

-- Copy the catalog out of the warehouse document. Stock feeds and the phone
-- read this table after the migration; the document copy is removed on the next save.
INSERT INTO warehouse_products(id,name,stock,payload,created_at,updated_at)
SELECT DISTINCT ON (id)
  id,
  name,
  stock,
  payload,
  created_at,
  updated_at
FROM (
  SELECT
    item->>'id' AS id,
    COALESCE(item->>'name','') AS name,
    CASE WHEN COALESCE(item->>'stock','') ~ '^-?[0-9]+([.][0-9]+)?$' THEN (item->>'stock')::double precision ELSE 0 END AS stock,
    item AS payload,
    CASE WHEN COALESCE(item->>'createdAt','') ~ '^-?[0-9]+$' THEN (item->>'createdAt')::bigint ELSE 0 END AS created_at,
    (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS updated_at
  FROM warehouse_state ws
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE((ws.payload::jsonb)->'products','[]'::jsonb)) AS item
  WHERE ws.id=1 AND COALESCE(item->>'id','') <> ''
  ORDER BY item->>'id'
) copied
ON CONFLICT(id) DO UPDATE SET
  name=excluded.name,
  stock=excluded.stock,
  payload=excluded.payload,
  updated_at=excluded.updated_at;
