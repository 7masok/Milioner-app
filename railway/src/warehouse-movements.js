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
  for (const movement of rows) {
    await client.query(`INSERT INTO warehouse_movements(
        id,product_id,movement_date,movement_type,qty,payload,created_at,updated_at
      ) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)
      ON CONFLICT(id) DO UPDATE SET
        product_id=excluded.product_id,
        movement_date=excluded.movement_date,
        movement_type=excluded.movement_type,
        qty=excluded.qty,
        payload=excluded.payload,
        updated_at=excluded.updated_at`, [
      movement.id,
      movement.productId,
      movement.date,
      movement.type,
      movement.qty,
      JSON.stringify(movement),
      movement.date || now,
      now
    ]);
  }
  return rows.length;
}

export async function legacyCompatibleWarehouseState(client, rawPayload) {
  const state = parseWarehousePayload(rawPayload);
  return hydrateWarehouseMovements(client, state);
}

export async function legacyCompatibleWarehousePayload(client, rawPayload) {
  return JSON.stringify(await legacyCompatibleWarehouseState(client, rawPayload));
}
