import express from 'express';
import { pool } from './db.js';
import { asyncRoute, requireTrustedOrigin } from './http.js';

export const stockRouter = express.Router();

function n(value, fallback = 0) {
  const x = Number(value);
  return Number.isFinite(x) ? x : fallback;
}

function normalizeSku(value) {
  return String(value ?? '').trim();
}

// Kaspi uses the XML price-list itself to decide which seller offers remain
// on sale. A zero-stock product must NOT be sent as an <offer>: Kaspi's own
// guidance says products omitted from the latest price-list are moved to
// "Сняты с продажи". Sending stockCount=0 keeps the SKU in the price-list
// and can cause a manually removed product to reappear.
//
// Positive stock is still derived from the current normalized warehouse
// product stock, not from orders/reservations or an old warehouse snapshot.
export async function kaspiFeedRows() {
  const result = await pool.query(`
    SELECT pl.sku,
           p.stock,
           p.name
    FROM product_links pl
    JOIN products p ON p.id = pl.product_id
    WHERE pl.market = 'Kaspi'
      AND TRIM(pl.sku) <> ''
      AND COALESCE(p.stock, 0) > 0
    ORDER BY pl.sku
  `);
  return result.rows.map(row => ({
    sku: normalizeSku(row.sku),
    stock: Math.max(0, Math.floor(n(row.stock, 0))),
    name: String(row.name || '')
  }));
}

export const kaspiFeedHandler = asyncRoute(async (_req, res) => {
  const rows = await kaspiFeedRows();
  res.type('application/xml');
  const esc = value => String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');

  const offers = rows.map(row => `    <offer sku="${esc(row.sku)}"><stockCount>${row.stock}</stockCount></offer>`).join('\n');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<kaspi_catalog date="${new Date().toISOString()}">\n  <offers>\n${offers}\n  </offers>\n</kaspi_catalog>`);
});

// Expose a diagnostic endpoint for the UI/ops checks.
stockRouter.get('/stock-sync-status', requireTrustedOrigin, asyncRoute(async (_req, res) => {
  const result = await pool.query(`
    SELECT COUNT(*)::int AS links,
           COUNT(*) FILTER (WHERE p.updated_at IS NULL)::int AS missing_updates,
           MAX(p.updated_at) AS last_product_update
    FROM product_links pl
    JOIN products p ON p.id = pl.product_id
    WHERE pl.market = 'Kaspi'
  `);
  res.json({ ok: true, market: 'Kaspi', ...result.rows[0] });
}));
