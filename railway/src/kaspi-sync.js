import { config } from './config.js';
import { pool } from './db.js';
import { credentialFor } from './connections.js';
import { kaspiOrderIsActive } from './kaspi-status.js';
import { reconcileKaspiReservations } from './reservation-reconcile.js';
import { reconcileMarketplaceSales } from './marketplace-sale-reconcile.js';

const KASPI_API = 'https://kaspi.kz/shop/api/v2';
const SYNC_INTERVAL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20_000;
const STALE_RUN_MS = 3 * 60 * 1000;
const MAX_BATCHES = 3;
const MAX_DIRECT_ORDERS = 240;
const ACTIVE_LOOKBACK_DAYS = 14;
const MAX_ACTIVE_PAGES_PER_STATE = 30;
const PENDING_COMPOSITION_LOOKBACK_DAYS = 30;
const PENDING_COMPOSITION_RETRY_MS = 6 * 60 * 60 * 1000;
const MAX_PENDING_COMPOSITION_ORDERS = 25;
const ACTIVE_CANDIDATE_STATES = Object.freeze(['KASPI_DELIVERY', 'NEW', 'SIGN_REQUIRED', 'PICKUP']);
// Kaspi Pay includes every sale, not only Kaspi Delivery. Keep every order
// state in the Railway collector so pickup and seller-delivery sales do not
// disappear from the warehouse report.
const DIRECT_ORDER_STATES = Object.freeze([
  // Active Kaspi Delivery orders must be refreshed before the global safety
  // cap is reached; otherwise transmitted orders keep their old packing state.
  'KASPI_DELIVERY', 'NEW', 'SIGN_REQUIRED', 'PICKUP', 'DELIVERY', 'ARCHIVE'
]);
let syncInFlight = null;

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
  const totalPrice = n(attrs.totalPrice ?? line?.totalPrice ?? 0, 0);
  const unitPrice = n(attrs.unitPrice ?? attrs.price ?? attrs.basePrice ?? line?.unitPrice ?? line?.price ?? (qty ? totalPrice / qty : 0), 0);
  return {
    entryId: String(line?.id ?? attrs.id ?? attrs.entryId ?? `${order?.id || orderAttrs.id || 'order'}-${index}`),
    sku,
    productName: String(attrs.productName ?? attrs.name ?? line?.productName ?? line?.name ?? ''),
    qty,
    unitPrice,
    totalPrice: totalPrice || unitPrice * qty
  };
}

function normalizeOrder(raw) {
  const attrs = raw?.attributes || raw || {};
  const orderId = String(raw?.id ?? attrs.id ?? attrs.orderId ?? '');
  if (!orderId) return null;
  const code = String(attrs.code ?? raw?.code ?? orderId);
  const status = String(attrs.status ?? raw?.status ?? '');
  const sourceState = String(attrs.state ?? raw?.state ?? '');
  const kaspiDelivery = attrs.kaspiDelivery || raw?.kaspiDelivery || {};
  const courierTransmissionDate = n(
    kaspiDelivery?.courierTransmissionDate ?? attrs.courierTransmissionDate ?? raw?.courierTransmissionDate ?? 0,
    0
  );
  const assembled = Boolean(attrs.assembled ?? raw?.assembled ?? false);
  const state = sourceState === 'KASPI_DELIVERY'
    ? (courierTransmissionDate > 0 ? 'KASPI_DELIVERY_TRANSIT' : assembled ? 'KASPI_DELIVERY_ASSEMBLED' : sourceState)
    : sourceState;
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
  return { orderId, code, status, state, creationDate, courierTransmissionDate, lines: normalized, raw };
}

async function fetchJson(url, options = {}, label = 'request') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch {}
    if (!response.ok) throw new Error(data?.message || data?.error || `${label} HTTP ${response.status}`);
    return data;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`${label} timeout after ${FETCH_TIMEOUT_MS / 1000}s`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function kaspiHeaders() {
  const token = await credentialFor('Kaspi', config.kaspiToken);
  if (!token) throw new Error('KASPI_TOKEN is not configured on Railway');
  return {
    Accept: 'application/vnd.api+json',
    'Content-Type': 'application/vnd.api+json',
    'X-Auth-Token': token
  };
}

async function directOrderPage({ days, state, page }) {
  const end = Date.now();
  const start = end - Math.max(1, Number(days) || 2) * 86_400_000;
  const q = new URLSearchParams();
  q.set('page[number]', String(page));
  q.set('page[size]', '100');
  q.set('filter[orders][creationDate][$ge]', String(start));
  q.set('filter[orders][creationDate][$le]', String(end));
  if (state) q.set('filter[orders][state]', state);
  const data = await fetchJson(`${KASPI_API}/orders?${q.toString()}`, { headers: await kaspiHeaders() }, 'Kaspi orders');
  return {
    orders: Array.isArray(data?.data) ? data.data : [],
    pageCount: Math.max(1, n(data?.meta?.pageCount ?? data?.meta?.totalPages ?? 1, 1))
  };
}

async function directOrderLines(order, productCache) {
  const orderId = String(order?.id || '').trim();
  if (!orderId) return [];
  const entries = await fetchJson(`${KASPI_API}/orders/${encodeURIComponent(orderId)}/entries`, { headers: await kaspiHeaders() }, 'Kaspi order entries');
  const lines = [];
  for (const entry of Array.isArray(entries?.data) ? entries.data : []) {
    const attrs = entry?.attributes || {};
    const masterProductId = String(entry?.relationships?.product?.data?.id || '').trim();
    let product = productCache.get(masterProductId) || null;
    if (masterProductId && product === undefined) product = null;
    if (masterProductId && !productCache.has(masterProductId)) {
      try {
        const data = await fetchJson(`${KASPI_API}/masterproducts/${encodeURIComponent(masterProductId)}/merchantProduct`, { headers: await kaspiHeaders() }, 'Kaspi merchant product');
        product = {
          code: String(data?.data?.attributes?.code || '').trim(),
          name: String(data?.data?.attributes?.name || '').trim()
        };
      } catch {
        product = { code: '', name: '' };
      }
      productCache.set(masterProductId, product);
    }
    const qty = Math.max(1, n(attrs.quantity, 1));
    const totalPrice = n(attrs.totalPrice, n(attrs.basePrice, 0) * qty);
    lines.push({
      id: String(entry?.id || ''),
      merchantCode: String(product?.code || '').trim(),
      productName: String(product?.name || attrs?.category?.title || '').trim(),
      quantity: qty,
      basePrice: n(attrs.basePrice, qty ? totalPrice / qty : 0),
      totalPrice
    });
  }
  return lines;
}

async function fetchDirect(days = 2) {
  const token = await credentialFor('Kaspi', config.kaspiToken);
  if (!token) throw new Error('KASPI_TOKEN is not configured on Railway');
  const byId = new Map();
  const failedStates = [];
  for (const state of DIRECT_ORDER_STATES) {
    let pageCount = 1;
    try {
      for (let page = 0; page < Math.min(MAX_BATCHES, pageCount); page++) {
        const result = await directOrderPage({ days, state, page });
        pageCount = Math.max(1, Math.min(MAX_BATCHES, result.pageCount));
        for (const raw of result.orders) {
          const id = String(raw?.id || '');
          if (id) byId.set(id, raw);
          if (byId.size >= MAX_DIRECT_ORDERS) break;
        }
        if (!result.orders.length || byId.size >= MAX_DIRECT_ORDERS) break;
      }
    } catch (error) {
      // One unavailable state must not make us fall back to the old
      // A delivery-only feed would silently lose orders from the other states.
      failedStates.push(`${state}: ${String(error?.message || error)}`);
    }
    if (byId.size >= MAX_DIRECT_ORDERS) break;
  }
  if (!byId.size) throw new Error(`Kaspi API returned no orders${failedStates.length ? `; ${failedStates.join(' | ')}` : ''}`);
  const productCache = new Map();
  const orders = [];
  for (const raw of byId.values()) {
    let lines = [];
    try { lines = await directOrderLines(raw, productCache); } catch {}
    orders.push({ ...raw, lines });
  }
  return { orders, meta: { pageCount: 1, failedStates }, upstream: 'Kaspi API direct via Railway' };
}

async function fetchAuthoritativeActiveOrders(days = ACTIVE_LOOKBACK_DAYS) {
  const byId = new Map();
  const observed = new Map();
  const productCache = new Map();
  for (const state of ACTIVE_CANDIDATE_STATES) {
    let pageCount = 1;
    for (let page = 0; page < pageCount; page++) {
      const result = await directOrderPage({ days, state, page });
      if (result.pageCount > MAX_ACTIVE_PAGES_PER_STATE) {
        throw new Error(`Kaspi active ${state} has ${result.pageCount} pages; safe limit is ${MAX_ACTIVE_PAGES_PER_STATE}`);
      }
      pageCount = result.pageCount;
      for (const raw of result.orders) {
        const probe = normalizeOrder(raw);
        if (!probe) continue;
        observed.set(String(probe.orderId), {
          orderId: String(probe.orderId),
          status: String(probe.status || ''),
          state: String(probe.state || '')
        });
        if (kaspiOrderIsActive(probe.status, probe.state)) byId.set(String(probe.orderId), raw);
      }
    }
  }

  const orders = [];
  for (const raw of byId.values()) {
    const lines = await directOrderLines(raw, productCache);
    if (!lines.length) throw new Error(`Kaspi active order ${String(raw?.id || '')} has no entries`);
    orders.push({ ...raw, lines });
  }
  return { orders, observed: [...observed.values()] };
}

async function updateObservedKaspiStates(observed) {
  if (!observed?.length) return;
  const now = Date.now();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const row of observed) {
      await client.query(`UPDATE marketplace_order_lines
        SET status=$1,state=$2,updated_at=$3
        WHERE market='Kaspi' AND order_id=$4`, [row.status, row.state, now, row.orderId]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
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

async function backfillPendingKaspiCompositions() {
  const now = Date.now();
  const oldestAllowed = now - PENDING_COMPOSITION_LOOKBACK_DAYS * 86_400_000;
  const retryBefore = now - PENDING_COMPOSITION_RETRY_MS;
  // Historical Kaspi reports are stored separately from current marketplace
  // lines. Repair that exact cache, not an unlimited marketplace archive.
  const pending = await pool.query(`SELECT order_id AS "orderId", code, status, state,
      creation_date AS "creationDate", raw_json AS "rawJson", updated_at AS "updatedAt"
    FROM kaspi_report_orders
    WHERE completion_date >= $1
      AND (lines_json IS NULL OR BTRIM(lines_json) IN ('', '[]'))
      AND updated_at <= $2
    ORDER BY updated_at ASC
    LIMIT $3`, [oldestAllowed, retryBefore, MAX_PENDING_COMPOSITION_ORDERS]);
  const productCache = new Map();
  let recovered = 0;
  let failed = 0;
  for (const row of pending.rows) {
    try {
      const sourceLines = await directOrderLines({ id: row.orderId }, productCache);
      if (!sourceLines.length) {
        failed++;
        await pool.query(`UPDATE kaspi_report_orders SET updated_at=$1 WHERE order_id=$2`,
          [Date.now(), row.orderId]);
        continue;
      }
      let raw = {};
      try { raw = JSON.parse(row.rawJson || '{}'); } catch {}
      await upsertOrder({
        orderId: String(row.orderId),
        code: String(row.code || row.orderId),
        status: String(row.status || ''),
        state: String(row.state || ''),
        creationDate: Number(row.creationDate) || Date.now(),
        raw,
        lines: sourceLines.map((line, index) => ({
          entryId: String(line.id || `${row.orderId}-recovered-${index}`),
          sku: String(line.merchantCode || ''),
          productName: String(line.productName || ''),
          qty: Math.max(1, n(line.quantity, 1)),
          unitPrice: n(line.basePrice, 0),
          totalPrice: n(line.totalPrice, n(line.basePrice, 0) * Math.max(1, n(line.quantity, 1)))
        }))
      });
      await pool.query(`UPDATE kaspi_report_orders SET lines_json=$1, updated_at=$2 WHERE order_id=$3`,
        [JSON.stringify(sourceLines), Date.now(), row.orderId]);
      recovered += sourceLines.length;
    } catch (error) {
      failed++;
      await pool.query(`UPDATE kaspi_report_orders SET updated_at=$1 WHERE order_id=$2`,
        [Date.now(), row.orderId]).catch(() => {});
      console.warn('Kaspi pending composition retry failed for', String(row.orderId), String(error?.message || error));
    }
  }
  return { checked: pending.rows.length, recovered, failed };
}

async function closeStaleRuns() {
  const cutoff = Date.now() - STALE_RUN_MS;
  await pool.query(`UPDATE sync_runs
    SET finished_at=$1,ok=0,error='stale sync abandoned after deploy/restart'
    WHERE market='Kaspi' AND finished_at IS NULL AND started_at < $2`, [Date.now(), cutoff]);
}

export async function syncKaspiOrders({ days = 2 } = {}) {
  if (syncInFlight) return syncInFlight;
  syncInFlight = (async () => {
    await closeStaleRuns();
    const startedAt = Date.now();
    const run = await pool.query("INSERT INTO sync_runs(market,started_at,ok,items,error) VALUES('Kaspi',$1,0,0,'') RETURNING id", [startedAt]);
    const runId = run.rows[0].id;
    let items = 0;
    let upstream = '';
    try {
      let authoritativeActiveOrders = null;
      let authoritativeObservedOrders = null;
      try {
        const authoritative = await fetchAuthoritativeActiveOrders();
        authoritativeActiveOrders = authoritative.orders;
        authoritativeObservedOrders = authoritative.observed;
      } catch (error) {
        // Never close reservations from a partial marketplace response. The
        // previous safe snapshot remains in use until a complete read works.
        console.warn('Kaspi authoritative active-order fetch skipped:', String(error?.message || error));
      }
      let payload = null;
      let directError = '';
      try {
        payload = await fetchDirect(days);
      } catch (error) {
        directError = String(error?.message || error);
      }
      if (!payload || !payload.orders.length) {
        if (authoritativeActiveOrders) {
          payload = { orders: authoritativeActiveOrders, upstream: 'Kaspi API direct active set', meta: {} };
        } else {
          throw new Error(`Kaspi direct API returned no orders${directError ? `; ${directError}` : ''}`);
        }
      }
      upstream = payload.upstream || 'Kaspi API direct via Railway';
      if (payload.meta?.failedStates?.length) {
        console.warn('Kaspi sync skipped unavailable state filters:', payload.meta.failedStates.join(' | '));
      }
      const mergedOrders = new Map();
      for (const raw of payload.orders) {
        const id = String(raw?.id || raw?.attributes?.id || '');
        if (id) mergedOrders.set(id, raw);
      }
      for (const raw of authoritativeActiveOrders || []) {
        const id = String(raw?.id || raw?.attributes?.id || '');
        if (id) mergedOrders.set(id, raw);
      }
      for (const raw of mergedOrders.values()) {
        const order = normalizeOrder(raw);
        if (!order) continue;
        await upsertOrder(order);
        items += order.lines.filter(line => line.entryId !== '__pending__').length || 1;
      }
      // Retry only recent incomplete historical orders. This is deliberately bounded
      // so ordinary synchronization never turns into a full archive download.
      const compositionBackfill = await backfillPendingKaspiCompositions();
      items += compositionBackfill.recovered;
      console.log('Kaspi composition backfill:', JSON.stringify(compositionBackfill));
      // Apply the complete direct observation last so no older cached row can
      // turn a transmitted parcel back into a new order.
      if (authoritativeObservedOrders) await updateObservedKaspiStates(authoritativeObservedOrders);
      let reservationReconcile = null;
      if (authoritativeActiveOrders) {
        const activeEntries = authoritativeActiveOrders.flatMap(raw => {
          const order = normalizeOrder(raw);
          if (!order || !kaspiOrderIsActive(order.status, order.state)) return [];
          return order.lines
            .filter(line => line.entryId !== '__pending__' && Number(line.qty) > 0)
            .map(line => ({ orderId: order.orderId, entryId: line.entryId }));
        });
        reservationReconcile = await reconcileKaspiReservations(activeEntries);
      }
      const saleReconcile = await reconcileMarketplaceSales('Kaspi');
      const finishedAt = Date.now();
      await pool.query("UPDATE sync_runs SET finished_at=$1,ok=1,items=$2,error='' WHERE id=$3", [finishedAt, items, runId]);
      return { ok: true, items, finishedAt, upstream, reservationReconcile, saleReconcile, compositionBackfill };
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
  closeStaleRuns().catch(error => console.error('Kaspi stale-run cleanup failed', error));
  const run = () => syncKaspiOrders({ days: 2 }).catch(error => console.error('Kaspi background sync failed', error));
  setTimeout(run, 2_000).unref();
  const timer = setInterval(run, SYNC_INTERVAL_MS);
  timer.unref();
  return timer;
}


