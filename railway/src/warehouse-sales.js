export function stripSalesFromState(input) {
  const state = input && typeof input === 'object' && !Array.isArray(input) ? { ...input } : {};
  delete state.sales;
  return state;
}

export function saleKey(row) {
  return String(row?.externalKey || row?.id || '').trim();
}

export function normalizedSale(row) {
  const sale = row && typeof row === 'object' && !Array.isArray(row) ? { ...row } : {};
  const externalKey = String(sale.externalKey || '').trim();
  const id = String(sale.id || externalKey || '').trim();
  if (!id) return null;
  sale.id = id;
  sale.externalKey = externalKey;
  sale.productId = String(sale.productId || '');
  sale.channel = String(sale.channel || sale.market || '');
  sale.qty = Number(sale.qty || 0) || 0;
  sale.date = Number(sale.date || 0) || 0;
  return sale;
}

export async function readWarehouseSales(client) {
  const result = await client.query(`SELECT payload
    FROM warehouse_sales
    ORDER BY sale_date DESC, id DESC`);
  return result.rows.map(row => {
    const payload = row.payload;
    const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
    return normalizedSale(parsed);
  }).filter(Boolean);
}

export async function hydrateWarehouseSales(client, state) {
  const target = state && typeof state === 'object' && !Array.isArray(state) ? state : {};
  const rows = await readWarehouseSales(client);
  if (rows.length) target.sales = rows;
  else if (!Array.isArray(target.sales)) target.sales = [];
  return target;
}

function uniqueSales(sales) {
  const map = new Map();
  for (const row of (Array.isArray(sales) ? sales : []).map(normalizedSale).filter(Boolean)) map.set(saleKey(row), row);
  return [...map.values()];
}

async function removeExternalKeyDuplicates(client, rows) {
  const keyed = rows.filter(row => row.externalKey);
  if (!keyed.length) return;
  await client.query(`
    DELETE FROM warehouse_sales old
    USING jsonb_array_elements($1::jsonb) AS item
    WHERE COALESCE(item->>'externalKey','') <> ''
      AND old.external_key = item->>'externalKey'
      AND old.id <> item->>'id'
  `, [JSON.stringify(keyed)]);
}

export async function persistWarehouseSales(client, sales, now = Date.now()) {
  const rows = uniqueSales(sales);
  if (!rows.length) return 0;
  await removeExternalKeyDuplicates(client, rows);
  await client.query(`
    INSERT INTO warehouse_sales(
      id,external_key,product_id,channel,qty,sale_date,payload,created_at,updated_at
    )
    SELECT
      item->>'id',
      COALESCE(item->>'externalKey',''),
      COALESCE(item->>'productId',''),
      COALESCE(NULLIF(item->>'channel',''), NULLIF(item->>'market',''), ''),
      CASE WHEN COALESCE(item->>'qty','') ~ '^-?[0-9]+([.][0-9]+)?$' THEN (item->>'qty')::double precision ELSE 0 END,
      CASE WHEN COALESCE(item->>'date','') ~ '^-?[0-9]+$' THEN (item->>'date')::bigint ELSE 0 END,
      item,
      CASE WHEN COALESCE(item->>'date','') ~ '^-?[0-9]+$' THEN (item->>'date')::bigint ELSE $2 END,
      $2
    FROM jsonb_array_elements($1::jsonb) AS item
    WHERE COALESCE(item->>'id','') <> ''
    ON CONFLICT(id) DO UPDATE SET
      external_key=excluded.external_key,
      product_id=excluded.product_id,
      channel=excluded.channel,
      qty=excluded.qty,
      sale_date=excluded.sale_date,
      payload=excluded.payload,
      updated_at=excluded.updated_at
  `, [JSON.stringify(rows), now]);
  return rows.length;
}

export async function deleteWarehouseSales(client, keys) {
  const values = [...new Set((Array.isArray(keys) ? keys : []).map(key => String(key || '').trim()).filter(Boolean))];
  if (!values.length) return 0;
  const result = await client.query(`DELETE FROM warehouse_sales
    WHERE id = ANY($1::text[]) OR (external_key <> '' AND external_key = ANY($1::text[]))`, [values]);
  return result.rowCount || 0;
}

export async function replaceWarehouseSales(client, sales, now = Date.now()) {
  const rows = uniqueSales(sales);
  if (rows.length) await persistWarehouseSales(client, rows, now);
  const keys = rows.map(saleKey).filter(Boolean);
  await client.query(`DELETE FROM warehouse_sales
    WHERE NOT (
      CASE WHEN external_key <> '' THEN external_key ELSE id END = ANY($1::text[])
    )`, [keys]);
  return rows.length;
}
