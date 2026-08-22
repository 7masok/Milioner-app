import crypto from 'node:crypto';
import { transaction } from './db.js';

function parsePayload(raw) {
  try { return JSON.parse(String(raw || '{}')); } catch { return {}; }
}

function orderKey(market, orderId, entryId) {
  return `${market}:${String(orderId)}:${String(entryId)}`;
}

function sameText(left, right) {
  return String(left ?? '') === String(right ?? '');
}

// WB FBS reservation is only valid while the order is explicitly in work.
// Unknown/missing statuses must NEVER create a reservation: treating them as
// active was the source of phantom reserves after incomplete status responses.
function wbOrderIsActive(status, state) {
  const supplier = String(status || '').trim().toLowerCase();
  const wb = String(state || '').trim().toLowerCase();

  const activeSupplier = new Set(['new', 'confirm', 'complete']);
  const terminalSupplier = new Set(['cancel']);
  const activeWb = new Set(['waiting']);
  const terminalWb = new Set([
    'sorted',
    'sold',
    'canceled',
    'cancelled',
    'canceled_by_client',
    'cancelled_by_client',
    'declined_by_client',
    'defect',
    'ready_for_pickup',
    'canceled_by_missed_call',
    'cancelled_by_missed_call'
  ]);

  if (terminalSupplier.has(supplier) || terminalWb.has(wb)) return false;
  if (!activeSupplier.has(supplier)) return false;
  if (!activeWb.has(wb)) return false;
  return true;
}

function stableReservation(market, row, productId) {
  return {
    id: `server-${market.toLowerCase()}-${String(row.order_id)}-${String(row.entry_id)}`,
    productId: String(productId),
    qty: Math.max(0, Number(row.qty) || 0),
    active: true,
    source: market,
    externalKey: orderKey(market, row.order_id, row.entry_id),
    stage: 'new',
    date: Number(row.creation_date) || Date.now(),
    updatedAt: Number(row.updated_at) || Date.now()
  };
}

// A confirmed WB sync is authoritative for active WB reservations. The active
// reservation set for this market is rebuilt from the full confirmed order
// table, so an old sync cannot leave phantom reservations behind. Inventory,
// purchases and sales are deliberately untouched here.
export async function reconcileWbReservations(market, _syncedSince) {
  if (!['WB', 'WB2'].includes(market)) throw new Error('Unsupported WB market');

  return transaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [730021]);
    const stored = await client.query('SELECT payload,revision FROM warehouse_state WHERE id=1 FOR UPDATE');
    if (!stored.rowCount) return { changed: false, market, reason: 'warehouse-not-initialized' };

    // Do not limit by sync timestamp. We need the complete current WB order
    // state to know which reservations are still active.
    const orderRows = await client.query(`SELECT o.order_id,o.entry_id,o.status,o.state,o.creation_date,o.updated_at,o.qty,l.product_id
      FROM marketplace_order_lines o
      LEFT JOIN product_links l ON l.market=o.market AND l.sku=o.sku
      WHERE o.market=$1
      ORDER BY o.creation_date,o.order_id,o.entry_id`, [market]);

    const state = parsePayload(stored.rows[0].payload);
    const current = Array.isArray(state.reservations) ? state.reservations : [];
    const expected = new Map();
    let unlinked = 0;

    for (const row of orderRows.rows) {
      if (!wbOrderIsActive(row.status, row.state)) continue;
      const qty = Math.max(0, Number(row.qty) || 0);
      if (!row.product_id || qty === 0) {
        unlinked++;
        continue;
      }
      const reservation = stableReservation(market, row, row.product_id);
      expected.set(reservation.externalKey, reservation);
    }

    const next = [];
    let created = 0;
    let closed = 0;
    const seenCurrent = new Set();
    const now = Date.now();

    // Preserve history from other markets and inactive historical reservations.
    // For the market being reconciled, keep only the exact active set derived
    // from current WB orders; stale active rows are explicitly closed.
    for (const previous of current) {
      if (!sameText(previous?.source, market)) {
        next.push(previous);
        continue;
      }
      const key = String(previous?.externalKey || '');
      const replacement = expected.get(key);
      if (replacement) {
        const normalized = {
          ...previous,
          productId: replacement.productId,
          qty: replacement.qty,
          active: true,
          source: market,
          externalKey: replacement.externalKey,
          stage: 'new',
          date: Number(previous.date) || replacement.date,
          updatedAt: previous.productId === replacement.productId && Number(previous.qty) === replacement.qty &&
            previous.active === true && sameText(previous.stage, 'new')
            ? Number(previous.updatedAt) || replacement.updatedAt
            : now
        };
        next.push(normalized);
        seenCurrent.add(key);
      } else if (previous?.active === true) {
        next.push({ ...previous, active: false, stage: 'reconciled', closedAt: now, closeReason: 'not-active-in-full-wb-sync', updatedAt: now });
        closed++;
      } else {
        next.push(previous);
      }
    }

    for (const [key, replacement] of expected) {
      if (seenCurrent.has(key)) continue;
      next.push(replacement);
      created++;
    }

    const before = JSON.stringify(current);
    const after = JSON.stringify(next);
    if (before === after) {
      return { changed: false, market, activeOrders: expected.size, unlinked, created: 0, closed: 0, revision: Number(stored.rows[0].revision || 0) };
    }

    state.reservations = next;
    const raw = JSON.stringify(state);
    const revision = Number(stored.rows[0].revision || 0) + 1;
    await client.query('UPDATE warehouse_state SET payload=$1,revision=$2,updated_at=$3 WHERE id=1', [raw, revision, now]);
    const sha = crypto.createHash('sha256').update(raw).digest('hex').toUpperCase();
    await client.query('INSERT INTO warehouse_audit(revision,updated_at,payload_sha256,source) VALUES($1,$2,$3,$4)',
      [revision, now, sha, `${market.toLowerCase()}-reservation-reconcile-full`]);
    return { changed: true, market, activeOrders: expected.size, unlinked, created, closed, revision };
  });
}
