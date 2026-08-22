import { pool } from './db.js';
import { config } from './config.js';
import { reconcileWbReservations } from './reservation-reconcile.js';

const WB_API = 'https://marketplace-api.wildberries.ru';
const SYNC_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 25_000;
const LOOKBACK_DAYS = 14;
const inFlight = new Map();

function tokenFor(market) {
  return String(market === 'WB2' ? config.wbToken2 : config.wbToken || '').trim();
}

function timestamp(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric < 1e12 ? numeric * 1000 : numeric;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : Date.now();
}

async function requestJson(url, options, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch {}
    if (!response.ok) {
      const detail = String(data?.message || data?.errorText || data?.error || data?.detail || '').trim();
      const error = new Error(`${label} HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
      error.status = response.status;
      throw error;
    }
    return data || {};
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOrders(market, token) {
  const headers = { Accept: 'application/json', Authorization: token };
  const from = Math.floor((Date.now() - LOOKBACK_DAYS * 86_400_000) / 1000);
  const orders = [];
  let next = 0;
  for (let page = 0; page < 10; page++) {
    const data = await requestJson(`${WB_API}/api/v3/orders?limit=1000&next=${next}&dateFrom=${from}`, { headers }, 'WB Marketplace orders');
    const batch = Array.isArray(data.orders) ? data.orders : [];
    orders.push(...batch);
    const later = Number(data.next || 0);
    if (!batch.length || !later || later === next) break;
    next = later;
  }
  const statuses = new Map();
  const ids = orders.map(order => Number(order?.id)).filter(Number.isFinite);
  for (let start = 0; start < ids.length; start += 1000) {
    const data = await requestJson(`${WB_API}/api/v3/orders/status`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ orders: ids.slice(start, start + 1000) })
    }, 'WB Marketplace statuses');
    for (const status of data?.orders || []) statuses.set(Number(status?.id), status);
  }
  return orders.map((order, index) => {
    const status = statuses.get(Number(order?.id)) || {};
    const price = (Number(order?.convertedFinalPrice ?? order?.finalPrice ?? order?.convertedPrice ?? order?.price ?? 0) || 0) / 100;
    const orderId = String(order?.id ?? order?.orderUid ?? `wb-${index}`);
    return {
      orderId, code: String(order?.id ?? order?.orderUid ?? orderId), entryId: orderId,
      // Missing status is deliberately kept empty. The reservation reconciler
      // requires explicit WB statuses and must not turn a failed/missing status
      // lookup into a phantom active reservation.
      status: String(status?.supplierStatus || '').trim(), state: String(status?.wbStatus || '').trim(),
      creationDate: timestamp(order?.createdAt), sku: String(order?.article ?? order?.nmId ?? order?.skus?.[0] ?? '').trim(),
      productName: String(order?.article || order?.subject || order?.nmId || ''), qty: 1, unitPrice: price, totalPrice: price, raw: { order, status }
    };
  });
}

async function upsert(market, rows) {
  if (!rows.length) return;
  const now = Date.now();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const row of rows) await client.query(`INSERT INTO marketplace_order_lines
      (market,order_id,code,entry_id,status,state,creation_date,sku,product_name,qty,unit_price,total_price,seller_delivery_cost,marketplace_fee,fee_source,raw_json,first_seen_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,0,0,'',$13,$14,$14)
      ON CONFLICT(market,order_id,entry_id) DO UPDATE SET
        code=excluded.code,status=excluded.status,state=excluded.state,creation_date=excluded.creation_date,sku=excluded.sku,
        product_name=excluded.product_name,qty=excluded.qty,unit_price=excluded.unit_price,total_price=excluded.total_price,
        raw_json=excluded.raw_json,updated_at=excluded.updated_at`, [
      market, row.orderId, row.code, row.entryId, row.status, row.state, row.creationDate, row.sku,
      row.productName, row.qty, row.unitPrice, row.totalPrice, JSON.stringify(row.raw), now
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function syncWbOrders(market, { force = false } = {}) {
  if (!['WB', 'WB2'].includes(market)) throw new Error('Unsupported WB market');
  if (inFlight.has(market)) return inFlight.get(market);
  const task = (async () => {
    const token = tokenFor(market);
    if (!token) return { ok: false, market, skipped: true, error: `${market === 'WB2' ? 'WB_TOKEN_2' : 'WB_TOKEN'} is not configured` };
    const prior = await pool.query('SELECT * FROM sync_runs WHERE market=$1 ORDER BY id DESC LIMIT 1', [market]);
    const previous = prior.rows[0], now = Date.now();
    if (!force && previous?.started_at && now - Number(previous.started_at) < SYNC_MS) {
      return { ok: Number(previous.ok) === 1, market, skipped: true, nextSyncAt: Number(previous.started_at) + SYNC_MS, error: String(previous.error || '') };
    }
    const created = await pool.query("INSERT INTO sync_runs(market,started_at,ok,items,error) VALUES($1,$2,0,0,'') RETURNING id", [market, now]);
    const runId = created.rows[0].id;
    try {
      const rows = await fetchOrders(market, token);
      await upsert(market, rows);
      let reservationReconcile = null;
      try {
        reservationReconcile = await reconcileWbReservations(market, now);
      } catch (error) {
        console.error(`WB reservation reconciliation failed (${market})`, error);
      }
      const finishedAt = Date.now();
      await pool.query("UPDATE sync_runs SET finished_at=$1,ok=1,items=$2,error='' WHERE id=$3", [finishedAt, rows.length, runId]);
      return { ok: true, market, items: rows.length, reservationReconcile, finishedAt, nextSyncAt: finishedAt + SYNC_MS };
    } catch (error) {
      const message = String(error?.message || error).slice(0, 2000);
      await pool.query('UPDATE sync_runs SET finished_at=$1,ok=0,error=$2 WHERE id=$3', [Date.now(), message, runId]).catch(() => {});
      throw error;
    }
  })();
  inFlight.set(market, task);
  try { return await task; } finally { inFlight.delete(market); }
}

export function startWbSyncLoop() {
  const run = async (force = false) => {
    await Promise.all(
      ['WB', 'WB2'].map(async (market) => {
        try {
          await syncWbOrders(market, { force });
        } catch (error) {
          console.error(`WB background sync failed (${market})`, error);
        }
      })
    );
  };
  void run(true);
  const timer = setInterval(run, SYNC_MS);
  timer.unref();
  return timer;
}
