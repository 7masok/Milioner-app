import crypto from 'node:crypto';
import express from 'express';
import { pool, transaction } from './db.js';
import { asyncRoute, requireTrustedOrigin, requireWritesEnabled } from './http.js';
import { stockLedgerViolation } from './warehouse-ledger.js';
import { pruneWarehouseBackups } from './warehouse-backups.js';
import { staleWbLinkRestored, preserveWbValidation } from './wb-link-validation.js';
import {
  hydrateWarehouseMovements,
  legacyCompatibleWarehouseState,
  parseWarehousePayload,
  persistWarehouseMovements,
  stripMovementsFromState
} from './warehouse-movements.js';
import {
  deleteWarehousePurchases,
  hydrateWarehousePurchases,
  persistWarehousePurchases,
  replaceWarehousePurchases,
  stripPurchasesFromState
} from './warehouse-purchases.js';

export const warehouseRouter = express.Router();
const MAX_WAREHOUSE_SNAPSHOT_BYTES = 6_000_000;

// Order feeds are canonical in their own PostgreSQL tables. They must not be
// kept inside the warehouse document as that creates a growing duplicate cache.
const DERIVED_CACHE_KEYS = ['kaspiOrderFeed', 'wbOrderFeed', 'ozonOrderFeed', 'kaspiOrders', 'marketOrderState', 'marketplaceLiveSince'];

const PATCH_FIELDS = ['products', 'sales', 'purchases', 'reservations', 'kaspiAdExpenses'];

export function warehouseEntityKey(field, row) {
  if (!row || typeof row !== 'object') return '';
  if (field === 'sales') return String(row.externalKey || row.id || '');
  if (field === 'reservations') return String(`${row.source || ''}|${row.externalKey || row.id || ''}`);
  if (field === 'kaspiAdExpenses') return String(row.id || row.importId || [row.date, row.day, row.productId, row.sku, row.amount].join('|'));
  return String(row.id || '');
}

export function applyWarehousePatch(previous, patch) {
  const base = previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {};
  const incoming = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
  const next = { ...base };
  const deleted = incoming.deleted && typeof incoming.deleted === 'object' ? incoming.deleted : {};
  for (const field of PATCH_FIELDS) {
    const hasRows = Object.prototype.hasOwnProperty.call(incoming, field);
    const removed = Array.isArray(deleted[field]) ? deleted[field].map(String) : [];
    if (!hasRows && !removed.length) continue;
    const map = new Map();
    for (const row of Array.isArray(base[field]) ? base[field] : []) {
      const key = warehouseEntityKey(field, row);
      if (key) map.set(key, row);
    }
    for (const key of removed) map.delete(key);
    for (const row of Array.isArray(incoming[field]) ? incoming[field] : []) {
      const key = warehouseEntityKey(field, row);
      if (key) map.set(key, row);
    }
    next[field] = [...map.values()];
  }
  if (incoming.settings && typeof incoming.settings === 'object' && !Array.isArray(incoming.settings)) next.settings = incoming.settings;
  if (Object.prototype.hasOwnProperty.call(incoming, 'kaspiBaselineAt')) next.kaspiBaselineAt = incoming.kaspiBaselineAt;
  delete next.deleted;
  delete next.movements;
  return cleanState(next);
}

function patchMovements(existing, upserts, removedIds) {
  const map = new Map();
  for (const row of Array.isArray(existing) ? existing : []) {
    const id = String(row?.id || '');
    if (id) map.set(id, row);
  }
  for (const id of Array.isArray(removedIds) ? removedIds : []) map.delete(String(id));
  for (const row of Array.isArray(upserts) ? upserts : []) {
    const id = String(row?.id || '');
    if (id) map.set(id, row);
  }
  return [...map.values()];
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
      const skus=marketplaceSkus(product,field);
      await client.query('DELETE FROM product_links WHERE product_id=$1 AND market=$2 AND NOT (sku = ANY($3::text[]))',[id,market,skus]);
      for (const sku of skus) {
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
      await client.query('DELETE FROM product_links WHERE product_id=$1 AND market=$2 AND NOT (sku = ANY($3::text[]))',[id,market,skus]);
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
  const result = await transaction(async client => {
    const fields = metaOnly ? 'revision,updated_at' : 'payload,revision,updated_at';
    const stored = await client.query(`SELECT ${fields} FROM warehouse_state WHERE id=1`);
    if (!stored.rowCount) return null;
    const row = stored.rows[0];
    const state = metaOnly ? undefined : await hydrateWarehousePurchases(client, await hydrateWarehouseMovements(client, parseWarehousePayload(row.payload)));
    return { row, state };
  });
  if (!result) return res.json({ ok: true, exists: false, revision: 0, updatedAt: null, state: metaOnly ? undefined : null });
  const { row, state } = result;
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
    const backupPayload = JSON.stringify(await legacyCompatibleWarehouseState(client, current.rows[0].payload));
    const inserted = await client.query(`INSERT INTO warehouse_backups(label,payload,revision,created_at)
      VALUES($1,$2,$3,$4) RETURNING id`, [label, backupPayload, current.rows[0].revision, createdAt]);
    await pruneWarehouseBackups(client);
    return { id: String(inserted.rows[0].id), revision: Number(current.rows[0].revision || 0), createdAt, label };
  });
  if (!result) return res.status(409).json({ ok: false, error: 'warehouse-state-is-empty' });
  return res.status(201).json({ ok: true, backup: result });
}));

warehouseRouter.put('/warehouse-state', requireTrustedOrigin, requireWritesEnabled, asyncRoute(async (req, res) => {
  const baseRevision = Number(req.body?.baseRevision || 0);
  const isPatch = req.body?.patch === true;
  const incomingState = req.body?.state;
  const movementsProvided = isPatch
    ? Array.isArray(incomingState?.movements) || (Array.isArray(incomingState?.deleted?.movements) && incomingState.deleted.movements.length > 0)
    : Array.isArray(incomingState?.movements);
  let state = isPatch ? null : cleanState(incomingState);
  if (!isPatch) {
    const earlyRaw = JSON.stringify(stripPurchasesFromState(stripMovementsFromState(state)));
    if (Buffer.byteLength(earlyRaw, 'utf8') > MAX_WAREHOUSE_SNAPSHOT_BYTES) return res.status(413).json({ ok: false, error: 'Warehouse snapshot is too large' });
  }

  const putStartedAt = Date.now();
  const timing = {};
  const result = await transaction(async client => {
    let stepStartedAt = Date.now();
    await client.query('SELECT pg_advisory_xact_lock($1)', [730021]);
    timing.lockMs = Date.now() - stepStartedAt;
    stepStartedAt = Date.now();
    const current = await client.query('SELECT payload,revision FROM warehouse_state WHERE id=1 FOR UPDATE');
    timing.readMs = Date.now() - stepStartedAt;
    const currentRevision = Number(current.rows[0]?.revision || 0);
    if (isPatch && !current.rowCount) return { conflict: true, revision: 0 };
    if (current.rowCount && baseRevision !== currentRevision) return { conflict: true, revision: currentRevision };
    let productsChanged = true;
    if (current.rowCount) {
      const previousStored = parseWarehousePayload(current.rows[0].payload);
      await hydrateWarehousePurchases(client, previousStored);
      if (isPatch) state = applyWarehousePatch(previousStored, incomingState);
      // Routine saves omit movements when the audit trail did not change.
      // In that case an empty movement delta is sufficient for the stock guard:
      // any stock change without a supplied movement is still rejected, while we
      // avoid reading and parsing the entire movement history on every save.
      const previous = movementsProvided ? await hydrateWarehouseMovements(client, { ...previousStored }) : { ...previousStored, movements: [] };
      if (movementsProvided && isPatch) state.movements = patchMovements(previous.movements, incomingState?.movements, incomingState?.deleted?.movements);
      if (!movementsProvided) state.movements = [];
      productsChanged = JSON.stringify(previousStored.products || []) !== JSON.stringify(state.products || []);
      const violation = stockLedgerViolation(previous, state) || staleWbLinkRestored(previous, state);
      if (violation) return { conflict: true, revision: currentRevision, stockGuard: violation };
      preserveWbValidation(previous, state);
    }
    const updatedAt = Date.now();
    const movementRows = isPatch ? incomingState?.movements : state.movements;
    if (movementsProvided && Array.isArray(movementRows) && movementRows.length) {
      const t = Date.now();
      await persistWarehouseMovements(client, movementRows, updatedAt);
      timing.movementsMs = Date.now() - t;
    }
    const purchasesTouched = !isPatch || Array.isArray(incomingState?.purchases) || (Array.isArray(incomingState?.deleted?.purchases) && incomingState.deleted.purchases.length > 0);
    const existingPurchases = await client.query('SELECT 1 FROM warehouse_purchases LIMIT 1');
    if (purchasesTouched && isPatch && existingPurchases.rowCount) {
      await persistWarehousePurchases(client, incomingState?.purchases || [], updatedAt);
      await deleteWarehousePurchases(client, incomingState?.deleted?.purchases || []);
    } else if (purchasesTouched || (!existingPurchases.rowCount && Array.isArray(state?.purchases) && state.purchases.length)) {
      await replaceWarehousePurchases(client, state.purchases, updatedAt);
    }
    const persistedSnapshot = stripPurchasesFromState(stripMovementsFromState(state));
    const raw = JSON.stringify(persistedSnapshot);
    if (Buffer.byteLength(raw, 'utf8') > MAX_WAREHOUSE_SNAPSHOT_BYTES) return { tooLarge: true };
    const revision = currentRevision + 1;
    stepStartedAt = Date.now();
    await client.query(`INSERT INTO warehouse_state(id,payload,revision,updated_at) VALUES(1,$1,$2,$3)
      ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,revision=excluded.revision,updated_at=excluded.updated_at`,
    [raw, revision, updatedAt]);
    timing.stateWriteMs = Date.now() - stepStartedAt;
    if (productsChanged) { const t = Date.now(); await mirrorProducts(client, state.products); timing.mirrorMs = Date.now() - t; }
    const sha = crypto.createHash('sha256').update(raw).digest('hex').toUpperCase();
    stepStartedAt = Date.now();
    await client.query('INSERT INTO warehouse_audit(revision,updated_at,payload_sha256,source) VALUES($1,$2,$3,$4)',
      [revision, updatedAt, sha, isPatch ? 'api-patch' : 'api']);
    timing.auditMs = Date.now() - stepStartedAt;
    return { revision, updatedAt, patched: isPatch };
  });
  const totalMs = Date.now() - putStartedAt;
  if (totalMs >= 1000) console.info('[warehouse-put-timing]', JSON.stringify({ totalMs, productsChanged: timing.mirrorMs != null, movementsProvided, patch: isPatch, ...timing }));
  if (result.tooLarge) return res.status(413).json({ ok: false, error: 'Warehouse snapshot is too large' });
  if (result.conflict) return res.status(409).json({ ok: false, error: result.stockGuard?'stock-ledger-conflict':'revision-conflict', revision: result.revision, stockGuard: result.stockGuard || undefined });
  res.setHeader('ETag', `"${result.revision}"`);
  return res.json({ ok: true, ...result, products: state.products.length });
}));

warehouseRouter.post('/warehouse-state-beacon', (_req, res) => res.status(204).end());
