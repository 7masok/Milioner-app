import express from 'express';
import { pool } from './db.js';
import { asyncRoute } from './http.js';

export const ordersRouter = express.Router();

function market(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (normalized === 'WB1') return 'WB';
  if (normalized === 'KASPI') return 'Kaspi';
  return normalized;
}

function normalizeName(value) {
  return String(value || '')
    .toLocaleLowerCase('ru-RU')
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/gi, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const cur = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        cur[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

function similarity(a, b) {
  const left = normalizeName(a), right = normalizeName(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const max = Math.max(left.length, right.length);
  return max ? 1 - levenshtein(left, right) / max : 0;
}

function safeNameFallback(row, products) {
  if (row.productId || !row.productName) return null;
  const scored = products
    .map(product => ({ product, score: similarity(row.productName, product.name) }))
    .filter(item => item.score >= 0.94)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return null;
  if (scored.length > 1 && scored[0].score - scored[1].score < 0.03) return null;
  return scored[0].product;
}

ordersRouter.get('/orders', asyncRoute(async (req, res) => {
  const selected = market(req.query.market);
  const limit = Math.max(1, Math.min(5000, Number(req.query.limit || 1000) || 1000));
  const params = [];
  const where = selected ? `WHERE o.market=$${params.push(selected)}` : '';
  params.push(limit);
  const [rows, products] = await Promise.all([
    pool.query(`SELECT o.market,o.order_id AS "orderId",o.code,o.entry_id AS "entryId",o.status,o.state,
      o.creation_date AS "creationDate",o.sku,o.product_name AS "productName",o.qty,o.unit_price AS "unitPrice",
      o.total_price AS "totalPrice",o.seller_delivery_cost AS "sellerDeliveryCost",o.marketplace_fee AS "marketplaceFee",
      o.fee_source AS "feeSource",l.product_id AS "productId"
      FROM marketplace_order_lines o LEFT JOIN product_links l ON l.market=o.market AND l.sku=o.sku
      ${where} ORDER BY o.creation_date DESC LIMIT $${params.length}`, params),
    pool.query('SELECT id,name FROM products')
  ]);
  const out = rows.rows.map(row => {
    if (row.productId) return row;
    const fallback = safeNameFallback(row, products.rows);
    return fallback ? { ...row, productId: fallback.id, productName: fallback.name, linkSource: 'name-typo-fallback' } : row;
  });
  res.json({ ok: true, orders: out });
}));
