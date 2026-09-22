export function stripProductsFromState(input) {
  const state = input && typeof input === 'object' && !Array.isArray(input) ? { ...input } : {};
  delete state.products;
  return state;
}

export function normalizedProduct(row) {
  const product = row && typeof row === 'object' && !Array.isArray(row) ? { ...row } : {};
  const id = String(product.id || '').trim();
  if (!id) return null;
  product.id = id;
  product.name = String(product.name || '');
  const stock = Number(product.stock);
  product.stock = Number.isFinite(stock) ? stock : 0;
  return product;
}

function uniqueProducts(rows) {
  const map = new Map();
  for (const row of (Array.isArray(rows) ? rows : []).map(normalizedProduct).filter(Boolean)) map.set(row.id, row);
  return [...map.values()];
}

export async function readWarehouseProducts(client) {
  const result = await client.query(`SELECT payload FROM warehouse_products ORDER BY name, id`);
  return result.rows.map(row => {
    const payload = row.payload;
    const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
    return normalizedProduct(parsed);
  }).filter(Boolean);
}

export async function hydrateWarehouseProducts(client, state) {
  const target = state && typeof state === 'object' && !Array.isArray(state) ? state : {};
  const rows = await readWarehouseProducts(client);
  if (rows.length) target.products = rows;
  else if (!Array.isArray(target.products)) target.products = [];
  return target;
}

export async function persistWarehouseProducts(client, products, now = Date.now()) {
  const rows = uniqueProducts(products);
  if (!rows.length) return 0;
  await client.query(`
    INSERT INTO warehouse_products(id,name,stock,payload,created_at,updated_at)
    SELECT
      item->>'id',
      COALESCE(item->>'name',''),
      CASE WHEN COALESCE(item->>'stock','') ~ '^-?[0-9]+([.][0-9]+)?$' THEN (item->>'stock')::double precision ELSE 0 END,
      item,
      CASE WHEN COALESCE(item->>'createdAt','') ~ '^-?[0-9]+$' THEN (item->>'createdAt')::bigint ELSE $2 END,
      $2
    FROM jsonb_array_elements($1::jsonb) AS item
    WHERE COALESCE(item->>'id','') <> ''
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name,
      stock=excluded.stock,
      payload=excluded.payload,
      updated_at=excluded.updated_at
  `, [JSON.stringify(rows), now]);
  return rows.length;
}

export async function deleteWarehouseProducts(client, ids) {
  const values = [...new Set((Array.isArray(ids) ? ids : []).map(id => String(id || '').trim()).filter(Boolean))];
  if (!values.length) return 0;
  const result = await client.query('DELETE FROM warehouse_products WHERE id = ANY($1::text[])', [values]);
  return result.rowCount || 0;
}

export async function replaceWarehouseProducts(client, products, now = Date.now()) {
  const rows = uniqueProducts(products);
  if (rows.length) await persistWarehouseProducts(client, rows, now);
  await client.query('DELETE FROM warehouse_products WHERE NOT (id = ANY($1::text[]))', [rows.map(row => row.id)]);
  return rows.length;
}
