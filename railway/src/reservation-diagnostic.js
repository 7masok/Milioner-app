import express from 'express';
import { pool } from './db.js';
import { asyncRoute, requireTrustedOrigin } from './http.js';

export const reservationDiagnosticRouter = express.Router();

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

reservationDiagnosticRouter.get('/reservation-diagnostic', requireTrustedOrigin, asyncRoute(async (req, res) => {
  const query = String(req.query.name || 'луна').trim().toLocaleLowerCase('ru-RU');
  const snapshot = await pool.query('SELECT payload,revision,updated_at FROM warehouse_state WHERE id=1');
  if (!snapshot.rowCount) return res.json({ ok: true, products: [] });
  const state = parsePayload(snapshot.rows[0].payload);
  const products = (Array.isArray(state.products) ? state.products : []).filter(product =>
    String(product?.name || '').toLocaleLowerCase('ru-RU').includes(query)
  );
  const reservations = Array.isArray(state.reservations) ? state.reservations : [];
  const output = [];

  for (const product of products) {
    const active = reservations.filter(r => r?.active && String(r.productId || '') === String(product.id || ''));
    const decorated = [];
    for (const reservation of active) {
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
      decorated.push({
        id: reservation.id || null,
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
      });
    }
    output.push({
      id: product.id,
      name: product.name,
      stock: Number(product.stock || 0),
      kaspi: product.kaspi || '',
      wb: product.wb || '',
      wb2: product.wb2 || '',
      activeReservations: decorated
    });
  }

  const sources = [...new Set(output.flatMap(p => p.activeReservations.map(r => r.source)).filter(Boolean))];
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
    latestSync
  });
}));
