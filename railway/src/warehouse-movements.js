import { hydrateWarehousePurchases } from './warehouse-purchases.js';

export function parseWarehousePayload(raw) {
  try { return JSON.parse(String(raw || '{}')); } catch { return {}; }
}

export function stripMovementsFromState(input) {
  const state = input && typeof input === 'object' && !Array.isArray(input) ? { ...input } : {};
  delete state.movements;
  return state;
}

function normalizedMovement(row) {
  const movement = row && typeof row === 'object' && !Array.isArray(row) ? { ...row } : {};
  const id = String(movement.id || '').trim();
  if (!id) return null;
  movement.id = id;
  movement.productId = String(movement.productId || '');
  movement.type = String(movement.type || '');
  movement.date = Number(movement.date || 0) || 0;
  movement.qty = Number(movement.qty || 0) || 0;
  return movement;
}

export async function readWarehouseMovements(client) {
  const result = await client.query(`SELECT payload
    FROM warehouse_movements
    ORDER BY movement_date DESC, id DESC`);
  return result.rows.map(row => {
    const payload = row.payload;
    return normalizedMovement(typeof payload === 'string' ? parseWarehousePayload(payload) : payload);
  }).filter(Boolean);
}

export async function hydrateWarehouseMovements(client, state) {
  const target = state && typeof state === 'object' && !Array.isArray(state) ? state : {};
  target.movements = await readWarehouseMovements(client);
  return target;
}

export async function persistWarehouseMovements(client, movements, now = Date.now()) {
  const rows = Array.isArray(movements) ? movements.map(normalizedMovement).filter(Boolean) : [];
  if (!rows.length) return 0;
  await client.query(`
    INSERT INTO warehouse_movements(
      id,product_id,movement_date,movement_type,qty,payload,created_at,updated_at
    )
    SELECT
      item->>'id',
      COALESCE(item->>'productId',''),
      CASE WHEN COALESCE(item->>'date','') ~ '^-?[0-9]+$' THEN (item->>'date')::bigint ELSE 0 END,
      COALESCE(item->>'type',''),
      CASE WHEN COALESCE(item->>'qty','') ~ '^-?[0-9]+([.][0-9]+)?$' THEN (item->>'qty')::double precision ELSE 0 END,
      item,
      CASE WHEN COALESCE(item->>'date','') ~ '^-?[0-9]+$' THEN (item->>'date')::bigint ELSE $2 END,
      $2
    FROM jsonb_array_elements($1::jsonb) AS item
    WHERE COALESCE(item->>'id','') <> ''
    ON CONFLICT(id) DO UPDATE SET
      product_id=excluded.product_id,
      movement_date=excluded.movement_date,
      movement_type=excluded.movement_type,
      qty=excluded.qty,
      payload=excluded.payload,
      updated_at=excluded.updated_at
  `, [JSON.stringify(rows), now]);
  return rows.length;
}

export async function legacyCompatibleWarehouseState(client, rawPayload) {
  const state = parseWarehousePayload(rawPayload);
  await hydrateWarehousePurchases(client, state);
  return hydrateWarehouseMovements(client, state);
}

export async function legacyCompatibleWarehousePayload(client, rawPayload) {
  return JSON.stringify(await legacyCompatibleWarehouseState(client, rawPayload));
}
