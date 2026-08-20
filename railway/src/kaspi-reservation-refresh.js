import { config } from './config.js';
import { pool } from './db.js';

const KASPI_API = 'https://kaspi.kz/shop/api/v2';
const FETCH_TIMEOUT_MS = 15_000;
const STALE_ROW_MS = 10 * 60 * 1000;
const START_DELAY_MS = 5_000;
const LOOP_INTERVAL_MS = 10 * 60 * 1000;
const MAX_ORDERS_PER_RUN = 200;
const BETWEEN_REQUESTS_MS = 120;
let refreshInFlight = null;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseWarehouse(raw) {
  try {
    const value = JSON.parse(String(raw || '{}'));
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function parseReservationKey(value) {
  let key = String(value || '').trim();
  if (key.startsWith('Kaspi:')) key = key.slice('Kaspi:'.length);
  const split = key.indexOf(':');
  if (split <= 0 || split >= key.length - 1) return null;
  return { orderId: key.slice(0, split), entryId: key.slice(split + 1) };
}

function kaspiHeaders() {
  const token = String(config.kaspiToken || '').trim();
  if (!token) return null;
  return {
    Accept: 'application/vnd.api+json',
    'Content-Type': 'application/vnd.api+json',
    'X-Auth-Token': token
  };
}

async function fetchExactOrderByCode(code) {
  const headers = kaspiHeaders();
  if (!headers || !code) return null;
  const query = new URLSearchParams();
  query.set('page[number]', '0');
  query.set('page[size]', '20');
  query.set('filter[orders][code]', String(code));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`${KASPI_API}/orders?${query.toString()}`, {
      headers,
      cache: 'no-store',
      signal: controller.signal
    });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch {}
    if (!response.ok) throw new Error(`Kaspi exact-order HTTP ${response.status}`);
    const exact = (Array.isArray(data?.data) ? data.data : []).filter(order =>
      String(order?.attributes?.code ?? order?.code ?? '').trim() === String(code).trim()
    );
    return exact.length === 1 ? exact[0] : null;
  } finally {
    clearTimeout(timer);
  }
}

async function reservationCandidates() {
  const snapshot = await pool.query('SELECT payload FROM warehouse_state WHERE id=1');
  if (!snapshot.rowCount) return [];
  const state = parseWarehouse(snapshot.rows[0].payload);
  const unique = new Map();
  for (const reservation of Array.isArray(state.reservations) ? state.reservations : []) {
    if (!reservation?.active || String(reservation.source || '') !== 'Kaspi') continue;
    const parsed = parseReservationKey(reservation.externalKey);
    if (!parsed) continue;
    unique.set(`${parsed.orderId}\u0000${parsed.entryId}`, parsed);
    if (unique.size >= MAX_ORDERS_PER_RUN) break;
  }
  return [...unique.values()];
}

async function staleStoredRow(ref) {
  const result = await pool.query(`SELECT order_id AS "orderId",entry_id AS "entryId",code,status,state,updated_at AS "updatedAt"
    FROM marketplace_order_lines
    WHERE market='Kaspi' AND order_id=$1 AND entry_id=$2
    LIMIT 1`, [ref.orderId, ref.entryId]);
  const row = result.rows[0] || null;
  if (!row?.code) return null;
  if (Number(row.updatedAt || 0) >= Date.now() - STALE_ROW_MS) return null;
  return row;
}

export async function refreshStaleKaspiReservationOrders() {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    if (!String(config.kaspiToken || '').trim()) return { checked: 0, touched: 0, changed: 0 };
    const candidates = await reservationCandidates();
    let checked = 0, touched = 0, changed = 0;
    for (const ref of candidates) {
      const stored = await staleStoredRow(ref);
      if (!stored) continue;
      let live = null;
      try { live = await fetchExactOrderByCode(stored.code); }
      catch (error) {
        console.warn('Kaspi reservation exact refresh failed', String(error?.message || error));
        await sleep(BETWEEN_REQUESTS_MS);
        continue;
      }
      checked++;
      if (live) {
        const liveId = String(live?.id || '').trim();
        const liveCode = String(live?.attributes?.code ?? live?.code ?? '').trim();
        if (liveId && liveId === String(stored.orderId) && liveCode === String(stored.code)) {
          const status = String(live?.attributes?.status ?? live?.status ?? '').trim();
          const state = String(live?.attributes?.state ?? live?.state ?? '').trim();
          if (status) {
            const isChanged = status !== String(stored.status || '') || state !== String(stored.state || '');
            const now = Date.now();
            const result = await pool.query(`UPDATE marketplace_order_lines
              SET status=$1,state=$2,updated_at=$3
              WHERE market='Kaspi' AND order_id=$4 AND code=$5`,
            [status, state, now, stored.orderId, stored.code]);
            if (result.rowCount) {
              touched += result.rowCount;
              if (isChanged) changed += result.rowCount;
            }
          }
        }
      }
      await sleep(BETWEEN_REQUESTS_MS);
    }
    if (checked || touched) console.log(`Kaspi reservation exact refresh: checked=${checked} touched=${touched} changed=${changed}`);
    return { checked, touched, changed };
  })();
  try { return await refreshInFlight; } finally { refreshInFlight = null; }
}

export function startKaspiReservationRefreshLoop() {
  const run = () => refreshStaleKaspiReservationOrders().catch(error =>
    console.error('Kaspi reservation refresh loop failed', String(error?.message || error))
  );
  setTimeout(run, START_DELAY_MS).unref();
  const timer = setInterval(run, LOOP_INTERVAL_MS);
  timer.unref();
  return timer;
}
