import express from 'express';
import { pool } from './db.js';
import { asyncRoute } from './http.js';

export const reportsRouter = express.Router();
const ALMATY_OFFSET = 5 * 60 * 60 * 1000;

function market(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (normalized === 'WB1') return 'WB';
  if (normalized === 'KASPI') return 'Kaspi';
  return normalized;
}

function periodBounds(days = 1) {
  const local = new Date(Date.now() + ALMATY_OFFSET);
  const today = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - ALMATY_OFFSET;
  if (Number(days) === -1) return { since: today - 86_400_000, until: today };
  const count = Math.max(1, Math.min(365, Number(days) || 1));
  return { since: today - (count - 1) * 86_400_000, until: today + 86_400_000 };
}

function dateKey(timestamp) {
  return new Date(timestamp + ALMATY_OFFSET).toISOString().slice(0, 10);
}

function kaspiBounds(days, from, to) {
  if (Number(days) === 0 && Number(from) > 0 && Number(to) > Number(from)) return { start: Number(from), end: Number(to) };
  const { since, until } = periodBounds(days);
  return { start: since, end: until };
}

function groupLiveKaspiOrders(rows) {
  const byOrder = new Map();
  for (const row of rows) {
    const id = String(row.orderId || '');
    if (!id) continue;
    let order = byOrder.get(id);
    if (!order) {
      order = {
        id, code: String(row.code || ''), status: String(row.status || ''), state: String(row.state || ''),
        creationDate: Number(row.creationDate || 0), completionDate: Number(row.creationDate || 0),
        approvedByBankDate: null, totalPrice: 0, deliveryCostForSeller: 0, entryCount: 0, lines: []
      };
      byOrder.set(id, order);
    }
    const qty = Math.max(0, Number(row.qty || 0));
    const total = Math.max(0, Number(row.totalPrice || 0));
    order.totalPrice += total;
    order.deliveryCostForSeller += Math.max(0, Number(row.sellerDeliveryCost || 0));
    order.entryCount += row.entryId === '__pending__' ? 0 : 1;
    if (row.entryId !== '__pending__') {
      order.lines.push({
        entryId: String(row.entryId || ''), merchantCode: String(row.sku || ''),
        productName: String(row.productName || ''), quantity: qty,
        basePrice: qty ? total / qty : 0, totalPrice: total
      });
    }
  }
  return [...byOrder.values()];
}

function parseCachedKaspiOrders(rows) {
  return rows.map(row => {
    let lines = [], entryCount = 0;
    try { const parsed = JSON.parse(row.linesJson || '[]'); if (Array.isArray(parsed)) lines = parsed; } catch {}
    try { entryCount = Math.max(0, Number(JSON.parse(row.rawJson || '{}')?.entryCount) || 0); } catch {}
    const { linesJson, rawJson, ...order } = row;
    return { ...order, entryCount, lines };
  });
}

reportsRouter.get('/orders', asyncRoute(async (req, res) => {
  const selected = market(req.query.market);
  const limit = Math.max(1, Math.min(5000, Number(req.query.limit || 1000) || 1000));
  const params = [];
  const where = selected ? `WHERE o.market=$${params.push(selected)}` : '';
  params.push(limit);
  const rows = await pool.query(`SELECT o.market,o.order_id AS "orderId",o.code,o.entry_id AS "entryId",o.status,o.state,
    o.creation_date AS "creationDate",o.sku,o.product_name AS "productName",o.qty,o.unit_price AS "unitPrice",
    o.total_price AS "totalPrice",o.seller_delivery_cost AS "sellerDeliveryCost",o.marketplace_fee AS "marketplaceFee",
    o.fee_source AS "feeSource",l.product_id AS "productId"
    FROM marketplace_order_lines o LEFT JOIN product_links l ON l.market=o.market AND l.sku=o.sku
    ${where} ORDER BY o.creation_date DESC LIMIT $${params.length}`, params);
  res.json({ ok: true, orders: rows.rows });
}));

reportsRouter.get('/products', asyncRoute(async (_req, res) => {
  const rows = await pool.query(`SELECT p.id,p.name,p.category,p.photo,p.min_stock AS min,p.stock,p.cost,p.total_profit AS "totalProfit",
    MAX(CASE WHEN l.market='Kaspi' THEN l.sku END) AS kaspi,
    MAX(CASE WHEN l.market='WB' THEN l.sku END) AS wb,
    MAX(CASE WHEN l.market='WB2' THEN l.sku END) AS wb2,
    MAX(CASE WHEN l.market='Ozon' THEN l.sku END) AS ozon
    FROM products p LEFT JOIN product_links l ON l.product_id=p.id GROUP BY p.id ORDER BY p.name`);
  res.json({ ok: true, products: rows.rows });
}));

reportsRouter.get('/market-status', asyncRoute(async (_req, res) => {
  const result = [];
  for (const selected of ['Kaspi', 'WB', 'WB2', 'Ozon']) {
    const [latest, success, count] = await Promise.all([
      pool.query('SELECT * FROM sync_runs WHERE market=$1 ORDER BY id DESC LIMIT 1', [selected]),
      pool.query('SELECT MAX(finished_at) AS "lastSuccessAt" FROM sync_runs WHERE market=$1 AND ok=1', [selected]),
      pool.query('SELECT COUNT(*)::bigint AS n FROM marketplace_order_lines WHERE market=$1', [selected])
    ]);
    result.push({ market: selected, configured: selected !== 'Ozon', latest: latest.rows[0] || null,
      lastSuccessAt: Number(success.rows[0]?.lastSuccessAt || 0) || null, orderLines: Number(count.rows[0]?.n || 0) });
  }
  res.json({ ok: true, serverTime: Date.now(), markets: result });
}));

reportsRouter.get('/kaspi-report-orders', asyncRoute(async (req, res) => {
  const bounds = kaspiBounds(Number(req.query.days || 1), req.query.from, req.query.to);
  const [liveResult, cachedResult, returnsResult, latestSyncResult, coverageResult] = await Promise.all([
    pool.query(`SELECT order_id AS "orderId",code,entry_id AS "entryId",status,state,creation_date AS "creationDate",
      sku,product_name AS "productName",qty,total_price AS "totalPrice",seller_delivery_cost AS "sellerDeliveryCost"
      FROM marketplace_order_lines
      WHERE market='Kaspi' AND creation_date >= $1 AND creation_date < $2
      ORDER BY creation_date,order_id,entry_id`, [bounds.start, bounds.end]),
    pool.query(`SELECT order_id AS id,code,status,state,creation_date AS "creationDate",completion_date AS "completionDate",
      approved_by_bank_date AS "approvedByBankDate",total_price AS "totalPrice",delivery_cost_for_seller AS "deliveryCostForSeller",
      lines_json AS "linesJson",raw_json AS "rawJson" FROM kaspi_report_orders
      WHERE completion_date >= $1 AND completion_date < $2 ORDER BY completion_date`, [bounds.start, bounds.end]),
    pool.query(`SELECT order_id AS id,code,amount,return_date AS "returnDate",original_completion_date AS "originalCompletionDate",
      detected_at AS "detectedAt",date_source AS "dateSource" FROM kaspi_report_returns
      WHERE return_date >= $1 AND return_date < $2 ORDER BY return_date`, [bounds.start, bounds.end]),
    pool.query(`SELECT finished_at AS "lastRefreshAt",items AS "lastItems",error AS "lastError"
      FROM sync_runs WHERE market='Kaspi' ORDER BY id DESC LIMIT 1`),
    pool.query(`SELECT MIN(creation_date) AS "coverageFrom",MAX(creation_date) AS "coverageTo"
      FROM marketplace_order_lines WHERE market='Kaspi' AND creation_date>0`)
  ]);
  // PostgreSQL marketplace lines are the live source. The older report cache
  // remains only as a history fallback and is overridden order-by-order by
  // current synchronized data.
  const ordersById = new Map(parseCachedKaspiOrders(cachedResult.rows).map(order => [String(order.id), order]));
  for (const order of groupLiveKaspiOrders(liveResult.rows)) ordersById.set(String(order.id), order);
  const orders = [...ordersById.values()].sort((a, b) => Number(a.completionDate || a.creationDate) - Number(b.completionDate || b.creationDate));
  const cache = latestSyncResult.rows[0] || {};
  const coverage = coverageResult.rows[0] || {};
  res.json({ ok: true, days: Number(req.query.days || 1), from: req.query.from ? Number(req.query.from) : null,
    to: req.query.to ? Number(req.query.to) : null, fetchedAt: Date.now(), source: 'PostgreSQL synchronized Kaspi orders',
    historyComplete: Number(coverage.coverageFrom || 0) <= bounds.start, coverageFrom: Number(coverage.coverageFrom || 0) || null,
    coverageTo: Number(coverage.coverageTo || 0) || null, lastRefreshAt: Number(cache.lastRefreshAt || 0) || null,
    warnings: cache.lastError ? [String(cache.lastError)] : [], orders, returns: returnsResult.rows });
}));

reportsRouter.get('/wb-finance-summary', asyncRoute(async (req, res) => {
  const selected = market(req.query.market);
  if (!['WB', 'WB2'].includes(selected)) return res.status(400).json({ ok: false, error: 'market must be WB or WB2' });
  const days = Number(req.query.days || 1);
  const { since, until } = periodBounds(days);
  const finance = await pool.query(`SELECT COALESCE(SUM(retail_amount),0) AS "retailAmount",COALESCE(SUM(for_pay),0) AS "forPay",
    COALESCE(SUM(acquiring_fee),0) AS acquiring,COALESCE(SUM(delivery_service),0) AS delivery,
    COALESCE(SUM(paid_storage),0) AS storage,COALESCE(SUM(paid_acceptance),0) AS acceptance,
    COALESCE(SUM(deduction),0) AS deduction,COALESCE(SUM(penalty),0) AS penalty,
    COALESCE(SUM(additional_payment),0) AS "additionalPayment",COALESCE(SUM(rebill_logistic_cost),0) AS rebill
    FROM wb_finance_rows WHERE market=$1 AND rr_date >= $2 AND rr_date < $3`, [selected, since, until]);
  const daysList = [];
  for (let time = since; time < until; time += 86_400_000) daysList.push(dateKey(time));
  const ads = daysList.length ? await pool.query(`SELECT COALESCE(SUM(amount),0) AS advertising,
    COALESCE(SUM(CASE WHEN lower(payment_type) LIKE '%счет%' OR lower(payment_type) LIKE '%account%' THEN amount ELSE 0 END),0) AS "accountAdvertising"
    FROM wb_ad_costs WHERE market=$1 AND day = ANY($2::text[])`, [selected, daysList]) : { rows: [{}] };
  const row = { ...finance.rows[0], ...ads.rows[0] };
  const wbCharges = Number(row.acquiring) + Number(row.delivery) + Number(row.storage) + Number(row.acceptance) + Number(row.deduction) + Number(row.penalty) + Number(row.rebill);
  res.json({ ok: true, market: selected, days, range: { since, until, timezone: 'Asia/Almaty' }, ...row,
    wbCharges, netBeforeCost: Number(row.forPay) - wbCharges + Number(row.additionalPayment) - Number(row.accountAdvertising) });
}));

reportsRouter.get('/wb-finance-products', asyncRoute(async (req, res) => {
  const selected = market(req.query.market);
  if (!['WB', 'WB2'].includes(selected)) return res.status(400).json({ ok: false, error: 'market must be WB or WB2' });
  const days = Number(req.query.days || 1);
  const { since, until } = periodBounds(days);
  const result = await pool.query(`SELECT f.vendor_code AS "vendorCode",f.nm_id AS "nmId",MAX(f.title) AS title,l.product_id AS "productId",
    SUM(CASE WHEN trim(f.doc_type)='Продажа' THEN f.qty WHEN trim(f.doc_type)='Возврат' THEN -f.qty ELSE 0 END) AS qty,
    SUM(f.retail_amount) AS "retailAmount",SUM(f.for_pay) AS "forPay",SUM(f.acquiring_fee) AS acquiring,
    SUM(f.delivery_service) AS delivery,SUM(f.paid_storage) AS storage,SUM(f.paid_acceptance) AS acceptance,
    SUM(f.deduction) AS deduction,SUM(f.penalty) AS penalty,SUM(f.additional_payment) AS "additionalPayment",
    SUM(f.rebill_logistic_cost) AS rebill FROM wb_finance_rows f
    LEFT JOIN product_links l ON l.market=f.market AND (l.sku=f.vendor_code OR l.sku=f.nm_id)
    WHERE f.market=$1 AND f.rr_date >= $2 AND f.rr_date < $3
    GROUP BY f.vendor_code,f.nm_id,l.product_id ORDER BY SUM(f.for_pay) DESC`, [selected, since, until]);
  const products = result.rows.map(row => {
    const wbCharges = Number(row.acquiring || 0) + Number(row.delivery || 0) + Number(row.storage || 0) + Number(row.acceptance || 0) + Number(row.deduction || 0) + Number(row.penalty || 0) + Number(row.rebill || 0);
    return { ...row, wbCharges, netBeforeCost: Number(row.forPay || 0) - wbCharges + Number(row.additionalPayment || 0) };
  });
  res.json({ ok: true, market: selected, days, range: { since, until, timezone: 'Asia/Almaty' }, products, advertising: 0, accountAdvertising: 0 });
}));

reportsRouter.get('/wb-dashboard-buyouts', asyncRoute(async (req, res) => {
  const selected = market(req.query.market);
  const days = Number(req.query.days || 1);
  const cached = await pool.query('SELECT payload,updated_at AS "updatedAt",last_error AS "lastError" FROM wb_buyout_cache WHERE market=$1 AND period_key=$2', [selected, String(days)]);
  if (cached.rowCount && cached.rows[0].payload) {
    try { return res.json({ ...JSON.parse(cached.rows[0].payload), ok: true, cached: true, updatedAt: cached.rows[0].updatedAt, lastError: cached.rows[0].lastError }); } catch {}
  }
  const { since, until } = periodBounds(days);
  const result = await pool.query('SELECT COALESCE(SUM(buyout_count),0)::bigint AS "buyoutCount",COALESCE(SUM(buyout_sum),0) AS "buyoutSum" FROM wb_dashboard_daily WHERE market=$1 AND day >= $2 AND day <= $3', [selected, dateKey(since), dateKey(until - 1)]);
  res.json({ ok: true, available: true, market: selected, days, ...result.rows[0], products: [], currency: 'KZT', source: 'PostgreSQL WB daily cache' });
}));

reportsRouter.get('/wb-sales-live', asyncRoute(async (req, res) => {
  const selected = market(req.query.market);
  const days = Number(req.query.days || 1);
  const { since, until } = periodBounds(days);
  const result = await pool.query(`SELECT r.vendor_code AS "vendorCode",r.nm_id AS "nmId",l.product_id AS "productId",
    SUM(CASE WHEN r.is_return=1 THEN -1 ELSE 1 END) AS qty,
    SUM(CASE WHEN r.is_return=1 THEN -r.finished_price ELSE r.finished_price END) AS "buyoutSum",
    SUM(CASE WHEN r.is_return=1 THEN -r.for_pay ELSE r.for_pay END) AS "forPay"
    FROM wb_sales_live_rows r LEFT JOIN product_links l ON l.market=r.market AND (l.sku=r.vendor_code OR l.sku=r.nm_id)
    WHERE r.market=$1 AND r.sale_date >= $2 AND r.sale_date < $3 GROUP BY r.vendor_code,r.nm_id,l.product_id`, [selected, since, until]);
  const products = result.rows.map(row => ({ ...row, title: row.vendorCode || row.nmId, priceLinked: Number(row.buyoutSum || 0) !== 0 }));
  res.json({ ok: true, available: true, market: selected, days, range: { since, until, timezone: 'Asia/Almaty' },
    buyoutCount: products.reduce((sum, row) => sum + Number(row.qty || 0), 0), buyoutSum: products.reduce((sum, row) => sum + Number(row.buyoutSum || 0), 0),
    forPay: products.reduce((sum, row) => sum + Number(row.forPay || 0), 0), products, currency: 'KZT', source: 'PostgreSQL WB sales cache' });
}));

reportsRouter.get('/wb-realized-status', asyncRoute(async (req, res) => {
  const selected = market(req.query.market);
  const days = Number(req.query.days || 1);
  const { since, until } = periodBounds(days);
  const [rows, state] = await Promise.all([
    pool.query(`SELECT * FROM wb_realized_status_tracker WHERE market=$1 AND ((sold_at >= $2 AND sold_at < $3) OR (returned_at >= $2 AND returned_at < $3))`, [selected, since, until]),
    pool.query('SELECT * FROM wb_realized_tracker_state WHERE market=$1', [selected])
  ]);
  const products = new Map(); let sales = 0, returns = 0, buyoutSum = 0;
  for (const row of rows.rows) {
    const key = row.sku || row.nm_id || row.order_id;
    const item = products.get(key) || { vendorCode: row.sku, nmId: row.nm_id, title: row.sku || row.nm_id, qty: 0, buyoutSum: 0, priceLinked: true };
    if (Number(row.sold_at) >= since && Number(row.sold_at) < until) { item.qty++; item.buyoutSum += Number(row.unit_price); sales++; buyoutSum += Number(row.unit_price); }
    if (Number(row.returned_at) >= since && Number(row.returned_at) < until) { item.qty--; item.buyoutSum -= Number(row.unit_price); returns++; buyoutSum -= Number(row.unit_price); }
    products.set(key, item);
  }
  const status = state.rows[0] || {};
  res.json({ ok: true, available: true, market: selected, days, range: { since, until, timezone: 'Asia/Almaty' }, sales, returns,
    netQty: sales - returns, buyoutCount: sales - returns, buyoutSum, forPay: 0, products: [...products.values()].filter(row => row.qty),
    currency: 'KZT', priceComplete: true, payoutEstimated: true, statusTracked: true, coverageComplete: true,
    initializedAt: Number(status.initialized_at || 0), lastSyncAt: Number(status.last_sync_at || 0), recoveryTag: String(status.recovery_tag || ''), source: 'PostgreSQL WB status tracker' });
}));

