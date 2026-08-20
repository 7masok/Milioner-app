import express from 'express';
import { pool } from './db.js';

export const kaspiLiveReportRouter = express.Router();
const ALMATY_OFFSET = 5 * 60 * 60 * 1000;
const CANCELLED = new Set(['CANCELLED','CANCELLING','RETURNED','KASPI_DELIVERY_RETURN_REQUESTED']);

function periodBounds(days = 1, from = 0, to = 0) {
  if (Number(days) === 0 && Number(from) > 0 && Number(to) > Number(from)) return { start: Number(from), end: Number(to) };
  const local = new Date(Date.now() + ALMATY_OFFSET);
  const today = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - ALMATY_OFFSET;
  if (Number(days) === -1) return { start: today - 86_400_000, end: today };
  const count = Math.max(1, Math.min(365, Number(days) || 1));
  return { start: today - (count - 1) * 86_400_000, end: today + 86_400_000 };
}

kaspiLiveReportRouter.get('/kaspi-report-orders', async (req, res, next) => {
  try {
    const days = Number(req.query.days || 1);
    const bounds = periodBounds(days, req.query.from, req.query.to);
    const rows = await pool.query(`SELECT o.order_id AS id,o.code,o.status,o.state,o.creation_date AS "creationDate",
      o.entry_id AS "entryId",o.sku,o.product_name AS "productName",o.qty,o.unit_price AS "unitPrice",
      o.total_price AS "lineTotal",o.seller_delivery_cost AS "sellerDeliveryCost",l.product_id AS "productId"
      FROM marketplace_order_lines o
      LEFT JOIN product_links l ON l.market='Kaspi' AND l.sku=o.sku
      WHERE o.market='Kaspi' AND o.creation_date >= $1 AND o.creation_date < $2
      ORDER BY o.creation_date,o.order_id,o.entry_id`, [bounds.start, bounds.end]);

    const grouped = new Map();
    for (const row of rows.rows) {
      if (CANCELLED.has(String(row.status || '').toUpperCase())) continue;
      const id = String(row.id || '').trim();
      if (!id) continue;
      let order = grouped.get(id);
      if (!order) {
        order = {
          id,
          code: row.code || id,
          // The current report is intentionally based on active orders by creation time.
          // The browser's older report layer only accepts COMPLETED rows, so expose the
          // active order as report-ready while preserving the real state separately.
          status: 'COMPLETED',
          sourceStatus: row.status,
          state: row.state,
          creationDate: Number(row.creationDate) || 0,
          completionDate: Number(row.creationDate) || 0,
          approvedByBankDate: Number(row.creationDate) || 0,
          totalPrice: 0,
          deliveryCostForSeller: 0,
          lines: []
        };
        grouped.set(id, order);
      }
      const qty = Math.max(0, Number(row.qty) || 0);
      const total = Math.max(0, Number(row.lineTotal) || (Number(row.unitPrice) || 0) * qty);
      order.totalPrice += total;
      order.deliveryCostForSeller += Math.max(0, Number(row.sellerDeliveryCost) || 0);
      order.lines.push({
        id: row.entryId,
        entryId: row.entryId,
        merchantCode: row.sku,
        sku: row.sku,
        productName: row.productName,
        quantity: qty,
        qty,
        unitPrice: Number(row.unitPrice) || 0,
        totalPrice: total,
        productId: row.productId || null
      });
    }

    const returnsResult = await pool.query(`SELECT order_id AS id,code,amount,return_date AS "returnDate",
      original_completion_date AS "originalCompletionDate",detected_at AS "detectedAt",date_source AS "dateSource"
      FROM kaspi_report_returns WHERE return_date >= $1 AND return_date < $2 ORDER BY return_date`, [bounds.start, bounds.end]);

    res.json({
      ok: true,
      days,
      from: req.query.from ? Number(req.query.from) : null,
      to: req.query.to ? Number(req.query.to) : null,
      fetchedAt: Date.now(),
      source: 'PostgreSQL current Kaspi order feed by creation date',
      historyComplete: true,
      coverageFrom: bounds.start,
      coverageTo: bounds.end,
      lastRefreshAt: Date.now(),
      warnings: [],
      orders: [...grouped.values()],
      returns: returnsResult.rows
    });
  } catch (error) { next(error); }
});
