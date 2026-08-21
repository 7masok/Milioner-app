import { config } from './config.js';
import { pool, transaction } from './db.js';

const WB_STATUS_URL = 'https://marketplace-api.wildberries.ru/api/v3/orders/status';
const FETCH_TIMEOUT_MS = 20_000;
const START_DELAY_MS = 5_000;
const LOOP_INTERVAL_MS = 60_000;
const STATUS_BATCH_SIZE = 100;
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

async function fetchStatusBatch(market, ids) {
  const token = tokenFor(market);
  const exactIds = ids.map(x => String(x).trim()).filter(x => /^\d+$/.test(x));
  if (!exactIds.length) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(WB_STATUS_URL, {
      method: 'POST',
      headers: { Authorization: token, Accept: 'application/json', 'Content-Type': 'application/json' },
      // Build the JSON numeric tokens manually so 64-bit WB order IDs are not
      // rounded by JavaScript Number before they reach the API.
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
  const exact = [...new Set(orderIds.map(x => String(x).trim()).filter(x => /^\d+$/.test(x)))];
  const out = [];
  for (let i = 0; i < exact.length; i += STATUS_BATCH_SIZE) {
    const rows = await fetchStatusBatch(market, exact.slice(i, i + STATUS_BATCH_SIZE));
    out.push(...rows);
  }
  return out;
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
    const needsCheck = r?.active || ['wb-not-in-current-new-orders','market-row-not-fresh','duplicate-reservation'].includes(reason);
    if (!needsCheck) continue;
    const id = parseReservationOrderId(market, r.externalKey);
    if (id) ids.add(id);
  }
  return [...ids].slice(0, 1000);
}

async function applyStatuses(market, statuses) {
  if (!statuses.length) return { checked: 0, closed: 0, reopened: 0, changedLines: 0 };
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

  const result = await transaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [730021]);
    const current = await client.query('SELECT payload,revision FROM warehouse_state WHERE id=1 FOR UPDATE');
    if (!current.rowCount) return { closed: 0, reopened: 0 };
    let state = {};
    try { state = JSON.parse(String(current.rows[0].payload || '{}')); } catch { return { closed: 0, reopened: 0 }; }
    if (!Array.isArray(state.reservations)) return { closed: 0, reopened: 0 };
    let closed = 0, reopened = 0, changed = 0;
    const now = Date.now();
    for (const r of state.reservations) {
      if (String(r?.source || '') !== market) continue;
      const orderId = parseReservationOrderId(market, r.externalKey);
      const live = byId.get(orderId);
      if (!live) continue;
      if (live.stage === 'new') {
        if (!r.active) {
          r.active = true;
          r.stage = 'new';
          r.updatedAt = now;
          delete r.closedReason;
          reopened++; changed++;
        } else if (String(r.stage || '') !== 'new') {
          r.stage = 'new';
          r.updatedAt = now;
          changed++;
        }
      } else if (r.active) {
        r.active = false;
        r.updatedAt = now;
        r.closedReason = live.stage === 'cancelled' ? 'wb-explicit-cancel' : live.stage === 'delivery' ? 'wb-explicit-handoff' : 'wb-explicit-transfer';
        closed++; changed++;
      }
    }
    if (!changed) return { closed, reopened };
    const revision = Number(current.rows[0].revision || 0) + 1;
    await client.query('UPDATE warehouse_state SET payload=$1,revision=$2,updated_at=$3 WHERE id=1', [JSON.stringify(state), revision, now]);
    return { closed, reopened };
  });

  return { checked: byId.size, closed: result.closed, reopened: result.reopened, changedLines };
}

export async function refreshWbReservationStatuses() {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const summary = {};
    for (const market of ['WB','WB2']) {
      const ids = await reservationOrderIds(market);
      if (!ids.length || !tokenFor(market)) {
        summary[market] = { checked: 0, closed: 0, reopened: 0, changedLines: 0 };
        continue;
      }
      try {
        const statuses = await fetchStatuses(market, ids);
        summary[market] = await applyStatuses(market, statuses);
      } catch (error) {
        summary[market] = { checked: 0, closed: 0, reopened: 0, changedLines: 0, error: String(error?.message || error) };
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
