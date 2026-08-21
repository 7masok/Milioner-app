import crypto from 'node:crypto';
import { transaction } from './db.js';

function parsePayload(raw) {
  try { return JSON.parse(String(raw || '{}')); } catch { return {}; }
}

function orderKey(market, orderId, entryId) {
  return `${market}:${String(orderId)}:${String(entryId)}`;
}

function legacyKey(orderId, entryId) {
  return `${String(orderId)}:${String(entryId)}`;
}

function sameText(left, right) {
  return String(left ?? '') === String(right ?? '');
}

function wbOrderIsActive(status, state) {
  const supplier = String(status || '').toUpperCase();
  const wb = String(state || '').toUpperCase();
  if (['CANCEL', 'CANCELLED'].includes(supplier)) return false;
  if (['CANCELED', 'CANCELLED', 'CANCELED_BY_CLIENT', 'DECLINED_BY_CLIENT', 'DEFECT'].includes(wb)) return false;
  if (['SORTED', 'ACCEPTED_BY_CARRIER', 'SENT_TO_CARRIER', 'READY_FOR_PICKUP', 'SOLD'].includes(wb)) return false;
  return true;
}

function reservationMatches(reservation, market, scoped, legacy) {
  return sameText(reservation?.source, market) && (sameText(reservation?.externalKey, scoped) || sameText(reservation?.externalKey, legacy));
}

function stableReservation(market, row, productId) {
  const scoped = orderKey(market, row.order_id, row.entry_id);
  return {
    id: `server-${market.toLowerCase()}-${String(row.order_id)}-${String(row.entry_id)}`,
    productId: String(productId),
    qty: Math.max(0, Number(row.qty) || 0),
    active: true,
    source: market,
    externalKey: scoped,
    stage: 'new',
    date: Number(row.creation_date) || Date.now(),
    updatedAt: Number(row.updated_at) || Date.now()
  };
}

// A confirmed WB sync is authoritative for active WB reservations.  This
// deliberately changes only reservation rows: inventory, purchases and sales
// are never modified here.
export async function reconcileWbReservations(market, syncedSince) {
  if (!['WB', 'WB2'].includes(market)) throw new Error('Unsupported WB market');
  const since = Math.max(0, Number(syncedSince) || 0);
  if (!since) return { changed: false, market, reason: 'missing-sync-cutoff' };

  return transaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [730021]);
    const stored = await client.query('SELECT payload,revision FROM warehouse_state WHERE id=1 FOR UPDATE');
    if (!stored.rowCount) return { changed: false, market, reason: 'warehouse-not-initialized' };

    const orderRows = await client.query(`SELECT o.order_id,o.entry_id,o.status,o.state,o.creation_date,o.updated_at,o.qty,l.product_id
      FROM marketplace_order_lines o
      LEFT JOIN product_links l ON l.market=o.market AND l.sku=o.sku
      WHERE o.market=$1 AND o.updated_at >= $2
      ORDER BY o.creation_date,o.order_id,o.entry_id`, [market, since]);

    const state = parsePayload(stored.rows[0].payload);
    const current = Array.isArray(state.reservations) ? state.reservations : [];
    const expected = [];
    let unlinked = 0;
    for (const row of orderRows.rows) {
      if (!wbOrderIsActive(row.status, row.state)) continue;
      if (!row.product_id || Math.max(0, Number(row.qty) || 0) === 0) { unlinked++; continue; }
      expected.push({ row, scoped: orderKey(market, row.order_id, row.entry_id), legacy: legacyKey(row.order_id, row.entry_id) });
    }

    const next = current.map(item => ({ ...item }));
    const used = new Set();
    let changed = false;
    let created = 0;
    let closed = 0;

    for (const item of expected) {
      let index = next.findIndex((reservation, i) => !used.has(i) && reservationMatches(reservation, market, item.scoped, item.legacy));
      const replacement = stableReservation(market, item.row, item.row.product_id);
      if (index < 0) {
        next.push(replacement);
        used.add(next.length - 1);
        changed = true;
        created++;
        continue;
      }
      used.add(index);
      const previous = next[index];
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
          previous.active === true && sameText(previous.externalKey, replacement.externalKey) && sameText(previous.stage, 'new')
          ? Number(previous.updatedAt) || replacement.updatedAt
          : Date.now()
      };
      if (JSON.stringify(previous) !== JSON.stringify(normalized)) {
        next[index] = normalized;
        changed = true;
      }
    }

    const now = Date.now();
    for (let index = 0; index < next.length; index++) {
      const reservation = next[index];
      if (!sameText(reservation?.source, market) || reservation?.active !== true || used.has(index)) continue;
      next[index] = { ...reservation, active: false, stage: 'reconciled', closedAt: now, closeReason: 'not-active-in-confirmed-wb-sync', updatedAt: now };
      changed = true;
      closed++;
    }

    if (!changed) {
      return { changed: false, market, activeOrders: expected.length, unlinked, created: 0, closed: 0, revision: Number(stored.rows[0].revision || 0) };
    }

    state.reservations = next;
    const raw = JSON.stringify(state);
    const revision = Number(stored.rows[0].revision || 0) + 1;
    await client.query('UPDATE warehouse_state SET payload=$1,revision=$2,updated_at=$3 WHERE id=1', [raw, revision, now]);
    const sha = crypto.createHash('sha256').update(raw).digest('hex').toUpperCase();
    await client.query('INSERT INTO warehouse_audit(revision,updated_at,payload_sha256,source) VALUES($1,$2,$3,$4)',
      [revision, now, sha, `${market.toLowerCase()}-reservation-reconcile`]);
    return { changed: true, market, activeOrders: expected.length, unlinked, created, closed, revision };
  });
}
