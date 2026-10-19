import express from 'express';
import crypto from 'node:crypto';
import {pool,transaction} from './db.js';
import {asyncRoute,requireTrustedOrigin,requireWritesEnabled} from './http.js';
import {parseWarehousePayload,hydrateWarehouseMovements,persistWarehouseMovements,legacyCompatibleWarehousePayload} from './warehouse-movements.js';
import {hydrateWarehouseSales,replaceWarehouseSales} from './warehouse-sales.js';
import {hydrateWarehouseReservations,replaceWarehouseReservations} from './warehouse-reservations.js';
import {hydrateWarehouseProducts,persistWarehouseProducts} from './warehouse-products.js';
import {warehousePayloadForStorage} from './warehouse-document.js';
import {pruneWarehouseBackups} from './warehouse-backups.js';
import {correctKaspiContents,effectiveKaspiRow,kaspiContentSignature} from './kaspi-order-content.js';
export const kaspiOrderContentRouter=express.Router();
const error=(message,status=409)=>Object.assign(new Error(message),{status});
export async function kaspiContentRows(client,orderId,lock=false){return (await client.query(`SELECT o.*,l.product_id FROM marketplace_order_lines o LEFT JOIN product_links l ON l.market=o.market AND l.sku=o.sku WHERE o.market='Kaspi' AND o.order_id=$1 ORDER BY o.entry_id${lock?' FOR SHARE OF o':''}`,[orderId])).rows}
kaspiOrderContentRouter.get('/kaspi/order-content/:orderId',asyncRoute(async(req,res)=>{
 const stored=await pool.query('SELECT payload,revision FROM warehouse_state WHERE id=1');if(!stored.rows.length)throw error('Склад не загружен');
 const state=await hydrateWarehouseProducts(pool,parseWarehousePayload(stored.rows[0].payload)),rows=await kaspiContentRows(pool,req.params.orderId);if(!rows.length)throw error('Заказ Kaspi не найден',404);
 if(rows.some(r=>r.entry_id==='__pending__'||!(Number(r.qty)>0)))throw error('Состав заказа Kaspi ещё загружается. Повторите после синхронизации.');
 const products=new Map(state.products.map(p=>[String(p.id),p]));
 res.json({ok:true,orderId:req.params.orderId,code:rows[0].code,revision:Number(stored.rows[0].revision),signature:kaspiContentSignature(rows),items:rows.map(row=>{const current=effectiveKaspiRow(state,row);return {entryId:row.entry_id,productId:current.product_id||'',qty:Number(current.qty),orderedName:row.product_name,orderedQty:Number(row.qty),sku:row.sku,version:current.contentOverride?.version||0,history:(current.contentOverride?.history||[]).map(h=>({...h,from:{...h.from,name:h.from.name||products.get(String(h.from.productId))?.name||row.product_name},to:{...h.to,name:h.to.name||products.get(String(h.to.productId))?.name||'Товар'}}))}})});
}));
kaspiOrderContentRouter.post('/kaspi/order-content/:orderId',requireTrustedOrigin,requireWritesEnabled,asyncRoute(async(req,res)=>{
 const result=await transaction(async client=>{
  await client.query('SELECT pg_advisory_xact_lock($1)',[730021]);
  const stored=await client.query('SELECT payload,revision FROM warehouse_state WHERE id=1 FOR UPDATE');if(!stored.rows.length)throw error('Склад не загружен');
  if(Number(req.body?.revision)!==Number(stored.rows[0].revision))throw error('Склад обновился. Откройте заказ заново.');
  const rows=await kaspiContentRows(client,req.params.orderId,true);if(!rows.length)throw error('Заказ Kaspi не найден',404);
 if(rows.some(r=>r.entry_id==='__pending__'||!(Number(r.qty)>0)))throw error('Состав заказа Kaspi ещё загружается. Повторите после синхронизации.');
  const state=await hydrateWarehouseProducts(client,await hydrateWarehouseReservations(client,await hydrateWarehouseSales(client,await hydrateWarehouseMovements(client,parseWarehousePayload(stored.rows[0].payload)))));
  const now=Date.now(),change=correctKaspiContents(state,rows,req.body||{},now);if(!change.changed)return {...change,revision:Number(stored.rows[0].revision)};
  const backup=await legacyCompatibleWarehousePayload(client,stored.rows[0].payload);
  await client.query('INSERT INTO warehouse_backups(label,payload,revision,created_at) VALUES($1,$2,$3,$4) RETURNING id',['before-kaspi-order-content',backup,stored.rows[0].revision,now]);await pruneWarehouseBackups(client);
  await persistWarehouseMovements(client,state.movements,now);await replaceWarehouseSales(client,state.sales,now);await replaceWarehouseReservations(client,state.reservations,now);await persistWarehouseProducts(client,state.products,now);
  const raw=JSON.stringify(warehousePayloadForStorage(state)),revision=Number(stored.rows[0].revision)+1;
  await client.query('UPDATE warehouse_state SET payload=$1,revision=$2,updated_at=$3 WHERE id=1',[raw,revision,now]);
  await client.query('INSERT INTO warehouse_audit(revision,updated_at,payload_sha256,source) VALUES($1,$2,$3,$4)',[revision,now,crypto.createHash('sha256').update(raw).digest('hex').toUpperCase(),'kaspi-order-content']);
  return {...change,revision};
 });res.json({ok:true,...result});
}));
