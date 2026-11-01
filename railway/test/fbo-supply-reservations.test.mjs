import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {reserveSupplyOrder,runSupplyReservations} from '../src/fbo-warehouse/supply-reservations.js';
import {availability,inventory,draftGroups,cancelDraft,dispatchDraft} from '../src/fbo-warehouse/core.js';
import {accountAutomaticOrder} from '../src/fbo-warehouse/automatic.js';
import {pool} from '../src/db.js';
const account={id:'ozon',clientId:'cabinet'};
const state=()=>({products:[{id:'p',name:'Форма яблоко',ozon:'111',stock:0,cost:650}],purchases:[{id:'wh',productId:'p',qty:100,status:'at_warehouse',unitCost:650,date:1}],reservations:[],movements:[],settings:{}});
const part=(qty=80,orderId='900',status='READY_TO_SUPPLY')=>({orderId,supplyId:orderId+'1',bundleId:orderId+'2',state:status,orderState:status,cluster:'Казань',clusterId:'10',items:[{sku:'111',qty}]});
const reserve=(s,parts=[part()])=>reserveSupplyOrder({state:s,stockRows:[]},{supplies:parts},account,'900',2000);
test('created Ozon supply reserves warehouse-only goods before shipment without stock/FIFO movements and repeated sync is idempotent',()=>{
 const before=state(),out=reserve(before);assert.equal(out.changed,true);assert.equal(out.status,'reserved');assert.deepEqual(before,state());assert.deepEqual(out.state.products,before.products);assert.deepEqual(out.state.purchases,before.purchases);assert.deepEqual(out.state.movements,[]);
 const r=out.state.reservations[0];assert.equal(r.qty,0);assert.equal(r.warehouseQty,80);assert.equal(r.orderId,'900');assert.equal(r.active,true);assert.equal(availability(out.state,'p').available,20);
 assert.equal(reserve(out.state).changed,false);assert.equal(out.state.reservations.length,1);
});
test('quantity changes replace reservations atomically; shortages retain the existing reserve; explicit cancellation releases stock',()=>{
 const first=reserve(state()).state;
 assert.throws(()=>reserve(first,[part(101)]),/Недостаточно/);assert.equal(availability(first,'p').available,20);
 const resized=reserve(first,[part(60)]).state;assert.equal(availability(resized,'p').available,40);assert.equal(resized.reservations.filter(r=>r.active).length,1);assert.equal(reserve(resized,[part(60)]).changed,false);
 const cancelled=reserve(resized,[part(60,'900','CANCELLED')]);assert.equal(cancelled.status,'cancelled');assert.equal(availability(cancelled.state,'p').available,100);assert.equal(availability(reserve(cancelled.state,[part(60)]).state,'p').available,40);
});
test('manual cancellation is not recreated; missing/unknown order never frees a previous reserve',()=>{
 const s=reserve(state()).state,id=draftGroups(s)[0].id;
 assert.equal(reserve(s,[]).changed,false);assert.equal(reserve(s,[part(80,'900','UNSPECIFIED')]).changed,false);assert.equal(availability(s,'p').available,20);
 cancelDraft(s,id);const out=reserve(s);assert.equal(out.changed,false);assert.match(out.message,/вручную/);assert.equal(availability(s,'p').available,100);
});
test('unlinked/ambiguous SKU, incomplete compositions, stock deficits and cabinet changes never create partial reservations',()=>{
 for(const kind of ['unlinked','ambiguous','partial','short','cabinet']){let s=state(),payload=[part()];if(kind==='unlinked')delete s.products[0].ozon;if(kind==='ambiguous')s.products.push({...s.products[0],id:'other'});if(kind==='partial')payload.push({...part(),supplyId:'other',items:[]});if(kind==='short')payload=[part(101)];if(kind==='cabinet'){s=reserve(s).state;s.reservations[0].supplyClientHash='other';}
 const before=JSON.stringify(s);assert.throws(()=>reserve(s,payload),kind);assert.equal(JSON.stringify(s),before,kind);}
});
test('same compositions in two different orders receive separate reserves and later dispatch consumes the correct order only once',()=>{
 const s=reserve(state(),[part(40)]).state,other=reserveSupplyOrder({state:s},{supplies:[part(40,'901')]},account,'901',2000).state;
 assert.equal(availability(other,'p').available,20);assert.equal(draftGroups(other).filter(x=>x.status==='reserved').length,2);
 assert.throws(()=>dispatchDraft(structuredClone(other),draftGroups(other).find(d=>d.orderId==='900').id,{orderId:'901',lines:[]}),/другой заявкой/);
 const sent=accountAutomaticOrder({state:other},{supplies:[part(40,'900','IN_TRANSIT')]},account.id,'900',3000);
 assert.equal(sent.draft.orderId,'900');assert.equal(draftGroups(sent.state).find(x=>x.orderId==='901').status,'reserved');assert.equal(sent.state.products[0].stock,0);assert.equal(sent.state.movements.find(x=>x.type==='FBO Ozon').qty,-40);
 assert.equal(accountAutomaticOrder({state:sent.state},{supplies:[part(40,'900','IN_TRANSIT')]},account.id,'900',4000).changed,false);
});
test('worker is serialized, reports unlinked SKUs, respects freshness/writes/cabinet and makes no repeated writes for unchanged snapshots',async()=>{
 let current=state(),writes=0,tail=Promise.resolve();const options={now:2000,writesEnabled:true,transact:fn=>{const p=tail.then(()=>fn({}));tail=p.catch(()=>{});return p;},readContext:async()=>({state:structuredClone(current),stockRows:[],ready:true,revision:1}),persist:async(_c,ctx)=>{current=ctx.state;writes++;}};
 const source={payload:{supplies:[part()]},updated_at:1500,client_id:'cabinet'};
 await Promise.all([runSupplyReservations(account,source,options),runSupplyReservations(account,source,options)]);assert.equal(writes,1);assert.equal(current.reservations.filter(r=>r.active).length,1);
 for(const extra of [{last_error:'timeout'},{updated_at:0},{updated_at:200000},{client_id:'different'}])await runSupplyReservations(account,{...source,...extra},options);await runSupplyReservations(account,source,{...options,writesEnabled:false});assert.equal(writes,1);
 current=state();delete current.products[0].ozon;await runSupplyReservations(account,source,options);assert.equal(current.settings.fboSupplyReservations.ozon.results[0].status,'attention');assert.match(current.settings.fboSupplyReservations.ozon.results[0].message,/SKU 111/);assert.equal(current.reservations.length,0);
});
test('product totals and reserve breakdown include warehouse FBO units without subtracting them from sale stock or inventing shortage',()=>{
 const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8'),s=reserve(state()).state;
 const fn=n=>{const a=html.indexOf('function '+n+'(');const end=html.indexOf('\n}',a);return ['buildProductRenderStats','productInventoryRow'].includes(n)?html.slice(a,end+2):html.slice(a,html.indexOf('\n',a));};
 const c={state:s,window:{},Map,Number,Math,String,Set,productSearchHaystack:p=>p.name,isBundleProduct:()=>false,bundleComponents:()=>[],purchaseStatus:p=>p.status,purchaseDisplayUnitCost:p=>p.unitCost,prod:id=>s.products.find(p=>p.id===id),stockProducts:()=>s.products,reserved:()=>0};vm.createContext(c);vm.runInContext(['productMapAdd','buildProductRenderStats','productInventoryRow','reservedStockTotal','reserveStockUnits','reserveOrderKey','reserveSourceLabel','reserveBreakdown'].map(fn).join('\n'),c);
 const stats=c.buildProductRenderStats(),row=c.productInventoryRow(stats,s.products[0]);assert.equal(row.warehouse,100);assert.equal(row.warehouseReserved,80);assert.equal(row.reserved,0);assert.equal(row.available,0);assert.equal(stats.reservedTotal,80);assert.equal(c.reservedStockTotal(),80);const breakdown=c.reserveBreakdown()[0];assert.equal(breakdown.stockUnits,80);assert.equal(breakdown.orders.size,1);assert.equal(c.reserveSourceLabel('FBO'),'Ozon FBO');assert.match(html,/Резерв FBO: \$\{Number\(inventory.warehouseReserved\)/);
});
test.after(()=>pool.end());
