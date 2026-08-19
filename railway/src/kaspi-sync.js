import { config } from './config.js';
import { pool } from './db.js';

const DEFAULT_KASPI_WORKER = 'https://fragrant-shadow-72ed.7masok.workers.dev';
const SYNC_INTERVAL_MS = 5 * 60 * 1000;
let syncInFlight = null;

function configuredWorkerBase() {
  return String(config.kaspiWorkerUrl || '').trim().replace(/\/$/, '');
}

function workerCandidates() {
  return [...new Set([configuredWorkerBase(), DEFAULT_KASPI_WORKER].filter(Boolean))];
}

function n(value, fallback = 0) {
  const x = Number(value);
  return Number.isFinite(x) ? x : fallback;
}

function ts(value) {
  if (value == null || value === '') return Date.now();
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric < 1e12 ? numeric * 1000 : numeric;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function normalizeLine(order, line, index) {
  const attrs = line?.attributes || line || {};
  const orderAttrs = order?.attributes || order || {};
  const sku = String(
    attrs.merchantCode ?? attrs.sku ?? attrs.code ?? attrs.offerCode ??
    line?.merchantCode ?? line?.sku ?? order?.merchantCode ?? order?.sku ?? ''
  ).trim();
  const qty = Math.max(1, n(attrs.quantity ?? attrs.qty ?? line?.quantity ?? line?.qty ?? 1, 1));
  const unitPrice = n(attrs.unitPrice ?? attrs.price ?? line?.unitPrice ?? line?.price ?? 0, 0);
  const totalPrice = n(attrs.totalPrice ?? line?.totalPrice ?? (unitPrice * qty), unitPrice * qty);
  return {
    entryId: String(line?.id ?? attrs.id ?? attrs.entryId ?? `${order?.id || orderAttrs.id || 'order'}-${index}`),
    sku,
    productName: String(attrs.productName ?? attrs.name ?? line?.productName ?? line?.name ?? ''),
    qty,
    unitPrice,
    totalPrice
  };
}

function normalizeOrder(raw) {
  const attrs = raw?.attributes || raw || {};
  const orderId = String(raw?.id ?? attrs.id ?? attrs.orderId ?? '');
  if (!orderId) return null;
  const code = String(attrs.code ?? raw?.code ?? orderId);
  const status = String(attrs.status ?? raw?.status ?? '');
  const state = String(attrs.state ?? raw?.state ?? '');
  const creationDate = ts(attrs.creationDate ?? attrs.createdAt ?? raw?.creationDate ?? raw?.createdAt);
  let lines = Array.isArray(raw?.lines) ? raw.lines : Array.isArray(attrs.lines) ? attrs.lines : [];
  if (!lines.length && Array.isArray(raw?.entries)) lines = raw.entries;
  const normalized = lines.map((line, i) => normalizeLine(raw, line, i)).filter(x => x.sku || x.productName);
  if (!normalized.length) {
    normalized.push({
      entryId: '__pending__', sku: '', productName: 'Состав загружается', qty: 0,
      unitPrice: 0, totalPrice: n(attrs.totalPrice ?? raw?.totalPrice ?? 0, 0)
    });
  }
  return { orderId, code, status, state, creationDate, lines: normalized, raw };
}

async function fetchFromWorker(base, batch, days) {
  const q = new URLSearchParams({ days: String(days), batch: String(batch), size: '100' });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  try {
    const response = await fetch(`${base}/kaspi/sync?${q.toString()}`, { headers: { Accept: 'application/json' }, signal: controller.signal });
    const text = await response.text();
    let data = {};
    try { data = JSON.parse(text); } catch {}
    if (!response.ok || data?.ok === false) throw new Error(data?.error || data?.message || `Kaspi Worker HTTP ${response.status}`);
    const orders = Array.isArray(data?.orders) ? data.orders : Array.isArray(data?.data) ? data.data : [];
    return { orders, meta: data?.meta || {}, upstream: base };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBatch(batch, days = 2) {
  const errors = [];
  for (const base of workerCandidates()) {
    try { return await fetchFromWorker(base, batch, days); }
    catch (error) { errors.push(`${base}: ${String(error?.message || error)}`); }
  }
  throw new Error(errors.join(' | ') || 'Kaspi Worker is unavailable');
}

async function upsertOrder(order) {
  const now = Date.now();
  for (const line of order.lines) {
    await pool.query(`INSERT INTO marketplace_order_lines
      (market,order_id,code,entry_id,status,state,creation_date,sku,product_name,qty,unit_price,total_price,seller_delivery_cost,marketplace_fee,fee_source,raw_json,first_seen_at,updated_at)
      VALUES('Kaspi',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,0,0,'',$12,$13,$13)
      ON CONFLICT(market,order_id,entry_id) DO UPDATE SET
        code=excluded.code,status=excluded.status,state=excluded.state,creation_date=excluded.creation_date,
        sku=excluded.sku,product_name=excluded.product_name,qty=excluded.qty,unit_price=excluded.unit_price,
        total_price=excluded.total_price,raw_json=excluded.raw_json,updated_at=excluded.updated_at`, [
      order.orderId, order.code, line.entryId, order.status, order.state, order.creationDate,
      line.sku, line.productName, line.qty, line.unitPrice, line.totalPrice,
      JSON.stringify(order.raw || {}), now
    ]);
  }
  if (order.lines.some(line => line.entryId !== '__pending__')) {
    await pool.query("DELETE FROM marketplace_order_lines WHERE market='Kaspi' AND order_id=$1 AND entry_id='__pending__'", [order.orderId]);
  }
}

export async function syncKaspiOrders({ days = 2 } = {}) {
  if (syncInFlight) return syncInFlight;
  syncInFlight = (async () => {
    const startedAt = Date.now();
    const run = await pool.query("INSERT INTO sync_runs(market,started_at,ok,items,error) VALUES('Kaspi',$1,0,0,'') RETURNING id", [startedAt]);
    const runId = run.rows[0].id;
    let items = 0;
    let upstream = '';
    try {
      let pageCount = 1;
      for (let batch = 0; batch < Math.min(10, pageCount); batch++) {
        const page = await fetchBatch(batch, days);
        upstream = page.upstream || upstream;
        pageCount = Math.max(1, Math.min(10, n(page.meta?.pageCount ?? page.meta?.totalPages ?? 1, 1)));
        for (const raw of page.orders) {
          const order = normalizeOrder(raw);
          if (!order) continue;
          await upsertOrder(order);
          items += order.lines.filter(line => line.entryId !== '__pending__').length || 1;
        }
        if (!page.orders.length) break;
      }
      const finishedAt = Date.now();
      await pool.query('UPDATE sync_runs SET finished_at=$1,ok=1,items=$2,error=\'\' WHERE id=$3', [finishedAt, items, runId]);
      return { ok: true, items, finishedAt, upstream };
    } catch (error) {
      const message = String(error?.message || error).slice(0, 1000);
      await pool.query('UPDATE sync_runs SET finished_at=$1,ok=0,items=$2,error=$3 WHERE id=$4', [Date.now(), items, message, runId]).catch(() => {});
      const wrapped = new Error(message);
      wrapped.status = 502;
      throw wrapped;
    }
  })();
  try { return await syncInFlight; } finally { syncInFlight = null; }
}

export function startKaspiSyncLoop() {
  const run = () => syncKaspiOrders({ days: 2 }).catch(error => console.error('Kaspi background sync failed', error));
  setTimeout(run, 2_000).unref();
  const timer = setInterval(run, SYNC_INTERVAL_MS);
  timer.unref();
  return timer;
}
