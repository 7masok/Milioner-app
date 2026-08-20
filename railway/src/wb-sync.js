import { config } from './config.js';
import { pool, transaction } from './db.js';

const DEFAULT_WB_WORKER = 'https://wb-sync.7masok.workers.dev';
const WB_NEW_ORDERS_URL = 'https://marketplace-api.wildberries.ru/api/v3/orders/new';
const SYNC_INTERVAL_MS = 60 * 1000;
const STARTUP_SYNC_DELAY_MS = 3 * 1000;
const FETCH_TIMEOUT_MS = 20_000;
let syncInFlight = null;
const retryAtByMarket = new Map();

function baseUrl() {
  return String(config.wbWorkerUrl || DEFAULT_WB_WORKER).trim().replace(/\/$/, '');
}

function n(value, fallback = 0) {
  const x = Number(value);
  return Number.isFinite(x) ? x : fallback;
}

function money100(value, fallback = 0) {
  const x = Number(value);
  return Number.isFinite(x) ? x / 100 : fallback;
}

function ts(value) {
  if (value == null || value === '') return Date.now();
  const num = Number(value);
  if (Number.isFinite(num) && num > 0) return num < 1e12 ? num * 1000 : num;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function normalizeMarket(value) {
  const s = String(value || '').trim().toUpperCase();
  if (s === 'WB2' || s.includes('WB 2') || s.includes('WB_2')) return 'WB2';
  return 'WB';
}

function pickOrders(data) {
  if (Array.isArray(data)) return data;
  for (const key of ['orders', 'data', 'items', 'result']) {
    if (Array.isArray(data?.[key])) return data[key];
  }
  const combined = [];
  if (Array.isArray(data?.wb)) combined.push(...data.wb.map(x => ({ ...x, market: x?.market || 'WB' })));
  if (Array.isArray(data?.wb2)) combined.push(...data.wb2.map(x => ({ ...x, market: x?.market || 'WB2' })));
  return combined;
}

function normalizeLine(order, line, index) {
  const src = line || {};
  const sku = String(
    src.article ?? src.vendorCode ?? src.supplierArticle ?? src.merchantCode ?? src.sku ??
    order?.article ?? order?.vendorCode ?? order?.supplierArticle ?? order?.merchantCode ?? order?.sku ??
    src.nmId ?? order?.nmId ?? ''
  ).trim();
  const qty = Math.max(1, n(src.quantity ?? src.qty ?? order?.quantity ?? order?.qty ?? 1, 1));
  const marketplacePrice = src.convertedFinalPrice ?? order?.convertedFinalPrice ?? src.finalPrice ?? order?.finalPrice;
  const legacyPrice = src.unitPrice ?? src.priceWithDisc ?? src.finishedPrice ?? order?.unitPrice ?? order?.priceWithDisc ?? order?.finishedPrice;
  const unitPrice = marketplacePrice != null ? money100(marketplacePrice, 0) : n(legacyPrice ?? src.price ?? order?.price ?? 0, 0);
  const explicitTotal = n(src.totalPrice ?? order?.totalPrice ?? 0, 0);
  return {
    entryId: String(src.id ?? order?.id ?? src.entryId ?? src.srid ?? order?.entryId ?? order?.srid ?? `${order?.orderId || order?.orderUid || 'wb'}-${index}`),
    sku,
    productName: String(src.productName ?? src.name ?? src.subject ?? order?.productName ?? order?.name ?? order?.subject ?? ''),
    qty,
    unitPrice,
    totalPrice: explicitTotal || unitPrice * qty
  };
}

function normalizeOrder(raw, index) {
  const orderId = String(raw?.id ?? raw?.orderId ?? raw?.orderID ?? raw?.orderUid ?? raw?.gNumber ?? raw?.rid ?? raw?.srid ?? '').trim();
  if (!orderId) return null;
  const lines = Array.isArray(raw?.lines) && raw.lines.length ? raw.lines : [raw];
  const market = normalizeMarket(raw?.market ?? raw?.account ?? raw?.seller ?? raw?.cabinet ?? raw?.shop);
  const cancelled = raw?.isCancel === true || raw?.isCancel === 1 || raw?.isCancel === 'true';
  return {
    market,
    orderId,
    code: String(raw?.id ?? raw?.orderId ?? raw?.orderID ?? raw?.orderNumber ?? raw?.code ?? orderId),
    status: String(raw?.supplierStatus ?? raw?.status ?? raw?.wbStatus ?? (cancelled ? 'CANCELLED' : 'NEW')),
    state: String(raw?.deliveryType ?? raw?.state ?? raw?.warehouseType ?? raw?.warehouseName ?? 'FBS'),
    creationDate: ts(raw?.createdAt ?? raw?.creationDate ?? raw?.date ?? raw?.lastChangeDate),
    lines: lines.map((line, i) => normalizeLine(raw, line, i)).filter(Boolean),
    raw,
    index
  };
}

function retryAtFromHeader(value) {
  const raw = String(value || '').trim();
  if (!raw) return Date.now() + 60_000;
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) {
    if (numeric > 1e12) return numeric;
    if (numeric > 1e9) return numeric * 1000;
    return Date.now() + numeric * 1000;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : Date.now() + 60_000;
}

async function fetchJson(url, headers = {}, market = 'WB') {
  const retryAt = Number(retryAtByMarket.get(market) || 0);
  if (Date.now() < retryAt) {
    const seconds = Math.max(1, Math.ceil((retryAt - Date.now()) / 1000));
    const error = new Error(`WB ${market} 429: retry in ${seconds}s`);
    error.status = 429;
    error.retryAt = retryAt;
    throw error;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { cache: 'no-store', headers: { Accept: 'application/json', ...headers }, signal: controller.signal });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch {}
    if (response.status === 429) {
      const next = retryAtFromHeader(response.headers.get('x-ratelimit-retry') || response.headers.get('retry-after'));
      retryAtByMarket.set(market, next);
      const seconds = Math.max(1, Math.ceil((next - Date.now()) / 1000));
      const detail = data?.detail || data?.error || data?.message || text || 'rate limit exceeded';
      const error = new Error(`WB ${market} 429: ${String(detail).slice(0, 400)}; retry in ${seconds}s`);
      error.status = 429;
      error.retryAt = next;
      throw error;
    }
    if (!response.ok) {
      const detail = data?.detail || data?.error || data?.message || text || response.statusText;
      const error = new Error(`WB ${market} ${response.status}: ${String(detail).slice(0, 700)}`);
      error.status = response.status;
      throw error;
    }
    retryAtByMarket.delete(market);
    return data;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`WB ${market} timeout after ${FETCH_TIMEOUT_MS / 1000}s`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchMarketplaceAccount(token, market) {
  const data = await fetchJson(WB_NEW_ORDERS_URL, { Authorization: token }, market);
  if (!Array.isArray(data?.orders)) throw new Error(`WB ${market} returned an unexpected Marketplace payload`);
  return data.orders.map(row => ({ ...row, market }));
}

async function upsertOrder(order) {
  const now = Date.now();
  for (const line of order.lines) {
    await pool.query('DELETE FROM marketplace_order_lines WHERE market=$1 AND entry_id=$2 AND order_id<>$3', [order.market, line.entryId, order.orderId]);
    await pool.query(`INSERT INTO marketplace_order_lines
      (market,order_id,code,entry_id,status,state,creation_date,sku,product_name,qty,unit_price,total_price,seller_delivery_cost,marketplace_fee,fee_source,raw_json,first_seen_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,0,0,'',$13,$14,$14)
      ON CONFLICT(market,order_id,entry_id) DO UPDATE SET
        code=excluded.code,status=excluded.status,state=excluded.state,creation_date=excluded.creation_date,
        sku=excluded.sku,product_name=excluded.product_name,qty=excluded.qty,unit_price=excluded.unit_price,
        total_price=excluded.total_price,raw_json=excluded.raw_json,updated_at=excluded.updated_at`, [
      order.market, order.orderId, order.code, line.entryId, order.status, order.state, order.creationDate,
      line.sku, line.productName, line.qty, line.unitPrice, line.totalPrice, JSON.stringify(order.raw || {}), now
    ]);
  }
}

async function cleanRecentLegacyStatisticsRows(market) {
  const cutoff = Date.now() - 3 * 24 * 60 * 60 * 1000;
  const result = await pool.query(`DELETE FROM marketplace_order_lines
    WHERE market=$1 AND creation_date >= $2
      AND raw_json::jsonb ? 'gNumber'
      AND NOT (raw_json::jsonb ? 'id')`, [market, cutoff]);
  if (result.rowCount) console.log(`WB ${market}: removed ${result.rowCount} recent legacy statistics rows`);
}

async function reconcileWarehouseReservations(market, rows) {
  const currentKeys = new Set();
  for (let i = 0; i < rows.length; i++) {
    const order = normalizeOrder({ ...rows[i], market }, i);
    if (!order) continue;
    for (const line of order.lines) currentKeys.add(`${market}:${order.orderId}:${line.entryId}`);
  }

  // Use the same transaction lock as the normal warehouse PUT. This prevents
  // a background WB reconciliation from writing an older snapshot over a
  // manual warehouse edit made at the same time.
  return transaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [730021]);
    const current = await client.query('SELECT payload,revision FROM warehouse_state WHERE id=1 FOR UPDATE');
    if (!current.rowCount) return 0;
    let state = {};
    try { state = JSON.parse(String(current.rows[0].payload || '{}')); } catch { return 0; }
    if (!Array.isArray(state.reservations)) return 0;
    let changed = 0;
    const now = Date.now();
    for (const reservation of state.reservations) {
      if (!reservation?.active || String(reservation.source || '') !== market) continue;
      const key = String(reservation.externalKey || '');
      if (!currentKeys.has(key)) {
        reservation.active = false;
        reservation.updatedAt = now;
        reservation.closedReason = 'wb-not-in-current-new-orders';
        changed++;
      }
    }
    if (!changed) return 0;
    const revision = Number(current.rows[0].revision || 0) + 1;
    await client.query('UPDATE warehouse_state SET payload=$1,revision=$2,updated_at=$3 WHERE id=1', [JSON.stringify(state), revision, now]);
    console.log(`WB ${market}: deactivated ${changed} stale warehouse reservations`);
    return changed;
  });
}

async function createRun(market) {
  const r = await pool.query("INSERT INTO sync_runs(market,started_at,ok,items,error) VALUES($1,$2,0,0,'') RETURNING id", [market, Date.now()]);
  return r.rows[0].id;
}

async function persistAccountRows(rows, market, source) {
  const runId = await createRun(market);
  let count = 0;
  let newestOrderAt = 0;
  try {
    for (let i = 0; i < rows.length; i++) {
      const order = normalizeOrder({ ...rows[i], market }, i);
      if (!order) continue;
      await upsertOrder(order);
      count += Math.max(1, order.lines.length);
      newestOrderAt = Math.max(newestOrderAt, Number(order.creationDate) || 0);
    }
    if (source.startsWith('Wildberries Marketplace API')) {
      await cleanRecentLegacyStatisticsRows(market);
      await reconcileWarehouseReservations(market, rows);
    }
    const finishedAt = Date.now();
    await pool.query("UPDATE sync_runs SET finished_at=$1,ok=1,items=$2,error='' WHERE id=$3", [finishedAt, count, runId]);
    console.log(`WB realtime sync OK ${market}: ${count} items, newest=${newestOrderAt || 0}`);
    return { ok: true, market, finishedAt, newestOrderAt, items: count, upstream: source };
  } catch (error) {
    await pool.query('UPDATE sync_runs SET finished_at=$1,ok=0,error=$2 WHERE id=$3', [Date.now(), String(error?.message || error).slice(0, 1000), runId]).catch(() => {});
    throw error;
  }
}

async function recordFailedRun(market, error) {
  const runId = await createRun(market);
  await pool.query('UPDATE sync_runs SET finished_at=$1,ok=0,error=$2 WHERE id=$3', [Date.now(), String(error?.message || error).slice(0, 1000), runId]).catch(() => {});
}

async function fetchWorker(days) {
  const url = `${baseUrl()}/wb/sync?days=${encodeURIComponent(days)}`;
  return fetchJson(url, {}, 'WB');
}

export async function importWbPayload(payload) {
  const rows = pickOrders(payload);
  const grouped = new Map();
  for (const raw of rows) {
    const market = normalizeMarket(raw?.market);
    if (!grouped.has(market)) grouped.set(market, []);
    grouped.get(market).push(raw);
  }
  const results = [];
  for (const [market, marketRows] of grouped) results.push(await persistAccountRows(marketRows, market, 'WB Worker via browser fallback'));
  return { ok: true, results };
}

export async function syncWbOrders({ days = 2 } = {}) {
  if (syncInFlight) return syncInFlight;
  syncInFlight = (async () => {
    const accounts = [
      { token: String(config.wbToken || '').trim(), market: 'WB' },
      { token: String(config.wbToken2 || '').trim(), market: 'WB2' }
    ].filter(x => x.token);
    if (!accounts.length) {
      const payload = await fetchWorker(days);
      return importWbPayload(payload);
    }
    const results = [];
    let firstError = null;
    for (const account of accounts) {
      try {
        const rows = await fetchMarketplaceAccount(account.token, account.market);
        results.push(await persistAccountRows(rows, account.market, 'Wildberries Marketplace API /api/v3/orders/new'));
      } catch (error) {
        await recordFailedRun(account.market, error).catch(() => {});
        firstError ||= error;
        results.push({ ok: false, market: account.market, error: String(error?.message || error) });
      }
    }
    if (results.some(x => x.ok)) return { ok: true, results };
    const wrapped = new Error(String(firstError?.message || 'WB sync failed').slice(0, 1000));
    wrapped.status = Number(firstError?.status) || 502;
    if (firstError?.retryAt) wrapped.retryAt = firstError.retryAt;
    throw wrapped;
  })();
  try { return await syncInFlight; } finally { syncInFlight = null; }
}

export function startWbSyncLoop() {
  const run = () => syncWbOrders({ days: 2 }).catch(error => console.error('WB background sync failed', error));
  setTimeout(run, STARTUP_SYNC_DELAY_MS).unref();
  const timer = setInterval(run, SYNC_INTERVAL_MS);
  timer.unref();
  return timer;
}
