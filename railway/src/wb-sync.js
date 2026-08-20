import { config } from './config.js';
import { pool } from './db.js';

const DEFAULT_WB_WORKER = 'https://wb-sync.7masok.workers.dev';
const WB_ORDERS_URL = 'https://statistics-api.wildberries.ru/api/v1/supplier/orders';
const SYNC_INTERVAL_MS = 30 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30_000;
let syncInFlight = null;

function baseUrl() {
  return String(config.wbWorkerUrl || DEFAULT_WB_WORKER).trim().replace(/\/$/, '');
}

function n(value, fallback = 0) {
  const x = Number(value);
  return Number.isFinite(x) ? x : fallback;
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
    src.merchantCode ?? src.sku ?? src.article ?? src.vendorCode ?? src.supplierArticle ?? src.nmId ??
    order?.merchantCode ?? order?.sku ?? order?.article ?? order?.vendorCode ?? order?.supplierArticle ?? order?.nmId ?? ''
  ).trim();
  const qty = Math.max(1, n(src.quantity ?? src.qty ?? order?.quantity ?? order?.qty ?? 1, 1));
  const explicitTotal = n(src.totalPrice ?? order?.totalPrice ?? 0, 0);
  const unitPrice = n(
    src.unitPrice ?? src.convertedFinalPrice ?? src.convertedPrice ?? src.finalPrice ?? src.finishedPrice ?? src.priceWithDisc ?? src.price ??
    order?.unitPrice ?? order?.convertedFinalPrice ?? order?.convertedPrice ?? order?.finalPrice ?? order?.finishedPrice ?? order?.priceWithDisc ?? order?.price ??
    (qty ? explicitTotal / qty : 0), 0
  );
  return {
    entryId: String(src.entryId ?? src.id ?? src.srid ?? order?.entryId ?? order?.id ?? order?.srid ?? `${order?.orderId || order?.orderUid || 'wb'}-${index}`),
    sku,
    productName: String(src.productName ?? src.name ?? src.subject ?? order?.productName ?? order?.name ?? order?.subject ?? ''),
    qty,
    unitPrice,
    totalPrice: explicitTotal || unitPrice * qty
  };
}

function normalizeOrder(raw, index) {
  const orderId = String(raw?.gNumber ?? raw?.orderId ?? raw?.id ?? raw?.orderUid ?? raw?.rid ?? raw?.srid ?? '').trim();
  if (!orderId) return null;
  const lines = Array.isArray(raw?.lines) && raw.lines.length ? raw.lines : [raw];
  const market = normalizeMarket(raw?.market ?? raw?.account ?? raw?.seller ?? raw?.cabinet ?? raw?.shop);
  const cancelled = raw?.isCancel === true || raw?.isCancel === 1 || raw?.isCancel === 'true';
  return {
    market,
    orderId,
    code: String(raw?.gNumber ?? raw?.orderNumber ?? raw?.code ?? raw?.orderUid ?? raw?.rid ?? raw?.srid ?? raw?.id ?? orderId),
    status: String(raw?.status ?? raw?.supplierStatus ?? raw?.wbStatus ?? (cancelled ? 'CANCELLED' : 'NEW')),
    state: String(raw?.state ?? raw?.deliveryType ?? raw?.warehouseType ?? raw?.warehouseName ?? 'FBS'),
    creationDate: ts(raw?.creationDate ?? raw?.createdAt ?? raw?.date ?? raw?.lastChangeDate),
    lines: lines.map((line, i) => normalizeLine(raw, line, i)).filter(Boolean),
    raw,
    index
  };
}

async function fetchJson(url, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { cache: 'no-store', headers: { Accept: 'application/json', ...headers }, signal: controller.signal });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch {}
    if (!response.ok) {
      const detail = data?.detail || data?.error || data?.message || text || response.statusText;
      throw new Error(`WB ${response.status}: ${String(detail).slice(0, 700)}`);
    }
    return data;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`WB timeout after ${FETCH_TIMEOUT_MS / 1000}s`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOfficialAccount(token, market, days) {
  const dateFrom = new Date(Date.now() - Math.max(1, days) * 24 * 60 * 60 * 1000).toISOString();
  const url = `${WB_ORDERS_URL}?dateFrom=${encodeURIComponent(dateFrom)}&flag=0`;
  const data = await fetchJson(url, { Authorization: token });
  if (!Array.isArray(data)) throw new Error(`WB ${market} returned an unexpected payload`);
  return data.map(row => ({ ...row, market }));
}

async function fetchOfficialWb(days) {
  const accounts = [
    { token: String(config.wbToken || '').trim(), market: 'WB' },
    { token: String(config.wbToken2 || '').trim(), market: 'WB2' }
  ].filter(x => x.token);
  if (!accounts.length) return null;

  const combined = [];
  for (const account of accounts) {
    const rows = await fetchOfficialAccount(account.token, account.market, days);
    combined.push(...rows);
  }
  return combined;
}

async function fetchWorker(days) {
  const url = `${baseUrl()}/wb/sync?days=${encodeURIComponent(days)}`;
  const data = await fetchJson(url);
  if (data?.ok === false) throw new Error(data?.error || data?.message || 'WB Worker failed');
  return data;
}

async function upsertOrder(order) {
  const now = Date.now();
  for (const line of order.lines) {
    await pool.query(
      'DELETE FROM marketplace_order_lines WHERE market=$1 AND entry_id=$2 AND order_id<>$3',
      [order.market, line.entryId, order.orderId]
    );
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

async function createRun(market) {
  const r = await pool.query("INSERT INTO sync_runs(market,started_at,ok,items,error) VALUES($1,$2,0,0,'') RETURNING id", [market, Date.now()]);
  return r.rows[0].id;
}

async function persistPayload(payload, source = 'WB') {
  const rows = pickOrders(payload);
  if (!rows.length) return { ok: true, finishedAt: Date.now(), newestOrderAt: 0, markets: {}, upstream: source };
  const runs = new Map();
  const counts = new Map();
  let newestOrderAt = 0;
  try {
    for (let i = 0; i < rows.length; i++) {
      const order = normalizeOrder(rows[i], i);
      if (!order) continue;
      if (!runs.has(order.market)) runs.set(order.market, await createRun(order.market));
      await upsertOrder(order);
      counts.set(order.market, (counts.get(order.market) || 0) + Math.max(1, order.lines.length));
      newestOrderAt = Math.max(newestOrderAt, Number(order.creationDate) || 0);
    }
    const finishedAt = Date.now();
    for (const [market, runId] of runs) {
      await pool.query("UPDATE sync_runs SET finished_at=$1,ok=1,items=$2,error='' WHERE id=$3", [finishedAt, counts.get(market) || 0, runId]);
    }
    return { ok: true, finishedAt, newestOrderAt, markets: Object.fromEntries(counts), upstream: source };
  } catch (error) {
    const message = String(error?.message || error).slice(0, 1000);
    if (!runs.size) runs.set('WB', await createRun('WB'));
    for (const [, runId] of runs) {
      await pool.query('UPDATE sync_runs SET finished_at=$1,ok=0,error=$2 WHERE id=$3', [Date.now(), message, runId]).catch(() => {});
    }
    throw error;
  }
}

export async function importWbPayload(payload) {
  return persistPayload(payload, 'WB Worker via browser fallback');
}

export async function syncWbOrders({ days = 2 } = {}) {
  if (syncInFlight) return syncInFlight;
  syncInFlight = (async () => {
    try {
      const direct = await fetchOfficialWb(days);
      if (direct) return await persistPayload(direct, 'Wildberries official API');
      const payload = await fetchWorker(days);
      return await persistPayload(payload, baseUrl());
    } catch (error) {
      const wrapped = new Error(String(error?.message || error).slice(0, 1000));
      wrapped.status = 502;
      throw wrapped;
    }
  })();
  try { return await syncInFlight; } finally { syncInFlight = null; }
}

export function startWbSyncLoop() {
  const run = () => syncWbOrders({ days: 2 }).catch(error => console.error('WB background sync failed', error));
  setTimeout(run, 4_000).unref();
  const timer = setInterval(run, SYNC_INTERVAL_MS);
  timer.unref();
  return timer;
}
