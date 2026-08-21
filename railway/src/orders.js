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

function nameTokens(value) {
  return normalizeName(value).split(' ').filter(Boolean);
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

function candidateScore(orderName, productName) {
  const direct = similarity(orderName, productName);
  const orderTokens = new Set(nameTokens(orderName));
  const productTokens = nameTokens(productName);
  if (productTokens.length >= 2 && productTokens.every(token => orderTokens.has(token))) {
    // A short warehouse name such as "Стич Розовый" can be a strict subset of
    // the longer Kaspi title "Брелок LuxAr Стич Розовый 6 см ...". Treat this
    // as high confidence, while still requiring uniqueness below.
    return Math.max(direct, 0.985 + Math.min(0.014, productTokens.length * 0.002));
  }
  return direct;
}

function safeNameFallback(row, products) {
  if (row.productId || !row.productName) return null;
  const scored = products
    .map(product => ({ product, score: candidateScore(row.productName, product.name) }))
    .filter(item => item.score >= 0.94)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return null;
  if (scored.length > 1 && scored[0].score - scored[1].score < 0.015) return null;
  return scored[0];
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
      o.fee_source AS "feeSource",o.updated_at AS "updatedAt",resolved.product_id AS "productId",resolved.link_source AS "linkSource"
      FROM marketplace_order_lines o
      LEFT JOIN LATERAL (
        SELECT pl.product_id,
          CASE WHEN pl.sku=o.sku THEN 'sku-exact' ELSE 'kaspi-sku-alias' END AS link_source
        FROM product_links pl
        WHERE pl.market=o.market AND (
          pl.sku=o.sku OR (
            o.market='Kaspi' AND EXISTS (
              SELECT 1 FROM kaspi_sku_aliases a
              WHERE (a.old_sku=o.sku AND a.seller_sku=pl.sku)
                 OR (a.seller_sku=o.sku AND a.old_sku=pl.sku)
            )
          )
        )
        ORDER BY CASE WHEN pl.sku=o.sku THEN 0 ELSE 1 END
        LIMIT 1
      ) resolved ON TRUE
      ${where} ORDER BY o.creation_date DESC LIMIT $${params.length}`, params),
    pool.query('SELECT id,name FROM products')
  ]);
  const inferredLinks = new Map();
  const out = rows.rows.map(row => {
    if (row.productId) return row;
    const fallback = safeNameFallback(row, products.rows);
    if (!fallback) return row;
    if (row.market === 'Kaspi' && row.sku) inferredLinks.set(String(row.sku), String(fallback.product.id));
    return { ...row, productId: fallback.product.id, productName: fallback.product.name, linkSource: 'name-safe-fallback' };
  });

  // Persist only unique, high-confidence Kaspi title matches so the next load is
  // resolved by SKU and does not depend on title matching again.
  const now = Date.now();
  for (const [sku, productId] of inferredLinks) {
    await pool.query(`INSERT INTO product_links(product_id,market,sku,created_at,updated_at)
      VALUES($1,'Kaspi',$2,$3,$3)
      ON CONFLICT(market,sku) DO NOTHING`, [productId, sku, now]);
  }

  res.json({ ok: true, orders: out });
}));
