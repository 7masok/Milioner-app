import { pool, transaction } from './db.js';

const START_DELAY_MS = 8_000;
const LOOP_INTERVAL_MS = 30_000;
const FRESH_ROW_MS = 15 * 60_000;
let inFlight = null;

function lifecycle(market, status, state = '') {
  const u = String(status || '').toUpperCase();
  const st = String(state || '').toUpperCase();
  if (market === 'WB' || market === 'WB2') {
    if (['CANCELED','CANCELLED','CANCELED_BY_CLIENT','DECLINED_BY_CLIENT','DEFECT'].includes(st) || ['CANCEL','CANCELLED'].includes(u)) return 'cancelled';
    if (['SORTED','ACCEPTED_BY_CARRIER','SENT_TO_CARRIER','READY_FOR_PICKUP','SOLD'].includes(st)) return 'delivery';
    if (u === 'CONFIRM' || u === 'COMPLETE' || (st === 'WAITING' && u !== 'NEW')) return 'transfer';
    return 'new';
  }
  if (market === 'Kaspi') {
    if (['CANCELLED','CANCELLING','RETURNED','KASPI_DELIVERY_RETURN_REQUESTED'].includes(u)) return 'cancelled';
    if (u === 'COMPLETED' || st === 'KASPI_DELIVERY_TRANSIT') return 'delivery';
    if (u === 'ASSEMBLE') return 'transfer';
    return 'new';
  }
  return 'cancelled';
}

function skuField(market) {
  if (market === 'Kaspi') return 'kaspi';
  if (market === 'WB2') return 'wb2';
  if (market === 'WB') return 'wb';
  return '';
}

function rid() {
  return 'auto-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
}

export async function reconcileMarketplaceReservations() {
  if (inFlight) return inFlight;
  inFlight = transaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [730021]);
    const current = await client.query('SELECT payload,revision FROM warehouse_state WHERE id=1 FOR UPDATE');
    if (!current.rowCount) return { changed: 0, activeQty: 0, activeLines: 0 };

    let warehouse = {};
    try { warehouse = JSON.parse(String(current.rows[0].payload || '{}')); } catch { return { changed: 0, activeQty: 0, activeLines: 0, error: 'warehouse-json' }; }
    warehouse.products = Array.isArray(warehouse.products) ? warehouse.products : [];
    warehouse.reservations = Array.isArray(warehouse.reservations) ? warehouse.reservations : [];
    warehouse.sales = Array.isArray(warehouse.sales) ? warehouse.sales : [];

    const now = Date.now();
    const cutoff = now - FRESH_ROW_MS;
    const rows = await client.query(`SELECT market,order_id AS "orderId",entry_id AS "entryId",status,state,sku,qty,updated_at AS "updatedAt"
      FROM marketplace_order_lines
      WHERE market IN ('Kaspi','WB','WB2') AND updated_at >= $1`, [cutoff]);
    const links = await client.query(`SELECT market,sku,product_id AS "productId" FROM product_links
      WHERE market IN ('Kaspi','WB','WB2')`);

    const linkMap = new Map(links.rows.map(x => [`${x.market}|${String(x.sku || '').trim()}`, String(x.productId || '')]));
    const skuMaps = { Kaspi: new Map(), WB: new Map(), WB2: new Map() };
    for (const p of warehouse.products) {
      for (const market of ['Kaspi','WB','WB2']) {
        const field = skuField(market), sku = String(p?.[field] || '').trim();
        if (sku) skuMaps[market].set(sku, String(p.id));
      }
    }

    const sold = new Set();
    for (const s of warehouse.sales) if (s?.externalKey) sold.add(String(s.externalKey));

    const byScoped = new Map();
    const kaspiLegacy = new Map();
    for (const r of warehouse.reservations) {
      if (!r?.active) continue;
      const src = String(r.source || '');
      const key = String(r.externalKey || '');
      if (src && key) byScoped.set(`${src}|${key}`, r);
      if (src === 'Kaspi' && key && !key.startsWith('Kaspi:')) kaspiLegacy.set(key, r);
    }

    let changed = 0, activeQty = 0, activeLines = 0, created = 0, closed = 0, updated = 0, unmatched = 0;
    const activeKeys = new Set();
    const byMarket = { Kaspi: { qty: 0, lines: 0 }, WB: { qty: 0, lines: 0 }, WB2: { qty: 0, lines: 0 } };

    for (const row of rows.rows) {
      const market = String(row.market || '');
      const qty = Math.max(0, Number(row.qty) || 0);
      if (!qty) continue;
      const keyLegacy = `${String(row.orderId || '')}:${String(row.entryId || '')}`;
      const key = `${market}:${keyLegacy}`;
      const st = lifecycle(market, row.status, row.state);
      const sku = String(row.sku || '').trim();
      const productId = linkMap.get(`${market}|${sku}`) || skuMaps[market]?.get(sku) || '';
      if (!productId) { if (st === 'new') unmatched += qty; continue; }

      const existing = byScoped.get(`${market}|${key}`) || (market === 'Kaspi' ? kaspiLegacy.get(keyLegacy) : null);
      const saleExists = sold.has(key) || (market === 'Kaspi' && sold.has(keyLegacy));
      const shouldReserve = st === 'new' && !saleExists;

      if (shouldReserve) {
        activeKeys.add(`${market}|${key}`);
        activeQty += qty;
        activeLines++;
        if (byMarket[market]) { byMarket[market].qty += qty; byMarket[market].lines++; }
        if (!existing) {
          const r = { id: rid(), productId, qty, active: true, source: market, externalKey: key, stage: st, date: now, updatedAt: now };
          warehouse.reservations.push(r);
          byScoped.set(`${market}|${key}`, r);
          created++; changed++;
        } else {
          let dirty = false;
          if (String(existing.productId || '') !== productId) { existing.productId = productId; dirty = true; }
          if (Number(existing.qty || 0) !== qty) { existing.qty = qty; dirty = true; }
          if (String(existing.stage || '') !== st) { existing.stage = st; dirty = true; }
          if (!existing.active) { existing.active = true; dirty = true; }
          if (String(existing.externalKey || '') !== key) { existing.externalKey = key; dirty = true; }
          if (dirty) { existing.updatedAt = now; delete existing.closedReason; updated++; changed++; }
        }
      } else if (existing?.active) {
        existing.active = false;
        existing.updatedAt = now;
        existing.closedReason = st === 'cancelled' ? 'market-explicit-cancel' : st === 'delivery' ? 'market-explicit-handoff' : st === 'transfer' ? 'market-explicit-transfer' : 'market-sale-exists';
        closed++; changed++;
      }
    }

    for (const r of warehouse.reservations) {
      if (!r?.active || !String(r.id || '').startsWith('auto-')) continue;
      const src = String(r.source || ''), key = String(r.externalKey || '');
      if (!['Kaspi','WB','WB2'].includes(src) || !key) continue;
      const canonical = `${src}|${key.startsWith(src + ':') ? key : (src === 'Kaspi' ? src + ':' + key : key)}`;
      if (activeKeys.has(canonical)) continue;
      r.active = false;
      r.updatedAt = now;
      r.closedReason = 'market-row-not-fresh';
      closed++; changed++;
    }

    const seen = new Set();
    for (const r of warehouse.reservations) {
      if (!r?.active) continue;
      const src = String(r.source || ''), key = String(r.externalKey || '');
      if (!['Kaspi','WB','WB2'].includes(src) || !key) continue;
      const canonical = `${src}|${key.startsWith(src + ':') ? key : (src === 'Kaspi' ? src + ':' + key : key)}`;
      if (!seen.has(canonical)) { seen.add(canonical); continue; }
      r.active = false;
      r.updatedAt = now;
      r.closedReason = 'duplicate-reservation';
      closed++; changed++;
    }

    if (changed) {
      const revision = Number(current.rows[0].revision || 0) + 1;
      await client.query('UPDATE warehouse_state SET payload=$1,revision=$2,updated_at=$3 WHERE id=1', [JSON.stringify(warehouse), revision, now]);
    }
    const summary = { changed, created, updated, closed, activeQty, activeLines, unmatched, byMarket, freshRows: rows.rowCount };
    console.log(`Marketplace reservation reconcile: ${JSON.stringify(summary)}`);
    return summary;
  });
  try { return await inFlight; } finally { inFlight = null; }
}

export function startMarketplaceReservationReconcileLoop() {
  const run = () => reconcileMarketplaceReservations().catch(error => console.error('Marketplace reservation reconcile failed', String(error?.message || error)));
  setTimeout(run, START_DELAY_MS).unref();
  const timer = setInterval(run, LOOP_INTERVAL_MS);
  timer.unref();
  return timer;
}
