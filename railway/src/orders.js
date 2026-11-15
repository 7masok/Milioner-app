import {kaspiContentOverride} from './kaspi-order-content.js';
import {readKaspiHistory} from './kaspi-order-history.js';
import express from 'express';
import {readWbOrderHistory,mergeReportingOrders} from './wb-order-history.js';
import { pool } from './db.js';
import { asyncRoute } from './http.js';
import { hydrateWarehouseProducts } from './warehouse-products.js';
import { config } from './config.js';
import { readWb3Orders } from './wb3-orders.js';

export const ordersRouter = express.Router();

function market(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (normalized === 'WB1') return 'WB';
  if (normalized === 'KASPI') return 'Kaspi';
  return normalized;
}

const WB_TRANSIT_STATES=['SORTED','ACCEPTED_BY_CARRIER','SENT_TO_CARRIER','READY_FOR_PICKUP'];

function wbTransitRid(raw){
  let item=raw;
  try{if(typeof raw==='string')item=JSON.parse(raw)}catch{return ''}
  return String(item?.order?.rid||item?.order?.srid||item?.rid||item?.srid||'').trim();
}

export async function confirmClosedWbTransit(rows,db=pool){
  const groups=new Map();
  for(const row of rows){
    if(!['WB','WB2'].includes(row.market)||!WB_TRANSIT_STATES.includes(String(row.state||'').toUpperCase()))continue;
    const rid=wbTransitRid(row.transitRaw);
    if(!rid)continue;
    if(!groups.has(row.market))groups.set(row.market,new Map());
    const byRid=groups.get(row.market);
    if(!byRid.has(rid))byRid.set(rid,[]);
    byRid.get(rid).push(row);
  }
  await Promise.all([...groups].map(async ([market,byRid])=>{
    const {rows:sales}=await db.query(`SELECT srid,MAX(sale_date) AS "saleDate" FROM wb_sales_live_rows
      WHERE market=$1 AND srid=ANY($2::text[]) GROUP BY srid`,[market,[...byRid.keys()]]);
    for(const sale of sales)for(const order of byRid.get(sale.srid)||[]){
      if(Number(sale.saleDate)>=Number(order.creationDate)&&Number(sale.saleDate)>0)order.buyerTransitClosed=true;
    }
  }));
  for(const row of rows)delete row.transitRaw;
  return rows;
}

ordersRouter.get('/orders', asyncRoute(async (req, res) => {
  const selected = market(req.query.market);
  const limit = Math.max(1, Math.min(15000, Number(req.query.limit || 1000) || 1000));
  const after = Math.max(0, Number(req.query.after || 0) || 0);
  if(config.storeProfile==='WB3')return res.json(await readWb3Orders({after,before:Math.max(0,Number(req.query.before||0)||0),limit,cursor:String(req.query.cursor||'')}));
  const params = [], clauses = [];
  if (selected) clauses.push('o.market=' + '$' + params.push(selected));
  if (after) clauses.push('o.creation_date >= ' + '$' + params.push(after));
  const before = Math.max(0, Number(req.query.before || 0) || 0);
  if (before) clauses.push('o.creation_date < ' + '$' + params.push(before));
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(limit);
  const rows = await pool.query(`SELECT o.market,o.order_id AS "orderId",o.code,o.entry_id AS "entryId",o.status,o.state,
      o.creation_date AS "creationDate",o.sku,o.product_name AS "productName",o.qty,o.unit_price AS "unitPrice",
      o.total_price AS "totalPrice",o.seller_delivery_cost AS "sellerDeliveryCost",o.marketplace_fee AS "marketplaceFee",
      o.fee_source AS "feeSource",o.updated_at AS "updatedAt",resolved.product_id AS "productId",resolved.link_source AS "linkSource"${before?'':`,CASE WHEN o.market IN ('WB','WB2') AND upper(o.state) IN ('SORTED','ACCEPTED_BY_CARRIER','SENT_TO_CARRIER','READY_FOR_PICKUP') THEN o.raw_json END AS "transitRaw"`}
      FROM marketplace_order_lines o
      LEFT JOIN LATERAL (
        SELECT pl.product_id,'sku-exact' AS link_source
        FROM product_links pl
        WHERE pl.market=o.market AND pl.sku=o.sku
        LIMIT 1
      ) resolved ON TRUE
      ${where} ORDER BY o.creation_date DESC LIMIT $${params.length}`, params);
  const warehouse = await pool.query('SELECT payload FROM warehouse_state WHERE id=1');
  let stateProducts = [];
  try { stateProducts = (await hydrateWarehouseProducts(pool, JSON.parse(String(warehouse.rows[0]?.payload || '{}')))).products || []; } catch {}
  const visibleLinks = new Map();
  for (const product of stateProducts) {
    for (const [linkMarket, field] of [['Kaspi','kaspi'],['WB','wb'],['WB2','wb2'],['Ozon','ozon']]) {
      const values = [product?.[field], ...(Array.isArray(product?.[`${field}Aliases`]) ? product[`${field}Aliases`] : [])];
      for (const value of values) if (String(value || '').trim()) visibleLinks.set(`${linkMarket}\u0000${String(value).trim()}`, String(product.id));
    }
  }
  const history=before&&after&&req.query.history==='1'?await readWbOrderHistory(pool,after,before,selected,limit):null;
  const kaspiHistory=history?await readKaspiHistory(pool,after,before,selected,limit):null;
  const reportingRows=history?mergeReportingOrders(rows.rows,[...history.rows,...kaspiHistory.rows],limit):rows.rows;
  if(!before)await confirmClosedWbTransit(reportingRows);
  const out = reportingRows.map(row => {
    if (row.productId && visibleLinks.get(`${row.market}\u0000${String(row.sku || '').trim()}`) === String(row.productId)) return row;
    return row.productId ? { ...row, productId: null, linkSource: null } : row;
  });

  let contentState={};try{const raw=warehouse.rows[0]?.payload;contentState=typeof raw==='string'?JSON.parse(raw):raw||{}}catch{}
  for(let i=0;i<out.length;i++){
    const row=out[i];if(row.market!=='Kaspi')continue;
    const override=kaspiContentOverride(contentState,row.orderId,row.entryId);if(!override)continue;
    const product=stateProducts.find(p=>String(p.id)===String(override.productId));
    const revenue=Math.max(0,Number(row.totalPrice)||Number(row.unitPrice)*Number(row.qty)||0);
    out[i]={...row,orderedProductName:row.productName,orderedQty:row.qty,orderedProductId:row.productId,productId:override.productId,productName:product?.name||'Товар удалён',qty:override.qty,unitPrice:revenue/override.qty,contentCorrectedAt:override.updatedAt,linkSource:'order-content'};
  }

  const historyCoverage = before ? (await pool.query("SELECT market,MIN(creation_date) AS \"from\" FROM marketplace_order_lines WHERE market=ANY($1::text[]) AND creation_date>0 GROUP BY market", [['Kaspi','WB','WB2']])).rows : undefined;
  if(history&&historyCoverage){
    for(const state of [...history.states,kaspiHistory.state]){
      const live=historyCoverage.find(r=>r.market===state.market),from=Number(state.from)||0;
      const merged={...state,from:state.market==='Kaspi'?from:from?Math.min(Number(live?.from)||from,from):Number(live?.from)||0};
      if(live)Object.assign(live,merged);else historyCoverage.push(merged);
    }
    // Absent worker state is unknown, never a silent zero for a missing account.
    for(const m of ['WB','WB2'])if(!historyCoverage.some(r=>r.market===m))historyCoverage.push({market:m,from:0,status:'pending'});
  }
  res.json({ ok: true, orders: out, ...(historyCoverage ? {historyCoverage} : {}) });
}));
