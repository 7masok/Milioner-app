CREATE TABLE IF NOT EXISTS warehouse_reservations (
  id TEXT PRIMARY KEY,
  reservation_key TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  external_key TEXT NOT NULL DEFAULT '',
  product_id TEXT NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT false,
  qty DOUBLE PRECISION NOT NULL DEFAULT 0,
  reservation_date BIGINT NOT NULL DEFAULT 0,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at BIGINT NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS warehouse_reservations_key_idx
  ON warehouse_reservations (reservation_key);
CREATE INDEX IF NOT EXISTS warehouse_reservations_active_idx
  ON warehouse_reservations (active, product_id);

-- Copy reservations out of the warehouse document. Stock feeds read the table
-- after this migration; the document copy is removed on the next save.
INSERT INTO warehouse_reservations(
  id,reservation_key,source,external_key,product_id,active,qty,reservation_date,payload,created_at,updated_at
)
SELECT DISTINCT ON (id)
  id, reservation_key, source, external_key, product_id, active, qty, reservation_date, payload, created_at, updated_at
FROM (
  SELECT DISTINCT ON (reservation_key)
    COALESCE(NULLIF(item->>'id',''), NULLIF(item->>'externalKey',''), reservation_key) AS id,
    reservation_key,
    COALESCE(item->>'source','') AS source,
    COALESCE(item->>'externalKey','') AS external_key,
    COALESCE(item->>'productId','') AS product_id,
    COALESCE(item->>'active','') IN ('true','t','1') AS active,
    CASE WHEN COALESCE(item->>'qty','') ~ '^-?[0-9]+([.][0-9]+)?$' THEN (item->>'qty')::double precision ELSE 0 END AS qty,
    CASE WHEN COALESCE(item->>'date','') ~ '^-?[0-9]+$' THEN (item->>'date')::bigint ELSE 0 END AS reservation_date,
    CASE
      WHEN COALESCE(item->>'id','') <> '' THEN item
      ELSE jsonb_set(item, '{id}', to_jsonb(COALESCE(NULLIF(item->>'externalKey',''), reservation_key)))
    END AS payload,
    CASE WHEN COALESCE(item->>'date','') ~ '^-?[0-9]+$' THEN (item->>'date')::bigint ELSE 0 END AS created_at,
    (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS updated_at
  FROM (
    SELECT item,
      (COALESCE(item->>'source','') || '|' || COALESCE(NULLIF(item->>'externalKey',''), NULLIF(item->>'id',''), '')) AS reservation_key
    FROM warehouse_state ws
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE((ws.payload::jsonb)->'reservations','[]'::jsonb)) AS item
    WHERE ws.id=1
  ) keyed_items
  WHERE reservation_key <> '|'
  ORDER BY reservation_key, CASE WHEN COALESCE(item->>'date','') ~ '^-?[0-9]+$' THEN (item->>'date')::bigint ELSE 0 END DESC
) keyed
ORDER BY id
ON CONFLICT(id) DO UPDATE SET
  reservation_key=excluded.reservation_key,
  source=excluded.source,
  external_key=excluded.external_key,
  product_id=excluded.product_id,
  active=excluded.active,
  qty=excluded.qty,
  reservation_date=excluded.reservation_date,
  payload=excluded.payload,
  updated_at=excluded.updated_at;
