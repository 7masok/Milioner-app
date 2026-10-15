import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeHistory,mergeHistory,combineOrders,orderPage,wbTime} from '../src/wb3-order-model.js';
const raw={srid:'unit-1',nmId:123,chrtId:456,createdAt:'2026-10-14T12:00:00+03:00',updatedAt:'2026-10-15T12:00:00+03:00',isMp:false,status:'buyout',sellerPrice:1500};
test('FBO and FBS use warehouse model, never warehouse name',()=>{
 assert.equal(normalizeHistory({...raw,warehouseName:'Склад продавца'},'feed','KZT').fulfillment,'FBO');
 assert.equal(normalizeHistory({...raw,isMp:true},'feed','KZT').fulfillment,'FBS');
 assert.equal(normalizeHistory({...raw,isMp:undefined,date:raw.createdAt,warehouseType:'Склад WB'},'statistics').fulfillment,'FBO');
});
test('WB dates use Moscow when an offset is absent; invalid IDs cannot enter history',()=>{
 assert.equal(wbTime('2026-10-14T12:00:00'),Date.parse('2026-10-14T09:00:00Z'));
 assert.throws(()=>normalizeHistory({...raw,srid:''},'feed','KZT'));
 assert.throws(()=>normalizeHistory({...raw,createdAt:'bad'},'feed','KZT'));
});
test('Statistics does not erase buyout status, amount or currency from the feed',()=>{
 const feed=normalizeHistory(raw,'feed','KZT');
 const stats=normalizeHistory({...raw,date:raw.createdAt,lastChangeDate:raw.updatedAt,isCancel:false},'statistics');
 const merged=mergeHistory(feed,stats);
 assert.equal(merged.orderStatus,'buyout');assert.equal(merged.currency,'KZT');assert.equal(merged.unitPrice,1500);
 assert.equal(stats.priceKnown,false);
});
test('a more recent statistics cancellation supersedes feed status',()=>{
 const feed=normalizeHistory(raw,'feed','KZT');
 const stats=normalizeHistory({srid:raw.srid,nmId:123,date:raw.createdAt,lastChangeDate:'2026-10-16T12:00:00+03:00',isCancel:true},'statistics');
 assert.equal(mergeHistory(feed,stats).orderStatus,'cancel');
});
function native(rid='unit-1',orderId='17'){return {orderId,entryId:orderId,market:'WB',creationDate:Date.parse(raw.createdAt),updatedAt:Date.now(),sku:'bracelet',productName:'Bracelet',qty:1,totalPrice:1490,rawJson:JSON.stringify({order:{rid,orderUid:'shared-cart',nmId:123,convertedCurrencyCode:398,skus:['barcode']}})};}
test('exact RID merges Statistics/Analytics and operational FBS once',()=>{
 const history=normalizeHistory({...raw,isMp:true},'feed','KZT');
 const out=combineOrders([native()], [history]);
 assert.equal(out.length,1);assert.equal(out[0].orderId,'17');assert.equal(out[0].orderStatus,'buyout');assert.equal(out[0].totalPrice,1490);assert.equal(out[0].fulfillment,'FBS');assert.equal(out[0].currency,'KZT');assert.equal(out[0].rawJson,undefined);
});
test('shared cart, article, date and amount do not collapse distinct units',()=>{
 const rows=combineOrders([native('first','1'),native('second','2')],[normalizeHistory({...raw,srid:'shared-cart'},'feed','KZT')]);
 assert.equal(rows.length,3);
});
test('an FBO history row remains display data and resolves a unique size',()=>{
 const row=normalizeHistory(raw,'feed','KZT');
 const products=[{id:'size1',name:'Браслет',wbVariant:{nmId:'123',chrtId:456}},{id:'size2',name:'Другой',wbVariant:{nmId:'123',chrtId:789}}];
 const before=JSON.stringify(products),out=combineOrders([], [row],products);
 assert.equal(out[0].productId,'size1');assert.equal(out[0].productName,'Браслет');assert.equal(out[0].orderId,'srid:unit-1');assert.equal(JSON.stringify(products),before);
 assert.equal(combineOrders([],[{...row,chrtId:0}],products)[0].productId,undefined);
});
test('all available history can be read beyond the old 15,000-row cap',()=>{
 const rows=Array.from({length:15002},(_,i)=>({orderId:String(i),entryId:String(i),creationDate:123}));
 let cursor='',all=[];
 do{const page=orderPage(rows,cursor,1000);all.push(...page.orders);cursor=page.nextCursor;}while(cursor);
 assert.equal(all.length,15002);assert.equal(new Set(all.map(x=>x.orderId)).size,15002);
});
