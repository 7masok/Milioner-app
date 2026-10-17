import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {stockLedgerViolation} from '../src/warehouse-ledger.js';
const source=readFileSync(new URL('../../ozon-supplies-v1.js',import.meta.url),'utf8'),html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
const line=name=>html.split('\n').find(s=>s.startsWith('function '+name+'('));
const block=name=>{const start=html.indexOf('function '+name+'(');return html.slice(start,html.indexOf('\nfunction ',start+10))};
function fixture({qty=4,stock=0,warehouse=20,writeoff=0,reserve=0,sourceChoice='auto',rows=1}={}){
 const p={id:'p',name:'Форма малина 6',ozon:'sku',stock,cost:120},lot={id:'wh',productId:'p',status:'at_warehouse',qty:warehouse,warehouseWrittenOffQty:writeoff,buyTotal:warehouse*100,delivery:warehouse*20,warehouseReceivedAt:1,remainingQty:0,landedUnitCost:120};
 const state={products:[p],purchases:warehouse?[lot]:[],movements:[],reservations:reserve?[{productId:'p',qty:reserve,active:true}]:[],settings:{}};
 const supplies=Array.from({length:rows},(_,i)=>({supply_id:'s'+i,bundle_id:'b'+i,items:[{sku:'sku',quantity:qty}]})),order={order_id:'order',supplies,state:'IN_TRANSIT'},alerts=[],confirmations=[];let saves=0,next=1,ready=true,confirmed=true,sheet='';
 const fields={ozonFboBulkSource:{value:sourceChoice}};
 const ctx={state,window:{},Date,console,Map,Set,document:{readyState:'loading',getElementById:key=>fields[key]||null,addEventListener(){}},MutationObserver:class{},setInterval(){},esc:String,showSheet:x=>{sheet=x},MILLIONER_API:'',apiJson:async()=>({accounts:[]}),requireWarehouseEditReady:()=>ready,prod:id=>state.products.find(p=>p.id===id),id:()=> 'new'+next++,reserved:()=>reserve,fmt:String,alert:x=>alerts.push(x),confirm:x=>{confirmations.push(x);return confirmed},save:()=>{saves++},render(){},refreshProductAverageCost(){},fifoLots:pid=>state.purchases.filter(x=>x.productId===pid&&x.status==='received'&&x.remainingQty>0).sort((a,b)=>(a.receivedAt||0)-(b.receivedAt||0)),log(type,productId,qty,extra){const m={id:'m'+next++,type,productId,qty,extra};state.movements.push(m);return m}};
 vm.createContext(ctx);vm.runInContext(['purchaseStatus','purchaseWarehouseQty','purchaseAtWarehouseQty','releaseWarehousePurchaseUnits','fifoConsume'].map(line).join('\n')+'\n'+block('purchaseDisplayUnitCost'),ctx);
 ctx.testOrder=order;vm.runInContext(source.replace(/\}\)\(\);\s*$/,"current={account:'a',order:testOrder};window.fixture={renderOrder,stockPlan};})();"),ctx);
 const key='a|order|s0|b0|sku';fields['ozonFboSource-'+encodeURIComponent(key)]={value:sourceChoice};
 return{ctx,state,p,lot,order,fields,key,alerts,confirmations,get saves(){return saves},get sheet(){return sheet},set ready(x){ready=x},set confirmed(x){confirmed=x},send:()=>ctx.window.accountOzonFboLine(encodeURIComponent(key)),bulk:()=>ctx.window.accountWholeOzonFboOrder()};
}
test('four units ship straight from warehouse: 20 becomes 16, sale stock stays zero, paid cost and audit balance preserved',()=>{
 const f=fixture(),before=structuredClone(f.state);f.send();
 assert.deepEqual(f.alerts,[]);assert.equal(f.saves,1);assert.equal(f.p.stock,0);assert.equal(f.ctx.purchaseAtWarehouseQty('p'),16);
 assert.equal(f.state.purchases.reduce((n,p)=>n+p.buyTotal+p.delivery,0),2400);
 assert.equal(f.state.purchases.filter(x=>x.status==='received').reduce((n,p)=>n+p.remainingQty,0),0);
 const record=f.state.settings.ozonFboTransfers[f.key];assert.equal(record.qty,4);assert.equal(record.unitCost,120);assert.equal(record.stockSource,'at_warehouse');assert.match(f.confirmations[0],/Со склада: 4/);
 assert.equal(stockLedgerViolation(before,f.state),null);
 const after=JSON.stringify(f.state);f.send();assert.equal(JSON.stringify(f.state),after);assert.equal(f.saves,1);
});
test('warehouse removals preserve prior writeoffs and never resurrect them on a later release',()=>{
 const f=fixture({qty:4,warehouse:6,writeoff:2}),before=structuredClone(f.state);f.send();
 assert.equal(f.ctx.purchaseAtWarehouseQty('p'),0);assert.equal(f.lot.qty,2);assert.equal(f.lot.warehouseWrittenOffQty,2);assert.equal(f.p.stock,0);assert.equal(f.state.purchases.reduce((n,p)=>n+p.buyTotal+p.delivery,0),720);assert.equal(stockLedgerViolation(before,f.state),null);
});
test('warehouse shipping consumes exact oldest lot cost, leaving other sale FIFO untouched',()=>{
 const f=fixture({qty:4,warehouse:2,stock:5});f.state.purchases.push({id:'later',productId:'p',status:'at_warehouse',qty:3,remainingQty:0,warehouseReceivedAt:2,landedUnitCost:200,buyTotal:600,delivery:0},{id:'sale',productId:'p',status:'received',qty:5,remainingQty:5,landedUnitCost:50,receivedAt:0,buyTotal:250,delivery:0});
 const before=structuredClone(f.state);f.send();assert.equal(f.ctx.purchaseAtWarehouseQty('p'),1);assert.equal(f.p.stock,5);assert.equal(f.state.purchases.find(x=>x.id==='sale').remainingQty,5);assert.equal(f.state.settings.ozonFboTransfers[f.key].unitCost,160);assert.equal(stockLedgerViolation(before,f.state),null);
});
test('sale-only and mixed sources honor reservations and record both costs without taking reserved units',()=>{
 const f=fixture({qty:4,warehouse:2,stock:5,reserve:2});f.state.purchases.push({id:'sale',productId:'p',status:'received',qty:5,remainingQty:5,landedUnitCost:50,buyTotal:250,delivery:0});const before=structuredClone(f.state);f.send();
 assert.equal(f.p.stock,3);assert.equal(f.state.purchases.find(x=>x.id==='sale').remainingQty,3);assert.equal(f.state.settings.ozonFboTransfers[f.key].unitCost,85);assert.equal(f.state.settings.ozonFboTransfers[f.key].stockSource,'mixed');assert.equal(stockLedgerViolation(before,f.state),null);
 const sale=fixture({qty:4,warehouse:20,stock:6,reserve:2,sourceChoice:'sale'}),prior=structuredClone(sale.state);sale.send();assert.equal(sale.p.stock,2);assert.equal(sale.ctx.purchaseAtWarehouseQty('p'),20);assert.equal(sale.state.settings.ozonFboTransfers[sale.key].stockSource,'sale');assert.equal(stockLedgerViolation(prior,sale.state),null);
});
test('bulk groups repeated products before checking pools, and an insufficient later product changes nothing',()=>{
 const f=fixture({qty:4,warehouse:20,rows:2}),before=structuredClone(f.state);f.bulk();assert.equal(f.ctx.purchaseAtWarehouseQty('p'),12);assert.equal(Object.keys(f.state.settings.ozonFboTransfers).length,2);assert.equal(f.saves,1);assert.equal(stockLedgerViolation(before,f.state),null);
 const bad=fixture({qty:4,warehouse:6,rows:2}),unchanged=JSON.stringify(bad.state);bad.bulk();assert.equal(JSON.stringify(bad.state),unchanged);assert.equal(bad.saves,0);assert.equal(bad.alerts.length,1);
 const later=fixture();later.state.products.push({id:'q',name:'Нет остатков',ozon:'other',stock:0});later.order.supplies[0].items.push({sku:'other',quantity:1});const old=JSON.stringify(later.state);later.bulk();assert.equal(JSON.stringify(later.state),old);assert.equal(later.saves,0);
});
test('read-only cache, rejected confirmation, explicit empty pool and invalid quantities cannot alter stock',()=>{
 for(const mutate of [f=>{f.ready=false},f=>{f.confirmed=false},f=>{f.fields['ozonFboSource-'+encodeURIComponent(f.key)].value='sale'},f=>{f.order.supplies[0].items[0].quantity=1.5},f=>{f.order.supplies[0].items[0].quantity=0}]){
  const f=fixture();mutate(f);const before=JSON.stringify(f.state);f.send();assert.equal(JSON.stringify(f.state),before);assert.equal(f.saves,0);
 }
 const f=fixture({qty:4,warehouse:0,stock:4,reserve:1}),before=JSON.stringify(f.state);f.send();assert.equal(JSON.stringify(f.state),before);assert.match(f.alerts[0],/без резерва: 3/);
});
test('source controls expose actual warehouse and free sale quantities for individual and bulk accounting',()=>{
 const f=fixture({warehouse:20,stock:5,reserve:2});f.ctx.window.fixture.renderOrder();assert.match(f.sheet,/На складе · 20 шт./);assert.match(f.sheet,/В продаже · 3 шт./);assert.match(f.sheet,/id="ozonFboBulkSource"/);assert.match(f.sheet,/По наличию · сначала со склада/);
});
