import express from 'express';
import { pool, transaction } from './db.js';
import { asyncRoute, requireTrustedOrigin, requireWritesEnabled } from './http.js';

const fees = ['commission','cardCommission','paymentGuarantee','kaspiPay','kaspiTravel','bonusProduct','bonusReview','delivery'];
const fields = ['date','time','operation','orderId','detail','amount',...fees];

function rowsOf(batches) {
  const rows = new Map();
  for (const batch of batches || []) for (const row of Array.isArray(batch?.lines) ? batch.lines : []) {
    if (!row || typeof row !== 'object') continue;
    const clean = Object.fromEntries(fields.map(field => [field, row[field] ?? '']));
    for (const field of ['date','time','operation','orderId','detail']) clean[field] = String(clean[field]).trim().slice(0,500);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(clean.date) || !clean.orderId || !/^(покупка|возврат)$/i.test(clean.operation)
      || !Number.isFinite(clean.amount) || !Number.isFinite(clean.commission) || !Number.isFinite(clean.kaspiPay)
      || !Number.isFinite(clean.delivery) || fees.some(field => clean[field] !== '' && !Number.isFinite(clean[field]))) continue;
    for (const field of fees) if (clean[field] === '') clean[field] = 0;
    clean.operation = clean.operation.toLowerCase();
    rows.set(JSON.stringify(clean), clean);
  }
  return [...rows.values()];
}

export function matchKaspiSettlements(orders, rows) {
  const byNumber = new Map();
  for (const row of rows) {
    const number = String(row.orderId).trim();
    const matched = byNumber.get(number) || [];
    matched.push(row);
    byNumber.set(number, matched);
  }
  const results = {};
  for (const order of orders) {
    if (Number(order.entry_count) !== 1 || !(Number(order.qty) > 0)) continue;
    const matches = [...new Set([order.order_id, order.code].flatMap(id => byNumber.get(String(id)) || []))];
    const purchases = matches.filter(row => /^покупка$/i.test(row.operation));
    if (purchases.length !== 1 || Math.abs(purchases[0].amount - Number(order.total_price)) >= 0.01) continue;
    const returns = matches.filter(row => /^возврат$/i.test(row.operation));
    if (returns.length && (returns.length !== 1 || Math.abs(returns[0].amount + purchases[0].amount) >= 0.01)) continue;
    if (!returns.length && String(order.status).toUpperCase() !== 'COMPLETED') continue;
    const proceeds = matches.reduce((sum,row) => sum + row.amount + fees.reduce((total,field)=>total+Number(row[field]||0),0),0);
    results[order.id] = { sold: returns.length ? 0 : Number(order.qty), proceeds };
  }
  return results;
}

export const kaspiPurchaseSettlements = express.Router();
kaspiPurchaseSettlements.post('/purchases/kaspi-pay',requireTrustedOrigin,requireWritesEnabled,asyncRoute(async(req,res)=>{
  const lines = req.body?.lines;
  if (!Array.isArray(lines) || !lines.length || lines.length > 15000) return res.status(400).json({ok:false,error:'В отчёте должно быть от 1 до 15 000 операций Kaspi Pay.'});
  const clean = rowsOf([{lines}]);
  if (!clean.length) return res.status(400).json({ok:false,error:'В отчёте нет строк с номером заказа и комиссиями.'});
  await transaction(async client => {
    await client.query(`INSERT INTO kaspi_purchase_settlements(operation_key,payload)
      SELECT md5(value::text),value FROM jsonb_array_elements($1::jsonb) ON CONFLICT DO NOTHING`,[JSON.stringify(clean)]);
  });
  res.json({ok:true,count:clean.length});
}));

kaspiPurchaseSettlements.get('/purchases/kaspi-pay',asyncRoute(async(_req,res)=>{
  const orders = await pool.query(`SELECT s.id,s.qty,o.order_id,o.code,o.total_price,o.status,
    (SELECT COUNT(*) FROM marketplace_order_lines p WHERE p.market=o.market AND p.order_id=o.order_id AND p.entry_id<>'__pending__') AS entry_count
    FROM warehouse_sales s JOIN marketplace_order_lines o ON o.market='Kaspi' AND s.external_key=o.market||':'||o.order_id||':'||o.entry_id
    WHERE s.channel='Kaspi' AND s.payload->>'purchaseRealizationTracked'='true'`);
  if (!orders.rows.length) return res.json({ok:true,results:{}});
  const keys = [...new Set(orders.rows.flatMap(row=>[row.order_id,row.code]).filter(Boolean))];
  const [saved, archive] = await Promise.all([
    pool.query(`SELECT payload FROM kaspi_purchase_settlements WHERE payload->>'orderId'=ANY($1::text[])`,[keys]),
    pool.query(`SELECT payload::jsonb->'kaspiPayImports' AS batches FROM (
      SELECT payload FROM warehouse_state WHERE id=1 AND payload LIKE '%"kaspiPayImports"%'
      UNION ALL (SELECT payload FROM warehouse_backups WHERE payload LIKE '%"kaspiPayImports"%'
        AND jsonb_typeof(payload::jsonb->'kaspiPayImports')='array'
        AND payload::jsonb->'kaspiPayImports'<>'[]'::jsonb ORDER BY created_at DESC LIMIT 1)
    ) sources`)
  ]);
  const batches = archive.rows.flatMap(row=>Array.isArray(row.batches)?row.batches:[]);
  const rows = rowsOf([...batches,{lines:saved.rows.map(row=>row.payload)}]);
  res.json({ok:true,results:matchKaspiSettlements(orders.rows,rows)});
}));
