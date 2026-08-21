import { config } from './config.js';
import { pool, transaction } from './db.js';

const WB_STATUS_URL = 'https://marketplace-api.wildberries.ru/api/v3/orders/status';
const FETCH_TIMEOUT_MS = 20_000;
const START_DELAY_MS = 5_000;
const LOOP_INTERVAL_MS = 60_000;
const STATUS_BATCH_SIZE = 100;
const MAX_INT64 = 9223372036854775807n;
let refreshInFlight = null;

function tokenFor(market) {
  return String(market === 'WB2' ? config.wbToken2 : config.wbToken).trim();
}

function stage(status, state = '') {
  const u = String(status || '').toUpperCase();
  const st = String(state || '').toUpperCase();
  if (['CANCELED','CANCELLED','CANCELED_BY_CLIENT','DECLINED_BY_CLIENT','DEFECT'].includes(st) || ['CANCEL','CANCELLED'].includes(u)) return 'cancelled';
  if (['SORTED','ACCEPTED_BY_CARRIER','SENT_TO_CARRIER','READY_FOR_PICKUP','SOLD'].includes(st)) return 'delivery';
  if (u === 'CONFIRM' || u === 'COMPLETE' || (st === 'WAITING' && u !== 'NEW')) return 'transfer';
  return 'new';
}

function parseReservationOrderId(market, key) {
  const text = String(key || '');
  const prefix = market + ':';
  if (!text.startsWith(prefix)) return '';
  const rest = text.slice(prefix.length);
  const pos = rest.indexOf(':');
  return pos > 0 ? rest.slice(0, pos) : '';
}

function validInt64Id(value) {
  const s = String(value || '').trim();
  if (!/^\d+$/.test(s)) return false;
  try { return BigInt(s) <= MAX_INT64; } catch { return false; }
}

async function fetchStatusBatch(market, ids) {
  const token = tokenFor(market);
  const exactIds = ids.map(x => String(x).trim()).filter(validInt64Id);
  if (!exactIds.length) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(WB_STATUS_URL, {
      method: 'POST',
      headers: { Authorization: token, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: `{"orders":[${exactIds.join(',')}]}`,
      cache: 'no-store',
      signal: controller.signal
    });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch {}
    if (!response.ok) throw new Error(`WB ${market} statuses HTTP ${response.status}: ${String(data?.detail || data?.message || text || '').slice(0, 500)}`);
    return Array.isArray(data?.orders) ? data.orders : [];
  } finally {
    clearTimeout(timer);
  }
}

async function fetchStatuses(market, orderIds) {
  const token = tokenFor(market);
  if (!token || !orderIds.length) return [];
  const exact = [...new Set(orderIds.map(x => String(x).trim()).filter(validInt64Id))].slice(0, STATUS_BATCH_SIZE);
  return fetchStatusBatch(market, exact);
}

async function reservationOrderIds(market) {
  const row = await pool.query('SELECT payload FROM warehouse_state WHERE id=1');
  if (!row.rowCount) return [];
  let state = {};
  try { state = JSON.parse(String(row.rows[0].payload || '{}')); } catch { return []; }
  const ids = new Set();
  for (const r of Array.isArray(state.reservations) ? state.reservations : []) {
    if (String(r?.source || '') !== market) continue;
    const reason = String(r?.closedReason || '');
    const needsCheck = r?.active || ['wb-not-in-current-new-orders','market-row-outside-active-window','duplicate-reservation'].includes(reason);
    if (!needsCheck) continue;
    const id = parseReservationOrderId(market, r.externalKey);
    if (validInt64Id(id)) ids.add(id);
  }
  return [...ids].slice(0, STATUS_BATCH_SIZE);
}

async function applyStatuses(market, statuses) {
  if (!statuses.length) return { checked: 0, closed: 0, changedLines: 0 };
  const byId = new Map();
  let changedLines = 0;
  for (const row of statuses) {
    const id = String(row?.id ?? '').trim();
    if (!id) continue;
    const supplierStatus = String(row?.supplierStatus ?? row?.status ?? '').trim();
    const wbStatus = String(row?.wbStatus ?? row?.state ?? '').trim();
    byId.set(id, { supplierStatus, wbStatus, stage: stage(supplierStatus, wbStatus) });
    const q = await pool.query(`UPDATE marketplace_order_lines
      SET status=CASE WHEN $1<>'' THEN $1 ELSE status END,
          state=CASE WHEN $2<>'' THEN $2 ELSE state END,
          updated_at=$3
      WHERE market=$4 AND order_id=$5`, [supplierStatus, wbStatus, Date.now(), market, id]);
    changedLines += q.rowCount || 0;
  }

  const closed = await transaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [730021]);
    const current = await client.query('SELECT payload,revision FROM warehouse_state WHERE id=1 FOR UPDATE');
    if (!current.rowCount) return 0;
    let state = {};
    try { state = JSON.parse(String(current.rows[0].payload || '{}')); } catch { return 0; }
    if (!Array.isArray(state.reservations)) return 0;
    let count = 0;
    const now = Date.now();
    for (const r of state.reservations) {
      if (!r?.active || String(r?.source || '') !== market) continue;
      const orderId = parseReservationOrderId(market, r.externalKey);
      const live = byId.get(orderId);
      if (!live || !['delivery','cancelled'].includes(live.stage)) continue;
      r.active = false;
      r.updatedAt = now;
      r.closedReason = live.stage === 'cancelled' ? 'wb-explicit-cancel' : 'wb-explicit-handoff';
      count++;
    }
    if (!count) return 0;
    const revision = Number(current.rows[0].revision || 0) + 1;
    await client.query('UPDATE warehouse_state SET payload=$1,revision=$2,updated_at=$3 WHERE id=1', [JSON.stringify(state), revision, now]);
    return count;
  });

  return { checked: byId.size, closed, changedLines };
}

export async function refreshWbReservationStatuses() {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const summary = {};
    for (const market of ['WB','WB2']) {
      const ids = await reservationOrderIds(market);
      if (!ids.length || !tokenFor(market)) {
        summary[market] = { checked: 0, closed: 0, changedLines: 0 };
        continue;
      }
      try {
        const statuses = await fetchStatuses(market, ids);
        summary[market] = await applyStatuses(market, statuses);
      } catch (error) {
        summary[market] = { checked: 0, closed: 0, changedLines: 0, error: String(error?.message || error) };
      }
    }
    console.log(`WB reservation-status refresh: ${JSON.stringify(summary)}`);
    return summary;
  })();
  try { return await refreshInFlight; } finally { refreshInFlight = null; }
}

export function startWbReservationRefreshLoop() {
  const run = () => refreshWbReservationStatuses().catch(error => console.error('WB reservation-status refresh failed', String(error?.message || error)));
  setTimeout(run, START_DELAY_MS).unref();
  const timer = setInterval(run, LOOP_INTERVAL_MS);
  timer.unref();
  return timer;
}
