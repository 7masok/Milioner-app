import crypto from 'node:crypto';
import { config } from './config.js';
import { pool } from './db.js';

const WB_MARKETPLACE_BASE = 'https://marketplace-api.wildberries.ru';
const FETCH_TIMEOUT_MS = 20_000;
const LOOP_INTERVAL_MS = 10 * 60 * 1000;
const START_DELAY_MS = 20_000;
let syncLoopInFlight = null;

function isBundleProduct(product) {
  return String(product?.kind || 'simple') === 'bundle' && Array.isArray(product?.components) && product.components.length > 0;
}

function bundleParts(product) {
  return isBundleProduct(product)
    ? product.components.map(x => ({ productId: String(x?.productId || ''), qty: Math.max(1, Number(x?.qty) || 1) })).filter(x => x.productId)
    : [];
}

function addQty(map, key, qty) {
  const amount = Number(qty) || 0;
  if (!key || amount <= 0) return;
  const id = String(key);
  map.set(id, (Number(map.get(id)) || 0) + amount);
}

export function stockLifecycleStage(market, status, state = '') {
  const u = String(status || '').toUpperCase();
  const st = String(state || '').toUpperCase();
  if (market === 'WB' || market === 'WB2') {
    if (['CANCELED', 'CANCELLED', 'CANCELED_BY_CLIENT', 'DECLINED_BY_CLIENT', 'DEFECT'].includes(st) || ['CANCEL', 'CANCELLED'].includes(u)) return 'cancelled';
    if (['SORTED', 'ACCEPTED_BY_CARRIER', 'SENT_TO_CARRIER', 'READY_FOR_PICKUP', 'SOLD'].includes(st)) return 'delivery';
    if (u === 'CONFIRM' || u === 'COMPLETE' || (st === 'WAITING' && u !== 'NEW')) return 'transfer';
    return 'new';
  }
  if (market === 'Kaspi') {
    if (['CANCELLED', 'CANCELLING', 'RETURNED', 'KASPI_DELIVERY_RETURN_REQUESTED'].includes(u)) return 'cancelled';
    if (u === 'COMPLETED' || st === 'KASPI_DELIVERY_TRANSIT') return 'delivery';
    if (u === 'ASSEMBLE') return 'transfer';
    return 'new';
  }
  return 'cancelled';
}

export function computeSharedAvailableStocks(warehouse, orderRows) {
  const products = new Map((warehouse.products || []).map(product => [String(product.id), product]));
  const skuMaps = { Kaspi: new Map(), WB: new Map(), WB2: new Map() };
  for (const product of warehouse.products || []) {
    if (String(product?.kaspi || '').trim()) skuMaps.Kaspi.set(String(product.kaspi).trim(), String(product.id));
    if (String(product?.wb || '').trim()) skuMaps.WB.set(String(product.wb).trim(), String(product.id));
    if (String(product?.wb2 || '').trim()) skuMaps.WB2.set(String(product.wb2).trim(), String(product.id));
  }

  const stageByKey = new Map();
  for (const row of orderRows || []) {
    const market = String(row.market || '');
    if (!skuMaps[market]) continue;
    const legacy = `${String(row.orderId || '')}:${String(row.entryId || '')}`;
    const scoped = `${market}:${legacy}`;
    const stage = stockLifecycleStage(market, row.status, row.state);
    stageByKey.set(scoped, stage);
    if (market === 'Kaspi') stageByKey.set(legacy, stage);
  }

  const direct = new Map();
  const reservationKeys = new Set();
  for (const reservation of warehouse.reservations || []) {
    if (!reservation?.active || !reservation?.productId || !(Number(reservation.qty) > 0)) continue;
    const key = String(reservation.externalKey || '');
    const currentStage = key ? stageByKey.get(key) : null;
    // Cancelled or already handed-off orders must no longer reserve free marketplace stock.
    if (currentStage && !['new', 'transfer'].includes(currentStage)) continue;
    addQty(direct, reservation.productId, reservation.qty);
    if (key) reservationKeys.add(key);
  }

  const soldKeys = new Set();
  for (const sale of warehouse.sales || []) if (sale?.externalKey) soldKeys.add(String(sale.externalKey));

  for (const row of orderRows || []) {
    const market = String(row.market || '');
    const skuMap = skuMaps[market];
    if (!skuMap) continue;
    const pid = skuMap.get(String(row.sku || '').trim());
    if (!pid) continue;
    const qty = Math.max(0, Number(row.qty) || 0);
    if (!qty) continue;
    const legacy = `${String(row.orderId || '')}:${String(row.entryId || '')}`;
    const scoped = `${market}:${legacy}`;
    const stage = stockLifecycleStage(market, row.status, row.state);
    const hasReservation = reservationKeys.has(scoped) || (market === 'Kaspi' && reservationKeys.has(legacy));

    if (stage === 'new' || stage === 'transfer') {
      if (!hasReservation) addQty(direct, pid, qty);
      continue;
    }
    if (stage !== 'delivery' || hasReservation) continue;
    if (soldKeys.has(scoped) || (market === 'Kaspi' && soldKeys.has(legacy))) continue;

    // Protect the short race between marketplace hand-off and the browser writing the sale.
    const liveSince = Number(warehouse.marketplaceLiveSince?.[market] || 0);
    const previous = warehouse.marketOrderState?.[market]?.[legacy] || warehouse.marketOrderState?.[market]?.[scoped] || null;
    const wasActive = Boolean(previous?.active || ['new', 'transfer'].includes(String(previous?.stage || '')));
    if (wasActive || (liveSince && Number(row.creationDate || 0) >= liveSince)) addQty(direct, pid, qty);
  }

  const committed = new Map();
  for (const [pid, qty] of direct) {
    const product = products.get(String(pid));
    if (!product) continue;
    if (isBundleProduct(product)) {
      for (const part of bundleParts(product)) addQty(committed, part.productId, qty * part.qty);
    } else {
      addQty(committed, pid, qty);
    }
  }

  const available = new Map();
  // First calculate physical/simple products after all direct and bundle commitments.
  for (const product of warehouse.products || []) {
    if (isBundleProduct(product)) continue;
    const pid = String(product.id);
    const amount = Math.max(0, Math.floor((Number(product.stock) || 0) - (Number(committed.get(pid)) || 0)));
    available.set(pid, amount);
  }
  // Bundles share the same component stock, so their sellable quantity is the limiting component.
  for (const product of warehouse.products || []) {
    if (!isBundleProduct(product)) continue;
    const parts = bundleParts(product);
    const amount = parts.length
      ? Math.max(0, Math.min(...parts.map(part => Math.floor((Number(available.get(part.productId)) || 0) / part.qty))))
      : 0;
    available.set(String(product.id), amount);
  }
  return available;
}

async function loadWarehouse() {
  const result = await pool.query('SELECT payload,updated_at AS "updatedAt" FROM warehouse_state WHERE id=1');
  if (!result.rowCount || !result.rows[0]?.payload) throw new Error('Warehouse state is not initialized');
  let state;
  try { state = JSON.parse(result.rows[0].payload || '{}'); } catch { throw new Error('Warehouse state JSON is invalid'); }
  state = state && typeof state === 'object' ? state : {};
  state.products = Array.isArray(state.products) ? state.products : [];
  state.sales = Array.isArray(state.sales) ? state.sales : [];
  state.reservations = Array.isArray(state.reservations) ? state.reservations : [];
  state.marketplaceLiveSince = state.marketplaceLiveSince && typeof state.marketplaceLiveSince === 'object' ? state.marketplaceLiveSince : {};
  state.marketOrderState = state.marketOrderState && typeof state.marketOrderState === 'object' ? state.marketOrderState : {};
  state.updatedAt = Number(result.rows[0].updatedAt || 0);
  return state;
}

async function orderRows() {
  const result = await pool.query(`SELECT market,order_id AS "orderId",entry_id AS "entryId",status,state,
    creation_date AS "creationDate",sku,qty
    FROM marketplace_order_lines WHERE market IN ('Kaspi','WB','WB2')`);
  return result.rows;
}

function linkedProducts(warehouse, market) {
  const field = market === 'WB2' ? 'wb2' : 'wb';
  const seen = new Set();
  const out = [];
  for (const product of warehouse.products || []) {
    const sku = String(product?.[field] || '').trim();
    if (!sku || seen.has(sku)) continue;
    seen.add(sku);
    out.push({ product, sku });
  }
  return out;
}

async function mappedLinks(market, linked) {
  const result = await pool.query('SELECT sku,chrt_id AS "chrtId" FROM wb_stock_links WHERE market=$1', [market]);
  const map = new Map(result.rows.map(row => [String(row.sku || ''), Number(row.chrtId || 0)]));
  return linked.map(item => ({ ...item, chrtId: Number(map.get(item.sku) || 0) }));
}

async function resolveWarehouseId(market) {
  const configured = String(market === 'WB2' ? config.wbWarehouseId2 : config.wbWarehouseId).trim();
  if (configured) return configured;
  const state = await pool.query('SELECT warehouse_id AS "warehouseId" FROM wb_stock_state WHERE market=$1', [market]);
  const fromState = String(state.rows[0]?.warehouseId || '').trim();
  if (fromState) return fromState;
  const run = await pool.query(`SELECT warehouse_id AS "warehouseId" FROM stock_sync_runs
    WHERE market=$1 AND COALESCE(warehouse_id,'')<>'' ORDER BY id DESC LIMIT 1`, [market]);
  return String(run.rows[0]?.warehouseId || '').trim();
}

function tokenFor(market) {
  return String(market === 'WB2' ? config.wbToken2 : config.wbToken).trim();
}

function errorText(prefix, status, data) {
  const detail = data?.detail || data?.message || data?.title || data?.error || '';
  return `${prefix} HTTP ${status}${detail ? `: ${String(detail).slice(0, 500)}` : ''}`;
}

async function wbFetch(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal, cache: 'no-store' });
    const text = await response.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch { data = { message: text.slice(0, 500) }; } }
    return { response, data };
  } finally {
    clearTimeout(timer);
  }
}

async function readActualStocks(token, warehouseId, items) {
  const ids = [...new Set(items.map(x => Number(x.chrtId) || 0).filter(Boolean))];
  const actual = new Map();
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: token };
  for (let i = 0; i < ids.length; i += 1000) {
    const chunk = ids.slice(i, i + 1000);
    const { response, data } = await wbFetch(`${WB_MARKETPLACE_BASE}/api/v3/stocks/${encodeURIComponent(warehouseId)}`, {
      method: 'POST', headers, body: JSON.stringify({ chrtIds: chunk })
    });
    if (!response.ok) throw new Error(errorText('WB stocks read', response.status, data || {}));
    for (const row of Array.isArray(data?.stocks) ? data.stocks : []) {
      const chrtId = Number(row?.chrtId) || 0;
      if (chrtId) actual.set(chrtId, Math.max(0, Math.floor(Number(row?.amount) || 0)));
    }
  }
  return actual;
}

function payloadHash(items) {
  const text = items.slice().sort((a, b) => Number(a.chrtId) - Number(b.chrtId))
    .map(x => `${Number(x.chrtId)}:${Math.max(0, Math.floor(Number(x.amount) || 0))}`).join('|');
  return crypto.createHash('sha256').update(text).digest('hex');
}

async function latestState(market) {
  const result = await pool.query(`SELECT market,warehouse_id AS "warehouseId",payload_hash AS "payloadHash",
    last_sent_at AS "lastSentAt",last_items AS "lastItems",last_error AS "lastError",updated_at AS "updatedAt"
    FROM wb_stock_state WHERE market=$1`, [market]);
  return result.rows[0] || null;
}

export async function previewWbStockMarket(market = 'WB', { verifyActual = true } = {}) {
  if (!['WB', 'WB2'].includes(market)) throw new Error('Unsupported WB stock market');
  const token = tokenFor(market);
  if (!token) return { ok: false, market, ready: false, reason: 'token-not-configured' };
  const warehouse = await loadWarehouse();
  if (!warehouse.products.length) return { ok: false, market, ready: false, reason: 'warehouse-empty-safety' };
  const linked = linkedProducts(warehouse, market);
  if (!linked.length) return { ok: true, market, ready: false, reason: 'no-linked-products', linked: 0 };
  const mapped = await mappedLinks(market, linked);
  const missing = mapped.filter(x => !x.chrtId);
  const warehouseId = await resolveWarehouseId(market);
  if (!warehouseId) return { ok: false, market, ready: false, reason: 'warehouse-not-ready', linked: linked.length, mapped: mapped.length - missing.length, missing: missing.length };
  if (missing.length) return { ok: false, market, ready: false, reason: 'partial-mapping-safety', linked: linked.length, mapped: mapped.length - missing.length, missing: missing.length, missingSkus: missing.slice(0, 20).map(x => x.sku) };

  const amounts = computeSharedAvailableStocks(warehouse, await orderRows());
  const items = mapped.map(x => ({ chrtId: x.chrtId, amount: Math.max(0, Math.floor(Number(amounts.get(String(x.product.id))) || 0)), sku: x.sku, productId: String(x.product.id), name: String(x.product.name || '') }));
  const hash = payloadHash(items);
  const previous = await latestState(market);
  let drift = null;
  if (verifyActual) {
    try {
      const actual = await readActualStocks(token, warehouseId, items);
      const different = items.filter(item => (actual.has(item.chrtId) ? Number(actual.get(item.chrtId)) : 0) !== item.amount);
      drift = { count: different.length, sample: different.slice(0, 20).map(item => ({ sku: item.sku, name: item.name, expected: item.amount, actual: actual.has(item.chrtId) ? Number(actual.get(item.chrtId)) : 0 })) };
    } catch (error) {
      drift = { count: null, error: String(error?.message || error) };
    }
  }
  return { ok: true, market, ready: true, warehouseId, linked: linked.length, mapped: mapped.length, missing: 0, items: items.length, hash, previous, drift, sample: items.slice(0, 20).map(({ chrtId, ...rest }) => rest) };
}

export async function syncWbStockMarket(market = 'WB', { force = false } = {}) {
  const preview = await previewWbStockMarket(market, { verifyActual: true });
  if (!preview.ok || !preview.ready) return { ...preview, sent: false, skipped: true };
  if (!force && preview.drift && preview.drift.count === 0) {
    return { ok: true, market, sent: false, skipped: true, verified: true, reason: 'unchanged', warehouseId: preview.warehouseId, items: preview.items, lastSentAt: Number(preview.previous?.lastSentAt || 0) };
  }
  if (preview.drift && preview.drift.count == null) {
    return { ok: false, market, sent: false, skipped: true, reason: 'verify-failed-safety', error: preview.drift.error || 'WB stock verification failed' };
  }

  const warehouse = await loadWarehouse();
  const linked = linkedProducts(warehouse, market);
  const mapped = await mappedLinks(market, linked);
  if (mapped.some(x => !x.chrtId) || mapped.length !== linked.length) return { ok: false, market, sent: false, skipped: true, reason: 'partial-mapping-safety' };
  const amounts = computeSharedAvailableStocks(warehouse, await orderRows());
  const items = mapped.map(x => ({ chrtId: x.chrtId, amount: Math.max(0, Math.floor(Number(amounts.get(String(x.product.id))) || 0)) }));
  const hash = payloadHash(items);
  const token = tokenFor(market);
  const warehouseId = preview.warehouseId;
  const startedAt = Date.now();
  const run = await pool.query(`INSERT INTO stock_sync_runs(market,mode,started_at,warehouse_id,linked,mapped,missing,items)
    VALUES($1,'sync',$2,$3,$4,$5,0,$6) RETURNING id`, [market, startedAt, warehouseId, linked.length, mapped.length, items.length]);
  const runId = run.rows[0]?.id;
  try {
    const headers = { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: token };
    for (let i = 0; i < items.length; i += 1000) {
      const chunk = items.slice(i, i + 1000);
      const { response, data } = await wbFetch(`${WB_MARKETPLACE_BASE}/api/v3/stocks/${encodeURIComponent(warehouseId)}`, {
        method: 'PUT', headers, body: JSON.stringify({ stocks: chunk })
      });
      if (!response.ok) throw new Error(errorText('WB stocks', response.status, data || {}));
    }
    const now = Date.now();
    await pool.query(`INSERT INTO wb_stock_state(market,warehouse_id,payload_hash,last_sent_at,last_items,last_error,updated_at)
      VALUES($1,$2,$3,$4,$5,'',$4)
      ON CONFLICT(market) DO UPDATE SET warehouse_id=excluded.warehouse_id,payload_hash=excluded.payload_hash,
      last_sent_at=excluded.last_sent_at,last_items=excluded.last_items,last_error='',updated_at=excluded.updated_at`,
    [market, warehouseId, hash, now, items.length]);
    if (runId) await pool.query('UPDATE stock_sync_runs SET finished_at=$1,ok=1 WHERE id=$2', [now, runId]);
    return { ok: true, market, sent: true, warehouseId, items: items.length, sentAt: now, repaired: Number(preview.drift?.count || 0) };
  } catch (error) {
    const message = String(error?.message || error).slice(0, 2000);
    const now = Date.now();
    if (runId) await pool.query('UPDATE stock_sync_runs SET finished_at=$1,ok=0,error=$2 WHERE id=$3', [now, message, runId]);
    await pool.query(`INSERT INTO wb_stock_state(market,warehouse_id,payload_hash,last_sent_at,last_items,last_error,updated_at)
      VALUES($1,$2,'',0,0,$3,$4)
      ON CONFLICT(market) DO UPDATE SET last_error=excluded.last_error,updated_at=excluded.updated_at`,
    [market, warehouseId, message, now]);
    throw error;
  }
}

export async function syncAllWbStocks({ force = false } = {}) {
  if (!config.marketSyncEnabled) return { ok: false, error: 'market-sync-disabled-during-migration', results: {} };
  const results = {};
  for (const market of ['WB', 'WB2']) {
    try { results[market] = await syncWbStockMarket(market, { force }); }
    catch (error) { results[market] = { ok: false, market, error: String(error?.message || error) }; }
  }
  return { ok: Object.values(results).every(x => x?.ok !== false), serverTime: Date.now(), results };
}

export function startWbStockSyncLoop() {
  if (!config.marketSyncEnabled) return null;
  const run = async () => {
    if (syncLoopInFlight) return syncLoopInFlight;
    syncLoopInFlight = syncAllWbStocks({ force: false }).catch(error => {
      console.error('WB stock sync loop failed', String(error?.message || error));
      return null;
    }).finally(() => { syncLoopInFlight = null; });
    return syncLoopInFlight;
  };
  setTimeout(run, START_DELAY_MS).unref();
  const timer = setInterval(run, LOOP_INTERVAL_MS);
  timer.unref();
  return timer;
}
