import crypto from 'node:crypto';
import { transaction } from './db.js';
import { kaspiOrderIsCollected } from './kaspi-status.js';
import { wbOrderIsActive, wbOrderIsCollected } from './wb-status.js';

// The server became authoritative for marketplace orders on 24 August 2026.
// Never backfill older rows: some of them were already written by the former
// browser-side reconciler and do not all have a stable external key.
const SERVER_SALE_CUTOVER = Date.UTC(2026, 7, 24, 0, 0, 0);

function parsePayload(raw) {
  try { return JSON.parse(String(raw || '{}')); } catch { return {}; }
}

function upper(value) { return String(value || '').trim().toUpperCase(); }

function isCancelled(market, status, state) {
  const s = upper(status), w = upper(state);
  if (market === 'Kaspi') return ['CANCELLED', 'CANCELLING', 'RETURNED', 'KASPI_DELIVERY_RETURN_REQUESTED'].includes(s);
  return s === 'CANCEL' || ['CANCELED', 'CANCELLED', 'CANCELED_BY_CLIENT', 'CANCELLED_BY_CLIENT', 'DECLINED_BY_CLIENT', 'DEFECT'].includes(w);
}

function isCollected(market, status, state) {
  if (isCancelled(market, status, state)) return false;
  const s = upper(status), w = upper(state);
  if (market === 'Kaspi') return kaspiOrderIsCollected(s, w);
  return wbOrderIsCollected(s, w);
}

function externalKey(market, row) {
  return `${market}:${String(row.order_id)}:${String(row.entry_id)}`;
}

function uid(prefix, key, now) {
  return `${prefix}-${crypto.createHash('sha1').update(`${key}:${now}`).digest('hex').slice(0, 20)}`;
}

function components(product) {
  if (String(product?.kind || 'simple') !== 'bundle' || !Array.isArray(product?.components)) return [];
  return product.components.map(row => ({ productId: String(row?.productId || ''), qty: Math.max(1, Number(row?.qty) || 1) })).filter(row => row.productId);
}

function consumeProduct(state, products, product, qty, label, now) {
  const targets = components(product).length
    ? components(product).map(row => ({ product: products.get(row.productId), qty: qty * row.qty, bundle: product.name }))
    : [{ product, qty, bundle: '' }];
  let totalCost = 0, shortage = 0;
  for (const target of targets) {
    if (!target.product) continue;
    const before = Math.max(0, Number(target.product.stock) || 0);
    const taken = Math.min(before, target.qty);
    target.product.stock = Math.max(0, before - target.qty);
    totalCost += target.qty * Math.max(0, Number(target.product.cost) || 0);
    shortage += Math.max(0, target.qty - before);
    state.movements.unshift({
      id: uid('market-sale-movement', `${label}:${target.product.id}`, now),
      date: now,
      type: 'продажа',
      productId: String(target.product.id),
      qty: -taken,
      extra: `${label} · собрано на маркетплейсе${target.bundle ? ` · набор «${target.bundle}»` : ''}${target.qty > before ? ` · нехватка ${target.qty - before} шт.` : ''}`
    });
  }
  return { unitCost: qty ? totalCost / qty : 0, shortage };
}

function restorePrematureWbSale(state, products, row, market) {
  if (market === 'Kaspi' || !wbOrderIsActive(row.status, row.state)) return 0;
  const key = externalKey(market, row);
  const matches = state.sales.filter(sale => sale?.serverReconciled === true && String(sale?.externalKey || '') === key);
  if (!matches.length) return 0;
  const product = products.get(String(row.product_id || ''));
  if (!product) return 0;
  const qty = matches.reduce((sum, sale) => sum + Math.max(0, Number(sale?.qty) || 0), 0);
  if (!qty) return 0;
  const targets = components(product).length
    ? components(product).map(part => ({ product: products.get(part.productId), qty: qty * part.qty }))
    : [{ product, qty }];
  for (const target of targets) if (target.product) target.product.stock = Math.max(0, Number(target.product.stock) || 0) + target.qty;
  const label = `${market} ${String(row.code || row.order_id)}`;
  state.sales = state.sales.filter(sale => !(sale?.serverReconciled === true && String(sale?.externalKey || '') === key));
  state.movements = state.movements.filter(movement => !(
    String(movement?.type || '') === 'продажа' &&
    String(movement?.extra || '').startsWith(`${label} · собрано на маркетплейсе`)
  ));
  return qty;
}

export async function reconcileMarketplaceSales(market) {
  if (!['Kaspi', 'WB', 'WB2'].includes(market)) throw new Error('Unsupported marketplace');
  return transaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [730021]);
    const stored = await client.query('SELECT payload,revision FROM warehouse_state WHERE id=1 FOR UPDATE');
    if (!stored.rowCount) return { changed: false, market, reason: 'warehouse-not-initialized' };
    const rows = await client.query(`SELECT o.order_id,o.entry_id,o.code,o.status,o.state,o.creation_date,o.qty,o.unit_price,
        o.seller_delivery_cost,o.marketplace_fee,o.fee_source,l.product_id
      FROM marketplace_order_lines o
      LEFT JOIN product_links l ON l.market=o.market AND l.sku=o.sku
      WHERE o.market=$1 AND o.creation_date >= $2
      ORDER BY o.creation_date,o.order_id,o.entry_id`, [market, SERVER_SALE_CUTOVER]);
    const state = parsePayload(stored.rows[0].payload);
    state.products = Array.isArray(state.products) ? state.products : [];
    state.movements = Array.isArray(state.movements) ? state.movements : [];
    state.sales = Array.isArray(state.sales) ? state.sales : [];
    state.reservations = Array.isArray(state.reservations) ? state.reservations : [];
    const products = new Map(state.products.map(product => [String(product?.id || ''), product]));
    let restored = 0;
    for (const row of rows.rows) restored += restorePrematureWbSale(state, products, row, market);
    const existing = new Set(state.sales.map(sale => String(sale?.externalKey || '')).filter(Boolean));
    let sold = 0, unlinked = 0;
    const now = Date.now();
    for (const row of rows.rows) {
      if (!isCollected(market, row.status, row.state)) continue;
      const key = externalKey(market, row);
      if (existing.has(key)) continue;
      const product = products.get(String(row.product_id || ''));
      const qty = Math.max(0, Number(row.qty) || 0);
      if (!product || !qty) { unlinked++; continue; }
      const label = `${market} ${String(row.code || row.order_id)}`;
      const consumed = consumeProduct(state, products, product, qty, label, now + sold);
      const fees = Math.max(0, Number(row.seller_delivery_cost) || 0) + Math.max(0, Number(row.marketplace_fee) || 0);
      state.sales.push({
        id: uid('market-sale', key, now), productId: String(product.id), qty,
        price: Math.max(0, Number(row.unit_price) || 0), cost: consumed.unitCost,
        fee: qty ? fees / qty : 0, feeSource: String(row.fee_source || ''),
        channel: market, date: Number(row.creation_date) || now, externalKey: key,
        stockShortage: consumed.shortage, serverReconciled: true
      });
      for (const reservation of state.reservations) {
        const reservationKey = String(reservation?.externalKey || '');
        if (reservation?.active === true && reservation?.source === market && (reservationKey === key || (market === 'Kaspi' && `Kaspi:${reservationKey}` === key))) {
          reservation.active = false;
          reservation.stage = 'sold';
          reservation.closedAt = now;
          reservation.updatedAt = now;
        }
      }
      existing.add(key);
      sold += qty;
    }
    if (!sold && !restored) return { changed: false, market, sold: 0, restored: 0, unlinked, revision: Number(stored.rows[0].revision || 0) };
    state.movements = state.movements.slice(0, 1000);
    const backup = await client.query(`INSERT INTO warehouse_backups(label,payload,revision,created_at)
      VALUES($1,$2,$3,$4) RETURNING id`, [`before-${market.toLowerCase()}-sale-reconcile`, stored.rows[0].payload, stored.rows[0].revision, now]);
    const raw = JSON.stringify(state), revision = Number(stored.rows[0].revision || 0) + 1;
    await client.query('UPDATE warehouse_state SET payload=$1,revision=$2,updated_at=$3 WHERE id=1', [raw, revision, now]);
    const sha = crypto.createHash('sha256').update(raw).digest('hex').toUpperCase();
    await client.query('INSERT INTO warehouse_audit(revision,updated_at,payload_sha256,source) VALUES($1,$2,$3,$4)',
      [revision, now, sha, `${market.toLowerCase()}-sale-reconcile`]);
    return { changed: true, market, sold, restored, unlinked, revision, backupId: String(backup.rows[0].id) };
  });
}
