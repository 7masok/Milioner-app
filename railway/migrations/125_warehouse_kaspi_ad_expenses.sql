CREATE TABLE IF NOT EXISTS warehouse_kaspi_ad_expenses (
  id TEXT PRIMARY KEY,
  expense_key TEXT NOT NULL,
  file_name TEXT NOT NULL DEFAULT '',
  amount DOUBLE PRECISION NOT NULL DEFAULT 0,
  imported_at BIGINT NOT NULL DEFAULT 0,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at BIGINT NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS warehouse_kaspi_ad_expenses_key_idx
  ON warehouse_kaspi_ad_expenses (expense_key);
CREATE INDEX IF NOT EXISTS warehouse_kaspi_ad_expenses_imported_idx
  ON warehouse_kaspi_ad_expenses (imported_at DESC, id);

-- Manual Kaspi ad imports stay available to the phone. They are copied out of
-- the warehouse document and removed from it on the next save.
INSERT INTO warehouse_kaspi_ad_expenses(id,expense_key,file_name,amount,imported_at,payload,created_at,updated_at)
SELECT DISTINCT ON (id)
  id, expense_key, file_name, amount, imported_at, payload, created_at, updated_at
FROM (
  SELECT DISTINCT ON (expense_key)
    COALESCE(NULLIF(item->>'id',''), NULLIF(item->>'importId',''), expense_key) AS id,
    expense_key,
    COALESCE(item->>'fileName','') AS file_name,
    CASE WHEN COALESCE(item->>'amount','') ~ '^-?[0-9]+([.][0-9]+)?$' THEN (item->>'amount')::double precision ELSE 0 END AS amount,
    CASE WHEN COALESCE(item->>'importedAt','') ~ '^-?[0-9]+$' THEN (item->>'importedAt')::bigint ELSE 0 END AS imported_at,
    CASE
      WHEN COALESCE(item->>'id','') <> '' THEN item
      ELSE jsonb_set(item, '{id}', to_jsonb(COALESCE(NULLIF(item->>'importId',''), expense_key)))
    END AS payload,
    CASE WHEN COALESCE(item->>'importedAt','') ~ '^-?[0-9]+$' THEN (item->>'importedAt')::bigint ELSE 0 END AS created_at,
    (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS updated_at
  FROM (
    SELECT item,
      COALESCE(
        NULLIF(item->>'id',''),
        NULLIF(item->>'importId',''),
        CONCAT_WS('|', COALESCE(item->>'date',''), COALESCE(item->>'day',''), COALESCE(item->>'productId',''), COALESCE(item->>'sku',''), COALESCE(item->>'amount',''))
      ) AS expense_key
    FROM warehouse_state ws
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE((ws.payload::jsonb)->'kaspiAdExpenses','[]'::jsonb)) AS item
    WHERE ws.id=1
  ) keyed_items
  WHERE expense_key <> '' AND expense_key <> '||||'
  ORDER BY expense_key, CASE WHEN COALESCE(item->>'importedAt','') ~ '^-?[0-9]+$' THEN (item->>'importedAt')::bigint ELSE 0 END DESC
) keyed
ORDER BY id
ON CONFLICT(id) DO UPDATE SET
  expense_key=excluded.expense_key,
  file_name=excluded.file_name,
  amount=excluded.amount,
  imported_at=excluded.imported_at,
  payload=excluded.payload,
  updated_at=excluded.updated_at;
