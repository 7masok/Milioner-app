import express from 'express';
import { pool } from './db.js';
import { requireTrustedOrigin } from './http.js';

export const warehouseRescueRouter = express.Router();

function parsePayload(raw) {
  try { return JSON.parse(String(raw || '{}')); } catch { return {}; }
}

warehouseRescueRouter.get('/warehouse-state', requireTrustedOrigin, async (req, res, next) => {
  try {
    const metaOnly = req.query.meta === '1';
    const result = await pool.query('SELECT payload,revision,updated_at FROM warehouse_state WHERE id=1');
    if (!result.rowCount) return next();

    const row = result.rows[0];
    if (metaOnly) {
      res.setHeader('ETag', `"${row.revision}"`);
      res.setHeader('X-Warehouse-Revision', String(row.revision));
      return res.json({ ok: true, exists: true, revision: Number(row.revision || 0), updatedAt: Number(row.updated_at || 0) });
    }

    const state = parsePayload(row.payload);
    const currentProducts = Array.isArray(state.products) ? state.products : [];
    if (currentProducts.length === 0) {
      const products = await pool.query(`SELECT p.id,p.name,p.category,p.photo,p.min_stock AS min,p.stock,p.cost,p.total_profit AS "totalProfit",
        MAX(CASE WHEN l.market='Kaspi' THEN l.sku END) AS kaspi,
        MAX(CASE WHEN l.market='WB' THEN l.sku END) AS wb,
        MAX(CASE WHEN l.market='WB2' THEN l.sku END) AS wb2,
        MAX(CASE WHEN l.market='Ozon' THEN l.sku END) AS ozon
        FROM products p LEFT JOIN product_links l ON l.product_id=p.id
        GROUP BY p.id ORDER BY p.name`);
      if (products.rowCount > 0) {
        state.products = products.rows.map(p => ({
          id: String(p.id), name: String(p.name || ''), category: String(p.category || ''), photo: String(p.photo || ''),
          min: Number(p.min || 0), stock: Number(p.stock || 0), cost: Number(p.cost || 0), totalProfit: Number(p.totalProfit || 0),
          kaspi: String(p.kaspi || ''), wb: String(p.wb || ''), wb2: String(p.wb2 || ''), ozon: String(p.ozon || '')
        }));
        state.movements = Array.isArray(state.movements) ? state.movements : [];
        state.sales = Array.isArray(state.sales) ? state.sales : [];
        state.purchases = Array.isArray(state.purchases) ? state.purchases : [];
        state.reservations = Array.isArray(state.reservations) ? state.reservations : [];
        state.kaspiAdExpenses = Array.isArray(state.kaspiAdExpenses) ? state.kaspiAdExpenses : [];
        state.settings = state.settings && typeof state.settings === 'object' ? state.settings : {};
        state.settings.recoveredProductsFromDb = Date.now();
      }
    }

    res.setHeader('ETag', `"${row.revision}"`);
    res.setHeader('X-Warehouse-Revision', String(row.revision));
    return res.json({ ok: true, exists: true, revision: Number(row.revision || 0), updatedAt: Number(row.updated_at || 0), state });
  } catch (error) { next(error); }
});
