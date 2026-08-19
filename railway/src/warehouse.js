import crypto from 'node:crypto';
import express from 'express';
import { pool, transaction } from './db.js';
import { asyncRoute, requireTrustedOrigin, requireWritesEnabled } from './http.js';

export const warehouseRouter = express.Router();

function parsePayload(raw) {
  try { return JSON.parse(String(raw || '{}')); } catch { return {}; }
}

function cleanState(input) {
  const state = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const result = { ...state };
  for (const key of ['products', 'movements', 'sales', 'purchases', 'reservations', 'kaspiAdExpenses']) {
    result[key] = Array.isArray(state[key]) ? state[key] : [];
  }
  result.settings = state.settings && typeof state.settings === 'object' && !Array.isArray(state.settings) ? state.settings : {};
  return result;
}

async function mirrorProducts(client, products) {
  const now = Date.now();
  const ids = [];
  for (const product of products) {
    const id = String(product?.id || '').trim();
    if (!id) continue;
    ids.push(id);
    await client.query(`INSERT INTO products(id,name,category,photo,min_stock,stock,cost,total_profit,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,category=excluded.category,photo=excluded.photo,
      min_stock=excluded.min_stock,stock=excluded.stock,cost=excluded.cost,total_profit=excluded.total_profit,updated_at=excluded.updated_at`, [
      id, String(product?.name || ''), String(product?.category || ''), String(product?.photo || ''),
      Math.max(0, Number(product?.min ?? product?.minStock ?? 0) || 0), Number(product?.stock || 0) || 0,
      Math.max(0, Number(product?.cost || 0) || 0), Number(product?.totalProfit || 0) || 0,
      Number(product?.createdAt || now) || now, now
    ]);
    await client.query('DELETE FROM product_links WHERE product_id=$1', [id]);
    for (const [market, field] of [['Kaspi', 'kaspi'], ['WB', 'wb'], ['WB2', 'wb2'], ['Ozon', 'ozon']]) {
      const sku = String(product?.[field] || '').trim();
      if (!sku) continue;
      await client.query(`INSERT INTO product_links(product_id,market,sku,created_at,updated_at)
        VALUES($1,$2,$3,$4,$4) ON CONFLICT(market,sku) DO UPDATE SET product_id=excluded.product_id,updated_at=excluded.updated_at`,
      [id, market, sku, now]);
    }
  }
  if (ids.length) await client.query('DELETE FROM products WHERE NOT (id = ANY($1::text[]))', [ids]);
}

warehouseRouter.get('/warehouse-state', requireTrustedOrigin, asyncRoute(async (req, res) => {
  const metaOnly = req.query.meta === '1';
  const fields = metaOnly ? 'revision,updated_at' : 'payload,revision,updated_at';
  const result = await pool.query(`SELECT ${fields} FROM warehouse_state WHERE id=1`);
  if (!result.rowCount) return res.json({ ok: true, exists: false, revision: 0, updatedAt: null, state: metaOnly ? undefined : null });
  const row = result.rows[0];
  res.setHeader('ETag', `"${row.revision}"`);
  res.setHeader('X-Warehouse-Revision', String(row.revision));
  return res.json({
    ok: true,
    exists: true,
    revision: Number(row.revision || 0),
    updatedAt: Number(row.updated_at || 0),
    state: metaOnly ? undefined : parsePayload(row.payload)
  });
}));

warehouseRouter.put('/warehouse-state', requireTrustedOrigin, requireWritesEnabled, asyncRoute(async (req, res) => {
  const baseRevision = Number(req.body?.baseRevision || 0);
  const state = cleanState(req.body?.state);
  const raw = JSON.stringify(state);
  if (Buffer.byteLength(raw, 'utf8') > 1_500_000) return res.status(413).json({ ok: false, error: 'Warehouse snapshot is too large' });

  const result = await transaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [730021]);
    const current = await client.query('SELECT revision FROM warehouse_state WHERE id=1 FOR UPDATE');
    const currentRevision = Number(current.rows[0]?.revision || 0);
    if (current.rowCount && baseRevision !== currentRevision) return { conflict: true, revision: currentRevision };
    const revision = currentRevision + 1;
    const updatedAt = Date.now();
    await client.query(`INSERT INTO warehouse_state(id,payload,revision,updated_at) VALUES(1,$1,$2,$3)
      ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,revision=excluded.revision,updated_at=excluded.updated_at`,
    [raw, revision, updatedAt]);
    await mirrorProducts(client, state.products);
    const sha = crypto.createHash('sha256').update(raw).digest('hex').toUpperCase();
    await client.query('INSERT INTO warehouse_audit(revision,updated_at,payload_sha256,source) VALUES($1,$2,$3,$4)',
      [revision, updatedAt, sha, 'api']);
    return { revision, updatedAt };
  });
  if (result.conflict) return res.status(409).json({ ok: false, error: 'revision-conflict', revision: result.revision });
  res.setHeader('ETag', `"${result.revision}"`);
  return res.json({ ok: true, ...result, products: state.products.length });
}));

warehouseRouter.post('/warehouse-state-beacon', (_req, res) => res.status(204).end());

