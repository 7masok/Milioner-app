export function stripReservationsFromState(input) {
  const state = input && typeof input === 'object' && !Array.isArray(input) ? { ...input } : {};
  delete state.reservations;
  return state;
}

export function reservationKey(row) {
  return String(`${row?.source || ''}|${row?.externalKey || row?.id || ''}`);
}

export function normalizedReservation(row) {
  const reservation = row && typeof row === 'object' && !Array.isArray(row) ? { ...row } : {};
  const externalKey = String(reservation.externalKey || '').trim();
  const key = reservationKey({ ...reservation, externalKey });
  if (key === '|') return null;
  const id = String(reservation.id || externalKey || key).trim();
  if (!id) return null;
  reservation.id = id;
  reservation.externalKey = externalKey;
  reservation.source = String(reservation.source || '');
  reservation.productId = String(reservation.productId || '');
  reservation.qty = Number(reservation.qty || 0) || 0;
  reservation.date = Number(reservation.date || 0) || 0;
  reservation.active = reservation.active === true || reservation.active === 'true';
  return reservation;
}

function uniqueReservations(rows) {
  const map = new Map();
  for (const row of (Array.isArray(rows) ? rows : []).map(normalizedReservation).filter(Boolean)) map.set(reservationKey(row), row);
  return [...map.values()];
}

export async function readWarehouseReservations(client) {
  const result = await client.query(`SELECT payload
    FROM warehouse_reservations
    ORDER BY reservation_date DESC, id DESC`);
  return result.rows.map(row => {
    const payload = row.payload;
    const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
    return normalizedReservation(parsed);
  }).filter(Boolean);
}

export async function hydrateWarehouseReservations(client, state) {
  const target = state && typeof state === 'object' && !Array.isArray(state) ? state : {};
  const rows = await readWarehouseReservations(client);
  if (rows.length) target.reservations = rows;
  else if (!Array.isArray(target.reservations)) target.reservations = [];
  return target;
}

async function removeKeyDuplicates(client, rows) {
  const keys = rows.map(reservationKey).filter(key => key && key !== '|');
  if (!keys.length) return;
  await client.query(`DELETE FROM warehouse_reservations
    WHERE reservation_key = ANY($1::text[])
      AND NOT (id = ANY($2::text[]))`, [keys, rows.map(row => row.id)]);
}

export async function persistWarehouseReservations(client, reservations, now = Date.now()) {
  const rows = uniqueReservations(reservations);
  if (!rows.length) return 0;
  await removeKeyDuplicates(client, rows);
  await client.query(`
    INSERT INTO warehouse_reservations(
      id,reservation_key,source,external_key,product_id,active,qty,reservation_date,payload,created_at,updated_at
    )
    SELECT
      item->>'id',
      (COALESCE(item->>'source','') || '|' || COALESCE(NULLIF(item->>'externalKey',''), item->>'id', '')),
      COALESCE(item->>'source',''),
      COALESCE(item->>'externalKey',''),
      COALESCE(item->>'productId',''),
      COALESCE(item->>'active','') IN ('true','t','1'),
      CASE WHEN COALESCE(item->>'qty','') ~ '^-?[0-9]+([.][0-9]+)?$' THEN (item->>'qty')::double precision ELSE 0 END,
      CASE WHEN COALESCE(item->>'date','') ~ '^-?[0-9]+$' THEN (item->>'date')::bigint ELSE 0 END,
      item,
      CASE WHEN COALESCE(item->>'date','') ~ '^-?[0-9]+$' THEN (item->>'date')::bigint ELSE $2 END,
      $2
    FROM jsonb_array_elements($1::jsonb) AS item
    WHERE COALESCE(item->>'id','') <> ''
    ON CONFLICT(id) DO UPDATE SET
      reservation_key=excluded.reservation_key,
      source=excluded.source,
      external_key=excluded.external_key,
      product_id=excluded.product_id,
      active=excluded.active,
      qty=excluded.qty,
      reservation_date=excluded.reservation_date,
      payload=excluded.payload,
      updated_at=excluded.updated_at
  `, [JSON.stringify(rows), now]);
  return rows.length;
}

export async function deleteWarehouseReservations(client, keys) {
  const values = [...new Set((Array.isArray(keys) ? keys : []).map(key => String(key || '').trim()).filter(key => key && key !== '|'))];
  if (!values.length) return 0;
  const result = await client.query(`DELETE FROM warehouse_reservations
    WHERE reservation_key = ANY($1::text[]) OR id = ANY($1::text[])`, [values]);
  return result.rowCount || 0;
}

export async function replaceWarehouseReservations(client, reservations, now = Date.now()) {
  const rows = uniqueReservations(reservations);
  if (rows.length) await persistWarehouseReservations(client, rows, now);
  const keys = rows.map(reservationKey).filter(key => key && key !== '|');
  await client.query('DELETE FROM warehouse_reservations WHERE NOT (reservation_key = ANY($1::text[]))', [keys]);
  return rows.length;
}
