import crypto from 'node:crypto';
import express from 'express';
import { pool, transaction } from './db.js';
import { asyncRoute, requireTrustedOrigin, requireWritesEnabled } from './http.js';

export const warehouseRouter = express.Router();

// Order feeds are canonical in their own PostgreSQL tables. They must not be
// kept inside the warehouse document as that creates a growing duplicate cache.
const DERIVED_CACHE_KEYS = ['kaspiOrderFeed', 'wbOrderFeed', 'ozonOrderFeed', 'kaspiOrders', 'marketOrderState', 'marketplaceLiveSince'];

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
  for (const key of DERIVED_CACHE_KEYS) delete result[key];
  return result;
}

function marketplaceSkus(product, field) {
  const primary = String(product?.[field] || '').trim();
  const rawAliases = product?.[`${field}Aliases`];
  const aliases = Array.isArray(rawAliases) ? rawAliases : String(rawAliases || '').split(/[;,\n]/);
  return [...new Set([primary, ...aliases].map(value => String(value || '').trim()).filter(Boolean))];
}

async function repairProductLinks(client, products) {
  const now = Date.now();
  for (const product of products || []) {
    const id = String(product?.id || '').trim();
    if (!id) continue;
    for (const [market, field] of [['Kaspi', 'kaspi'], ['WB', 'wb'], ['WB2', 'wb2'], ['Ozon', 'ozon']]) {
      for (const sku of marketplaceSkus(product, field)) {
        await client.query(`INSERT INTO product_links(product_id,market,sku,created_at,updated_at)
          VALUES($1,$2,$3,$4,$4) ON CONFLICT(market,sku) DO UPDATE SET product_id=excluded.product_id,updated_at=excluded.updated_at`,
        [id, market, sku, now]);
      }
    }
  }
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
    for (const [market, field] of [['Kaspi', 'kaspi'], ['WB', 'wb'], ['WB2', 'wb2'], ['Ozon', 'ozon']]) {
      const skus = marketplaceSkus(product, field);
      // A stale device snapshot may omit one marketplace field. Never erase a
      // valid server-side link merely because that field arrived empty.
      if (skus.length) await client.query('DELETE FROM product_links WHERE product_id=$1 AND market=$2 AND NOT (sku = ANY($3::text[]))', [id, market, skus]);
      for (const sku of skus) {
        await client.query(`INSERT INTO product_links(product_id,market,sku,created_at,updated_at)
          VALUES($1,$2,$3,$4,$4) ON CONFLICT(market,sku) DO UPDATE SET product_id=excluded.product_id,updated_at=excluded.updated_at`,
        [id, market, sku, now]);
      }
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
  const state = metaOnly ? undefined : parsePayload(row.payload);
  if (!metaOnly) {
    // Self-heal normalized marketplace links after migration or a partial sync.
    // The warehouse snapshot remains authoritative for product -> marketplace SKU mapping.
    await repairProductLinks(pool, state.products);
  }
  res.setHeader('ETag', `"${row.revision}"`);
  res.setHeader('X-Warehouse-Revision', String(row.revision));
  return res.json({
    ok: true,
    exists: true,
    revision: Number(row.revision || 0),
    updatedAt: Number(row.updated_at || 0),
    state
  });
}));

warehouseRouter.get('/warehouse-backups', requireTrustedOrigin, asyncRoute(async (_req, res) => {
  const result = await pool.query(`SELECT id,label,revision,created_at AS "createdAt"
    FROM warehouse_backups ORDER BY created_at DESC LIMIT 50`);
  return res.json({ ok: true, backups: result.rows.map(row => ({ ...row, revision: Number(row.revision || 0), createdAt: Number(row.createdAt || 0) })) });
}));

warehouseRouter.post('/warehouse-backups', requireTrustedOrigin, requireWritesEnabled, asyncRoute(async (req, res) => {
  const label = String(req.body?.label || 'manual').trim().slice(0, 160) || 'manual';
  const result = await transaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [730021]);
    const current = await client.query('SELECT payload,revision FROM warehouse_state WHERE id=1 FOR SHARE');
    if (!current.rowCount) return null;
    const createdAt = Date.now();
    const inserted = await client.query(`INSERT INTO warehouse_backups(label,payload,revision,created_at)
      VALUES($1,$2,$3,$4) RETURNING id`, [label, current.rows[0].payload, current.rows[0].revision, createdAt]);
    return { id: String(inserted.rows[0].id), revision: Number(current.rows[0].revision || 0), createdAt, label };
  });
  if (!result) return res.status(409).json({ ok: false, error: 'warehouse-state-is-empty' });
  return res.status(201).json({ ok: true, backup: result });
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
