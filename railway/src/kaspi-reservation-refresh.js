import { config } from './config.js';
import { pool } from './db.js';

const KASPI_API = 'https://kaspi.kz/shop/api/v2';
const FETCH_TIMEOUT_MS = 15_000;
const START_DELAY_MS = 4_000;
const LOOP_INTERVAL_MS = 60_000;
const EXACT_INTERVAL_MS = 5 * 60_000;
const LOOKBACK_DAYS = 3;
const EXACT_LOOKBACK_DAYS = 14;
const PAGE_SIZE = 100;
const MAX_PAGES = 4;
const EXACT_LIMIT = 60;
const BETWEEN_REQUESTS_MS = 100;
const SYNC_STATES = ['NEW', 'DELIVERY', 'KASPI_DELIVERY', 'ARCHIVE'];
let refreshInFlight = null;
let lastExactAt = 0;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function n(value, fallback = 0) {
  const x = Number(value);
  return Number.isFinite(x) ? x : fallback;
}

function timestamp(value) {
  if (value == null || value === '') return 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric < 1e12 ? numeric * 1000 : numeric;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function finalKaspiStatus(status) {
  const u = String(status || '').toUpperCase();
  return ['CANCELLED', 'CANCELLING', 'RETURNED', 'KASPI_DELIVERY_RETURN_REQUESTED', 'COMPLETED'].includes(u);
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

async function fetchJson(url) {
  const headers = kaspiHeaders();
  if (!headers) throw new Error('KASPI_TOKEN is not configured');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers, cache: 'no-store', signal: controller.signal });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch {}
    if (!response.ok) throw new Error(`Kaspi order header HTTP ${response.status}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function headerFromOrder(raw) {
  const attrs = raw?.attributes || raw || {};
  const orderId = String(raw?.id ?? attrs.id ?? '').trim();
  const code = String(attrs.code ?? raw?.code ?? orderId).trim();
  const status = String(attrs.status ?? raw?.status ?? '').trim();
  const sourceState = String(attrs.state ?? raw?.state ?? '').trim();
  const courierTransmissionDate = timestamp(attrs.courierTransmissionDate ?? raw?.courierTransmissionDate);

  // Kaspi exposes courierTransmissionDate as the actual courier hand-off time.
  // The existing warehouse lifecycle already treats KASPI_DELIVERY_TRANSIT as
  // delivered-to-carrier, so derive that state only from this explicit fact.
  // Cancellation/return/completion always has priority over the hand-off marker.
  const state = !finalKaspiStatus(status) && courierTransmissionDate > 0
    ? 'KASPI_DELIVERY_TRANSIT'
    : sourceState;

  return {
    orderId,
    code,
    status,
    state,
    sourceState,
    courierTransmissionDate,
    rawJson: JSON.stringify(raw || {})
  };
}

async function fetchStatePage(state, page) {
  const end = Date.now();
  const start = end - LOOKBACK_DAYS * 86_400_000;
  const query = new URLSearchParams();
  query.set('page[number]', String(page));
  query.set('page[size]', String(PAGE_SIZE));
  query.set('filter[orders][creationDate][$ge]', String(start));
  query.set('filter[orders][creationDate][$le]', String(end));
  query.set('filter[orders][state]', state);
  const data = await fetchJson(`${KASPI_API}/orders?${query.toString()}`);
  return {
    orders: Array.isArray(data?.data) ? data.data : [],
    pageCount: Math.max(1, n(data?.meta?.pageCount ?? data?.meta?.totalPages ?? 1, 1))
  };
}

async function applyHeader(header) {
  if (!header.orderId || !header.status) return { touched: 0, changed: 0 };
  const before = await pool.query(`SELECT status,state FROM marketplace_order_lines
    WHERE market='Kaspi' AND order_id=$1 LIMIT 1`, [header.orderId]);
  if (!before.rowCount) return { touched: 0, changed: 0 };
  const previous = before.rows[0] || {};
  const changed = String(previous.status || '') !== header.status || String(previous.state || '') !== header.state;
  const now = Date.now();
  const result = await pool.query(`UPDATE marketplace_order_lines
    SET code=CASE WHEN $1<>'' THEN $1 ELSE code END,
        status=$2,
        state=$3,
        raw_json=$4,
        updated_at=$5
    WHERE market='Kaspi' AND order_id=$6`,
  [header.code, header.status, header.state, header.rawJson, now, header.orderId]);
  return { touched: result.rowCount || 0, changed: changed ? (result.rowCount || 0) : 0 };
}

async function broadHeaderRefresh() {
  const seen = new Set();
  let fetched = 0, touched = 0, changed = 0, handedOff = 0;

  for (const state of SYNC_STATES) {
    let pageCount = 1;
    for (let page = 0; page < Math.min(MAX_PAGES, pageCount); page++) {
      const result = await fetchStatePage(state, page);
      pageCount = Math.max(1, Math.min(MAX_PAGES, result.pageCount));
      for (const raw of result.orders) {
        const header = headerFromOrder(raw);
        if (!header.orderId || seen.has(header.orderId)) continue;
        seen.add(header.orderId);
        fetched++;
        const update = await applyHeader(header);
        touched += update.touched;
        changed += update.changed;
        if (header.state === 'KASPI_DELIVERY_TRANSIT') handedOff += update.touched;
      }
      if (!result.orders.length) break;
    }
  }

  return { seen, fetched, touched, changed, handedOff };
}

async function fetchExactOrderByCode(code) {
  if (!code) return null;
  const query = new URLSearchParams();
  query.set('page[number]', '0');
  query.set('page[size]', '20');
  query.set('filter[orders][code]', String(code));
  const data = await fetchJson(`${KASPI_API}/orders?${query.toString()}`);
  const exact = (Array.isArray(data?.data) ? data.data : []).filter(order =>
    String(order?.attributes?.code ?? order?.code ?? '').trim() === String(code).trim()
  );
  return exact.length === 1 ? exact[0] : null;
}

async function exactCandidates(seen) {
  const cutoff = Date.now() - EXACT_LOOKBACK_DAYS * 86_400_000;
  const result = await pool.query(`SELECT DISTINCT ON (order_id)
      order_id AS "orderId", code, status, state, updated_at AS "updatedAt"
    FROM marketplace_order_lines
    WHERE market='Kaspi' AND creation_date >= $1 AND COALESCE(code,'') <> ''
    ORDER BY order_id, updated_at ASC`, [cutoff]);

  return result.rows
    .filter(row => !seen.has(String(row.orderId)))
    .filter(row => !finalKaspiStatus(row.status))
    .sort((a, b) => Number(a.updatedAt || 0) - Number(b.updatedAt || 0))
    .slice(0, EXACT_LIMIT);
}

async function exactFallbackRefresh(seen) {
  const candidates = await exactCandidates(seen);
  let checked = 0, touched = 0, changed = 0;

  for (const stored of candidates) {
    let live = null;
    try { live = await fetchExactOrderByCode(stored.code); }
    catch (error) {
      console.warn('Kaspi exact order header refresh failed', String(error?.message || error));
      await sleep(BETWEEN_REQUESTS_MS);
      continue;
    }
    checked++;
    if (!live) {
      // Absence is never interpreted as cancellation.
      await sleep(BETWEEN_REQUESTS_MS);
      continue;
    }
    const header = headerFromOrder(live);
    if (!header.orderId || header.orderId !== String(stored.orderId) || header.code !== String(stored.code)) {
      await sleep(BETWEEN_REQUESTS_MS);
      continue;
    }
    const update = await applyHeader(header);
    touched += update.touched;
    changed += update.changed;
    await sleep(BETWEEN_REQUESTS_MS);
  }

  return { checked, touched, changed };
}

export async function refreshStaleKaspiReservationOrders() {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    if (!String(config.kaspiToken || '').trim()) {
      return { fetched: 0, touched: 0, changed: 0, exactChecked: 0 };
    }

    const broad = await broadHeaderRefresh();
    let exact = { checked: 0, touched: 0, changed: 0 };
    if (!lastExactAt || Date.now() - lastExactAt >= EXACT_INTERVAL_MS) {
      lastExactAt = Date.now();
      exact = await exactFallbackRefresh(broad.seen);
    }

    const summary = {
      fetched: broad.fetched,
      touched: broad.touched + exact.touched,
      changed: broad.changed + exact.changed,
      handedOff: broad.handedOff,
      exactChecked: exact.checked
    };
    console.log(`Kaspi order-header refresh: fetched=${summary.fetched} touched=${summary.touched} changed=${summary.changed} handedOff=${summary.handedOff} exact=${summary.exactChecked}`);
    return summary;
  })();

  try { return await refreshInFlight; }
  finally { refreshInFlight = null; }
}

export function startKaspiReservationRefreshLoop() {
  const run = () => refreshStaleKaspiReservationOrders().catch(error =>
    console.error('Kaspi order-header refresh loop failed', String(error?.message || error))
  );
  setTimeout(run, START_DELAY_MS).unref();
  const timer = setInterval(run, LOOP_INTERVAL_MS);
  timer.unref();
  return timer;
}
