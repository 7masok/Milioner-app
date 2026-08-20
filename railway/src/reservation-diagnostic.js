import express from 'express';
import { pool } from './db.js';
import { asyncRoute } from './http.js';

export const reservationDiagnosticRouter = express.Router();
const DIAG_KEY = 'rdiag-76f4d17c0e834db4a225';

function parsePayload(raw) {
  try {
    const value = JSON.parse(String(raw || '{}'));
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function parseExternalKey(source, value) {
  let key = String(value || '').trim();
  const prefix = String(source || '').trim() + ':';
  if (prefix !== ':' && key.startsWith(prefix)) key = key.slice(prefix.length);
  const split = key.indexOf(':');
  if (split <= 0 || split >= key.length - 1) return null;
  return { orderId: key.slice(0, split), entryId: key.slice(split + 1) };
}

async function decorateReservation(reservation) {
  const source = String(reservation.source || '');
  const parsed = parseExternalKey(source, reservation.externalKey);
  let exact = [];
  let candidates = [];
  if (parsed && source) {
    exact = (await pool.query(`SELECT market,order_id AS "orderId",entry_id AS "entryId",code,sku,product_name AS "productName",
      qty,status,state,creation_date AS "creationDate",updated_at AS "updatedAt"
      FROM marketplace_order_lines
      WHERE market=$1 AND order_id=$2 AND entry_id=$3
      ORDER BY updated_at DESC LIMIT 10`, [source, parsed.orderId, parsed.entryId])).rows;
    if (!exact.length) {
      candidates = (await pool.query(`SELECT market,order_id AS "orderId",entry_id AS "entryId",code,sku,product_name AS "productName",
        qty,status,state,creation_date AS "creationDate",updated_at AS "updatedAt"
        FROM marketplace_order_lines
        WHERE market=$1 AND entry_id=$2
        ORDER BY updated_at DESC LIMIT 10`, [source, parsed.entryId])).rows;
    }
  }
  return {
    id: reservation.id || null,
    productId: reservation.productId || null,
    qty: Number(reservation.qty || 0),
    source,
    externalKey: String(reservation.externalKey || ''),
    stage: reservation.stage || null,
    date: Number(reservation.date || 0) || null,
    updatedAt: Number(reservation.updatedAt || 0) || null,
    closedReason: reservation.closedReason || null,
    parsed,
    exact,
    candidates
  };
}

reservationDiagnosticRouter.get('/reservation-diagnostic', asyncRoute(async (req, res) => {
  if (String(req.query.key || '') !== DIAG_KEY) return res.status(404).json({ ok: false, error: 'not-found' });
  const query = String(req.query.name || 'луна').trim().toLocaleLowerCase('ru-RU');
  const snapshot = await pool.query('SELECT payload,revision,updated_at FROM warehouse_state WHERE id=1');
  if (!snapshot.rowCount) return res.json({ ok: true, products: [] });
  const state = parsePayload(snapshot.rows[0].payload);
  const allProducts = Array.isArray(state.products) ? state.products : [];
  const productById = new Map(allProducts.map(p => [String(p?.id || ''), p]));
  const products = allProducts.filter(product =>
    String(product?.name || '').toLocaleLowerCase('ru-RU').includes(query)
  );
  const reservations = Array.isArray(state.reservations) ? state.reservations : [];
  const activeReservationsAll = reservations.filter(r => r?.active);
  const output = [];

  for (const product of products) {
    const active = activeReservationsAll.filter(r => String(r.productId || '') === String(product.id || ''));
    const decorated = [];
    for (const reservation of active) decorated.push(await decorateReservation(reservation));

    const componentOf = [];
    for (const bundle of allProducts) {
      const components = Array.isArray(bundle?.components) ? bundle.components : [];
      const component = components.find(c => String(c?.productId || '') === String(product.id || ''));
      if (!component) continue;
      const bundleReservations = activeReservationsAll.filter(r => String(r.productId || '') === String(bundle.id || ''));
      const bundleDecorated = [];
      for (const reservation of bundleReservations) bundleDecorated.push(await decorateReservation(reservation));
      componentOf.push({
        id: bundle.id,
        name: bundle.name,
        kind: bundle.kind || null,
        componentQty: Math.max(1, Number(component.qty || 1)),
        activeReservations: bundleDecorated,
        derivedReserveQty: bundleDecorated.reduce((sum, r) => sum + Math.max(0, Number(r.qty || 0)) * Math.max(1, Number(component.qty || 1)), 0)
      });
    }

    output.push({
      id: product.id,
      name: product.name,
      kind: product.kind || null,
      stock: Number(product.stock || 0),
      kaspi: product.kaspi || '',
      wb: product.wb || '',
      wb2: product.wb2 || '',
      activeReservations: decorated,
      componentOf,
      directReserveQty: decorated.reduce((sum, r) => sum + Math.max(0, Number(r.qty || 0)), 0),
      derivedReserveQty: componentOf.reduce((sum, b) => sum + Number(b.derivedReserveQty || 0), 0)
    });
  }

  const allActiveSummary = activeReservationsAll.map(r => {
    const p = productById.get(String(r.productId || ''));
    return {
      productId: r.productId || null,
      productName: p?.name || null,
      qty: Number(r.qty || 0),
      source: String(r.source || ''),
      externalKey: String(r.externalKey || ''),
      stage: r.stage || null,
      date: Number(r.date || 0) || null,
      updatedAt: Number(r.updatedAt || 0) || null
    };
  });

  const sources = [...new Set([
    ...allActiveSummary.map(r => r.source),
    ...output.flatMap(p => [
      ...p.activeReservations.map(r => r.source),
      ...p.componentOf.flatMap(b => b.activeReservations.map(r => r.source))
    ])
  ].filter(Boolean))];
  const latestSync = [];
  for (const source of sources) {
    const run = await pool.query(`SELECT market,id,started_at AS "startedAt",finished_at AS "finishedAt",ok,items,error
      FROM sync_runs WHERE market=$1 ORDER BY id DESC LIMIT 1`, [source]);
    if (run.rows[0]) latestSync.push(run.rows[0]);
  }

  res.json({
    ok: true,
    revision: Number(snapshot.rows[0].revision || 0),
    warehouseUpdatedAt: Number(snapshot.rows[0].updated_at || 0),
    products: output,
    allActiveReservations: allActiveSummary,
    allActiveReservationQty: allActiveSummary.reduce((sum, r) => sum + Math.max(0, Number(r.qty || 0)), 0),
    latestSync
  });
}));
