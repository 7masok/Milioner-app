import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { stockLedgerViolation } from '../src/warehouse-ledger.js';
import { normalizedPurchase } from '../src/warehouse-purchases.js';

const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
const line=name=>html.split('\n').find(s=>s.startsWith('function '+name+'('));
const block=name=>{const a=html.indexOf('function '+name+'(');return html.slice(a,html.indexOf('\nfunction ',a+10));};
function fixture(){
 const state={products:[{id:'sweet',stock:0,cost:70}],purchases:[{id:'lot',productId:'sweet',status:'at_warehouse',qty:5,remainingQty:0,buyTotal:500,delivery:50,landedUnitCost:110,warehouseReceivedAt:1}],movements:[],reservations:[{productId:'sweet',qty:2,active:true}]};
 const fields={wp:{value:'sweet'},wq:{value:'1'},wr:{value:'Брак'},writeoffSource:{value:'at_warehouse'},productWarehouseReleaseQty:{value:'2'}};
 let next=1,saves=0;const alerts=[],ctx={state,window:{},document:{getElementById:id=>fields[id]||null,querySelectorAll:()=>[{value:'lot'}]},
  requireWarehouseEditReady:()=>true,prod:id=>state.products.find(p=>p.id===id),stockProducts:()=>state.products,isBundleProduct:()=>false,
  reserved:()=>2,fmt:n=>n+' ₸',esc:s=>String(s),id:()=> 'new-'+next++,alert:s=>alerts.push(s),confirm:()=>true,
  save(){saves++;},closeModal(){},render(){},refreshProductAverageCost(){},
  fifoConsume(){throw Error('Warehouse writeoff must not consume received FIFO');},
  log(type,productId,qty,extra){const m={id:'move-'+next++,type,productId,qty,extra};state.movements.unshift(m);return m;},
  purchaseShipmentRows:()=>state.purchases.filter(x=>x.id==='lot'),productNameById:()=> 'Сладкий набор розовый',
 };
 vm.createContext(ctx);vm.runInContext(['purchaseStatus','purchaseWarehouseQty','purchaseAtWarehouseQty','writeoffSourceOptions','syncWriteoffSource','writeoffForm','createWarehouseWriteoff','createWriteoff','releaseWarehousePurchaseUnits','releaseProductWarehouseQty','releaseSelectedPurchaseRows'].map(line).join('\n')+'\n'+block('purchaseDisplayUnitCost'),ctx);
 return {ctx,state,fields,alerts,get saves(){return saves;}};
}
test('five physical units before sale can be written off without changing sale stock, reservations or paid purchase',()=>{
 const f=fixture(),before=structuredClone(f.state),p=f.state.purchases[0];
 assert.match(f.ctx.writeoffForm('sweet'),/<option value="at_warehouse" selected>На складе · 5 шт\./);
 f.ctx.createWriteoff();
 assert.equal(f.ctx.purchaseAtWarehouseQty('sweet'),4);assert.equal(p.qty,5);assert.equal(p.buyTotal,500);assert.equal(p.delivery,50);assert.equal(p.remainingQty,0);assert.equal(p.warehouseWrittenOffQty,1);
 assert.deepEqual(f.state.products,before.products);assert.deepEqual(f.state.reservations,before.reservations);assert.equal(f.saves,1);assert.deepEqual(f.alerts,[]);
 const m=f.state.movements[0];assert.equal(m.qty,-1);assert.equal(m.stockScope,'at_warehouse');assert.deepEqual(JSON.parse(JSON.stringify(m.warehouseLots)),[{purchaseId:'lot',qty:1,unitCost:110}]);
 assert.equal(stockLedgerViolation(before,f.state),null);
 f.state.purchases=f.state.purchases.map(x=>normalizedPurchase(JSON.parse(JSON.stringify(x))));assert.equal(f.ctx.purchaseAtWarehouseQty('sweet'),4);
});
test('warehouse writeoff takes exact oldest lots and excludes received stock, transit, baskets and other products',()=>{
 const f=fixture(),first=f.state.purchases[0];first.qty=2;first.buyTotal=200;first.delivery=20;
 const others=['received','to_me','to_forwarder'].map((status,i)=>({id:'other-'+i,productId:'sweet',status,qty:100,remainingQty:80}));
 f.state.purchases.push({id:'later',productId:'sweet',status:'at_warehouse',qty:4,warehouseReceivedAt:2,landedUnitCost:200},{id:'blue',productId:'blue',status:'at_warehouse',qty:100},...others);
 const before=structuredClone(f.state);f.fields.wq.value='3';f.ctx.createWriteoff();
 assert.equal(first.warehouseWrittenOffQty,2);assert.equal(f.state.purchases[1].warehouseWrittenOffQty,1);assert.deepEqual(f.state.purchases.slice(2),before.purchases.slice(2));
 assert.deepEqual(Array.from(f.state.movements[0].warehouseLots,x=>[x.purchaseId,x.qty,x.unitCost]),[['lot',2,110],['later',1,200]]);assert.equal(stockLedgerViolation(before,f.state),null);
});
test('overdraws and invalid quantities change neither stock pools, lots nor audit history',()=>{
 for(const qty of ['6','1.5','-1','Infinity']){const f=fixture(),before=JSON.stringify(f.state);f.fields.wq.value=qty;f.ctx.createWriteoff();assert.equal(JSON.stringify(f.state),before);assert.equal(f.saves,0);assert.equal(f.alerts.length,1);}
 const f=fixture();f.ctx.createWriteoff();f.fields.wq.value='5';const before=JSON.stringify(f.state);f.ctx.createWriteoff();assert.equal(JSON.stringify(f.state),before);assert.match(f.alerts.at(-1),/4 шт/);
});
test('partial product release and subsequent shipment release cannot resurrect the written-off unit or change total paid cost',()=>{
 const f=fixture(),before=structuredClone(f.state);f.ctx.createWriteoff();f.ctx.releaseProductWarehouseQty('sweet');
 assert.equal(f.state.products[0].stock,2);assert.equal(f.ctx.purchaseAtWarehouseQty('sweet'),2);
 const original=f.state.purchases.find(x=>x.id==='lot');assert.equal(original.qty,3);assert.equal(original.warehouseWrittenOffQty,1);
 assert.equal(stockLedgerViolation(before,f.state),null);
 const afterPartial=structuredClone(f.state);f.ctx.releaseSelectedPurchaseRows('shipment');
 assert.equal(f.state.products[0].stock,4);assert.equal(f.ctx.purchaseAtWarehouseQty('sweet'),0);assert.equal(original.qty,1);assert.equal(original.warehouseWrittenOffQty,1);
 const received=f.state.purchases.filter(x=>x.status==='received');assert.equal(received.reduce((s,x)=>s+x.remainingQty,0),4);assert.ok(received.every(x=>!x.warehouseWrittenOffQty));
 assert.ok(Math.abs(f.state.purchases.reduce((s,x)=>s+x.buyTotal+x.delivery,0)-550)<1e-8);assert.equal(stockLedgerViolation(afterPartial,f.state),null);
 const again=JSON.stringify(f.state);f.ctx.releaseSelectedPurchaseRows('shipment');assert.equal(JSON.stringify(f.state),again);
});
test('writeoff of all warehouse units leaves a paid historical lot and no units to release',()=>{
 const f=fixture();f.fields.wq.value='5';f.ctx.createWriteoff();assert.equal(f.ctx.purchaseAtWarehouseQty('sweet'),0);assert.equal(f.state.purchases[0].buyTotal,500);
 f.ctx.releaseProductWarehouseQty('sweet');assert.equal(f.state.products[0].stock,0);assert.equal(f.state.purchases.length,1);
});
test('server rejects forged scopes, missing lot decrements, overdraws and edits of historical warehouse writeoffs',()=>{
 const f=fixture(),before=structuredClone(f.state);f.ctx.createWriteoff();
 for(const change of [s=>{s.purchases[0].warehouseWrittenOffQty=0;},s=>{s.movements[0].warehouseLots[0].qty=2;},s=>{s.purchases[0].warehouseWrittenOffQty=6;},s=>{s.movements[0].productId='blue';},s=>{s.products[0].stock=-1;}]){const next=structuredClone(f.state);change(next);assert.ok(stockLedgerViolation(before,next));}
 const historical=structuredClone(f.state),edited=structuredClone(historical);edited.movements[0].stockScope='sale';assert.ok(stockLedgerViolation(historical,edited));
 const deleted=structuredClone(historical);deleted.purchases=[];assert.ok(stockLedgerViolation(historical,deleted));
 const same=structuredClone(historical);same.movements[0]=Object.fromEntries(Object.entries(same.movements[0]).reverse());assert.equal(stockLedgerViolation(historical,same),null);
});
test('stock count and valuation exclude written-off warehouse units',()=>{
 const f=fixture();f.ctx.createWriteoff();Object.assign(f.ctx,{productSearchHaystack:p=>p.id,productMapAdd:(m,k,v)=>m.set(k,(m.get(k)||0)+v)});
 vm.runInContext(block('buildProductRenderStats')+'\n'+line('productStockCostFromSnapshot'),f.ctx);
 const stats=f.ctx.buildProductRenderStats();assert.equal(stats.warehouseTotal,4);assert.equal(stats.atWarehouseCostMap.get('sweet'),440);assert.equal(f.ctx.productStockCostFromSnapshot(stats),440);
});
