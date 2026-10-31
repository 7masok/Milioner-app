import {captureMovementBalance} from './movement-stock-balance.js';
import crypto from 'node:crypto';
import {kaspiOrderIsActive,kaspiOrderIsCollected} from './kaspi-status.js';
export const contentKey=(orderId,entryId)=>JSON.stringify([String(orderId),String(entryId)]);
const fail=(message,status=409)=>{throw Object.assign(new Error(message),{status})};
export function kaspiContentOverride(state,orderId,entryId){return state?.settings?.kaspiOrderContents?.[contentKey(orderId,entryId)]||null}
export function effectiveKaspiRow(state,row){
 const override=kaspiContentOverride(state,row.order_id,row.entry_id);
 if(!override)return row;
 const revenue=Math.max(0,Number(row.total_price)||Number(row.unit_price)*Number(row.qty)||0);
 return {...row,product_id:override.productId,qty:override.qty,unit_price:revenue/override.qty,contentOverride:override};
}
export function kaspiContentSignature(rows){return crypto.createHash('sha256').update(JSON.stringify(rows.map(r=>[r.order_id,r.entry_id,r.sku,r.product_id,Number(r.qty),r.status,r.state,Number(r.unit_price),Number(r.total_price)]))).digest('hex')}
export function preserveKaspiContents(previous,next){
 next.settings={...(next.settings||{})};
 if(previous?.settings?.kaspiOrderContents)next.settings.kaspiOrderContents=previous.settings.kaspiOrderContents;
 else delete next.settings.kaspiOrderContents;
}
export function correctKaspiContents(state,rows,input,now=Date.now()){
 if(!Array.isArray(input.items)||input.items.length!==rows.length||!rows.length||rows.length>100)fail('Состав заказа изменился. Откройте заказ заново.');
 if(input.signature!==kaspiContentSignature(rows))fail('Данные Kaspi изменились. Откройте заказ заново.');
 const products=new Map((state.products||[]).map(p=>[String(p.id),p]));
 const changes=[],seen=new Set(),orderId=String(rows[0].order_id);
 if(state.settings?.kaspiReturnReceipts?.[orderId])fail('Возврат уже обработан. Изменять отправленный состав нельзя.');
 for(const item of input.items){
  if(!item||typeof item!=='object')fail('Проверьте позиции заказа',400);
  const row=rows.find(r=>String(r.entry_id)===String(item.entryId));if(!row||seen.has(String(item.entryId)))fail('Проверьте позиции заказа',400);seen.add(String(item.entryId));
  const old=kaspiContentOverride(state,orderId,row.entry_id),current=effectiveKaspiRow(state,row),product=products.get(String(item.productId)),qty=Number(item.qty);
  if(!product||!Number.isSafeInteger(qty)||qty<1||qty>1000000)fail('Выберите товар и целое положительное количество',400);
  if(Number(item.version)!==Number(old?.version||0))fail('Состав уже изменён на другом устройстве. Откройте заказ заново.');
  if(String(current.product_id)===String(product.id)&&Number(current.qty)===qty)continue;
  if(product.kind==='bundle')fail('Для замены выберите отдельный товар, а не набор.',400);
  if(!kaspiOrderIsActive(row.status,row.state)&&!kaspiOrderIsCollected(row.status,row.state))fail('Заказ отменён или возвращается. Сначала оформите его возврат.');
  const key=`Kaspi:${orderId}:${row.entry_id}`,sale=(state.sales||[]).find(s=>[key,key.slice(6)].includes(String(s.externalKey)));
  const debits=(state.movements||[]).filter(m=>m.type==='продажа'&&!m.stockRestoredAt&&m.externalKey===key);
  if(sale&&sale.serverReconciled!==true)fail('Для старого ручного списания требуется отдельная корректировка FIFO.');
  if(sale&&!debits.length)fail('Не найдено точное списание этого заказа. Автоматическая замена остатка недоступна.');
  if(!sale&&debits.length)fail('Продажа и движения заказа не совпадают. Требуется проверка.');
  if(!sale&&kaspiOrderIsCollected(row.status,row.state)&&Number(row.creation_date)<Date.UTC(2026,7,24))fail('Для старого заказа не найдено подтверждённое списание.');
  for(const m of debits){
   if(!products.has(String(m.productId)))fail('Исходный товар удалён. Требуется проверка списания.');
   if((state.movements||[]).some(x=>String(x.productId)===String(m.productId)&&x.type==='инвентаризация'&&Number(x.updatedAt||x.date)>=Number(m.date)))fail('После отправки была инвентаризация исходного товара. Требуется отдельная корректировка.');
  }
  if(sale&&(state.movements||[]).some(m=>String(m.productId)===String(product.id)&&m.type==='инвентаризация'&&Number(m.updatedAt||m.date)>=Math.min(...debits.map(d=>Number(d.date)))))fail('После отправки была инвентаризация фактически отправленного товара. Требуется отдельная корректировка.');
  changes.push({row,current,product,qty,old,key,sale,debits});
 }
 if(!changes.length)return {changed:false};
 // Work on copies: any validation failure leaves the caller's state untouched.
 const next=structuredClone(state),pmap=new Map(next.products.map(p=>[String(p.id),p]));
 next.movements||=[];next.sales||=[];next.reservations||=[];next.settings||={};next.settings.kaspiOrderContents||={};
 for(const change of changes){
  const {row,current,product,qty,old,key,sale,debits}=change,label=`Kaspi ${row.code||orderId}`,version=Number(old?.version||0)+1;
  for(const debit of debits){
   const p=pmap.get(String(debit.productId)),count=Math.max(0,-Number(debit.qty)||0);p.stock=Math.max(0,Number(p.stock)||0)+count;
   next.movements.find(m=>m.id===debit.id).stockRestoredAt=now;
   next.movements.unshift(captureMovementBalance({id:crypto.randomUUID(),date:now,type:'возврат',productId:p.id,qty:count,externalKey:key,reversesMovementId:debit.id,extra:label+' · исправление отправленного состава'},p.stock));
  }
  for(const r of next.reservations)if(r.source==='Kaspi'&&[key,key.slice(6)].includes(String(r.externalKey))){r.active=false;r.stage='content-corrected';r.updatedAt=now;r.closedAt=now;}
  next.settings.kaspiOrderContents[contentKey(orderId,row.entry_id)]={productId:product.id,qty,version,updatedAt:now,history:[...(old?.history||[]),{at:now,from:{productId:current.product_id||null,name:products.get(String(current.product_id))?.name||row.product_name,qty:Number(current.qty)},to:{productId:product.id,name:product.name,qty},reason:String(input.reason||'').trim().slice(0,300)}]};
 }
 for(const {row,product,qty,key,sale} of changes){
  const p=pmap.get(String(product.id)),collected=!!sale||kaspiOrderIsCollected(row.status,row.state);
  const reserved=next.reservations.filter(r=>r.active).reduce((sum,r)=>{const rp=pmap.get(String(r.productId));return sum+(String(r.productId)===String(p.id)?Number(r.qty)||0:rp?.kind==='bundle'?(rp.components||[]).filter(c=>String(c.productId)===String(p.id)).reduce((n,c)=>n+(Number(c.qty)||1)*(Number(r.qty)||0),0):0)},0);
  if(Math.max(0,Number(p.stock)||0)-reserved<qty)fail('Недостаточно свободного остатка: '+p.name);
  if(collected){
   p.stock=Number(p.stock)-qty;const cost=Math.max(0,Number(p.cost)||0),revenue=Math.max(0,Number(row.total_price)||Number(row.unit_price)*Number(row.qty)||0),fees=Math.max(0,Number(row.seller_delivery_cost)||0)+Math.max(0,Number(row.marketplace_fee)||0);
   next.movements.unshift(captureMovementBalance({id:crypto.randomUUID(),date:now,type:'продажа',productId:p.id,qty:-qty,externalKey:key,extra:`Kaspi ${row.code||orderId} · фактически отправленный состав`},p.stock));
   const updated={...(sale||{}),id:sale?.id||crypto.randomUUID(),productId:p.id,qty,price:revenue/qty,cost,fee:fees/qty,channel:'Kaspi',date:Number(row.creation_date)||now,externalKey:key,serverReconciled:true,stockShortage:0,contentCorrectedAt:now};
   next.sales=next.sales.filter(s=>![key,key.slice(6)].includes(String(s.externalKey)));next.sales.push(updated);
  }else next.reservations.push({id:crypto.randomUUID(),productId:p.id,qty,active:true,source:'Kaspi',externalKey:key,stage:'new',date:Number(row.creation_date)||now,updatedAt:now});
 }
 Object.assign(state,next);return {changed:true,count:changes.length};
}
