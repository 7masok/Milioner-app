export function stripPurchasesFromState(input) {
  const state = input && typeof input === 'object' && !Array.isArray(input) ? { ...input } : {};
  delete state.purchases;
  return state;
}

export function normalizedPurchase(row) {
  const purchase = row && typeof row === 'object' && !Array.isArray(row) ? { ...row } : {};
  const id = String(purchase.id || '').trim();
  if (!id) return null;
  purchase.id = id;
  purchase.productId = String(purchase.productId || '');
  purchase.status = String(purchase.status || '');
  purchase.qty = Number(purchase.qty || 0) || 0;
  return purchase;
}

function purchaseDate(purchase) {
  return Number(purchase.date || purchase.orderedAt || purchase.createdAt || 0) || 0;
}

export async function readWarehousePurchases(client) {
  const result = await client.query(`SELECT payload
    FROM warehouse_purchases
    ORDER BY purchase_date DESC, id DESC`);
  return result.rows.map(row => {
    const payload = row.payload;
    const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
    return normalizedPurchase(parsed);
  }).filter(Boolean);
}

export async function hydrateWarehousePurchases(client, state) {
  const target = state && typeof state === 'object' && !Array.isArray(state) ? state : {};
  const rows = await readWarehousePurchases(client);
  if (rows.length) target.purchases = rows;
  else if (!Array.isArray(target.purchases)) target.purchases = [];
  return target;
}

export async function persistWarehousePurchases(client, purchases, now = Date.now()) {
  const rows = (Array.isArray(purchases) ? purchases : []).map(normalizedPurchase).filter(Boolean);
  if (!rows.length) return 0;
  await client.query(`
    INSERT INTO warehouse_purchases(
      id,product_id,status,qty,purchase_date,payload,created_at,updated_at
    )
    SELECT
      item->>'id',
      COALESCE(item->>'productId',''),
      COALESCE(item->>'status',''),
      CASE WHEN COALESCE(item->>'qty','') ~ '^-?[0-9]+([.][0-9]+)?$' THEN (item->>'qty')::double precision ELSE 0 END,
      CASE
        WHEN COALESCE(item->>'date','') ~ '^-?[0-9]+$' THEN (item->>'date')::bigint
        WHEN COALESCE(item->>'orderedAt','') ~ '^-?[0-9]+$' THEN (item->>'orderedAt')::bigint
        WHEN COALESCE(item->>'createdAt','') ~ '^-?[0-9]+$' THEN (item->>'createdAt')::bigint
        ELSE 0
      END,
      item,
      CASE WHEN COALESCE(item->>'createdAt','') ~ '^-?[0-9]+$' THEN (item->>'createdAt')::bigint ELSE $2 END,
      $2
    FROM jsonb_array_elements($1::jsonb) AS item
    WHERE COALESCE(item->>'id','') <> ''
    ON CONFLICT(id) DO UPDATE SET
      product_id=excluded.product_id,
      status=excluded.status,
      qty=excluded.qty,
      purchase_date=excluded.purchase_date,
      payload=excluded.payload,
      updated_at=excluded.updated_at
  `, [JSON.stringify(rows), now]);
  return rows.length;
}

export async function deleteWarehousePurchases(client, ids) {
  const keys = [...new Set((Array.isArray(ids) ? ids : []).map(id => String(id || '').trim()).filter(Boolean))];
  if (!keys.length) return 0;
  const result = await client.query('DELETE FROM warehouse_purchases WHERE id = ANY($1::text[])', [keys]);
  return result.rowCount || 0;
}

export async function replaceWarehousePurchases(client, purchases, now = Date.now()) {
  const rows = (Array.isArray(purchases) ? purchases : []).map(normalizedPurchase).filter(Boolean);
  if (rows.length) await persistWarehousePurchases(client, rows, now);
  await client.query('DELETE FROM warehouse_purchases WHERE NOT (id = ANY($1::text[]))', [rows.map(row => row.id)]);
  return rows.length;
}
