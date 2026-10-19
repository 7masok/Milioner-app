import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../../purchase-delete-v1.js',import.meta.url),'utf8');
const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
function fixture(status='to_forwarder'){
 const state={products:[{id:'boxes',name:'Коробочки 5х5',stock:50,cost:48},{id:'other',name:'Другой товар',stock:9}],purchases:[{id:'lot',shipmentId:'shipment',productId:'boxes',qty:50,remainingQty:status==='received'?50:0,status,batch:'Ошибочная поставка',buyTotal:2383},{id:'other-lot',shipmentId:'other',productId:'other',qty:9,status:'received',remainingQty:9}],sales:[],movements:[]},alerts=[],deleted=[],prompts=[];let saves=0,accepted=true,ready=true,reserve=0;
 const ctx={state,document:{getElementById:()=>null},openPurchaseShipment(){},purchaseShipmentRows:key=>state.purchases.filter(r=>r.shipmentId===decodeURIComponent(key)),purchaseStatus:r=>r.status,prod:id=>state.products.find(p=>p.id===id),reserved:()=>reserve,requireWarehouseEditReady:()=>ready,rememberPurchaseDeletes:ids=>deleted.push(...ids),confirm:s=>{prompts.push(s);return accepted},alert:s=>alerts.push(s),save(){saves++},closeModal(){},render(){},refreshProductAverageCost(){},log(type,productId,qty,extra){state.movements.push({type,productId,qty,extra})}};ctx.window=ctx;vm.createContext(ctx);vm.runInContext(source,ctx);
 return {ctx,state,alerts,deleted,prompts,get saves(){return saves},set accepted(v){accepted=v},set ready(v){ready=v},set reserve(v){reserve=v}};
}
test('deleting an erroneous single-item shipment removes every row and sync tombstone without touching other stock or purchase',()=>{
 const f=fixture(),other=structuredClone(f.state.purchases[1]),products=structuredClone(f.state.products);f.ctx.deletePurchaseShipment('shipment');assert.equal(f.state.purchases.length,1);assert.deepEqual(f.state.purchases[0],other);assert.deepEqual(f.state.products,products);assert.deepEqual(f.deleted,['lot']);assert.equal(f.saves,1);assert.match(f.prompts[0],/50 шт/);
});
test('all positions of a shipment are deleted together',()=>{
 const f=fixture();f.state.purchases.push({...f.state.purchases[0],id:'lot2',productId:'other',qty:2});f.ctx.deletePurchaseShipment('shipment');assert.equal(f.state.purchases.length,1);assert.deepEqual(f.deleted,['lot','lot2']);
});
test('cancel and readonly cache do not remove anything or write tombstones',()=>{
 for(const mode of ['cancel','readonly']){const f=fixture(),before=structuredClone(f.state);if(mode==='cancel')f.accepted=false;else f.ready=false;f.ctx.deletePurchaseShipment('shipment');assert.deepEqual(f.state,before);assert.equal(f.saves,0);assert.equal(f.deleted.length,0)}
});
test('unused received stock is rolled back with a matching stock movement',()=>{
 const f=fixture('received');f.ctx.deletePurchaseShipment('shipment');assert.equal(f.state.products[0].stock,0);assert.equal(f.state.movements.length,1);assert.equal(f.state.movements[0].qty,-50);assert.equal(f.saves,1);
});
test('FIFO consumed lots, warehouse writeoffs, inventory lots, relocations and stock committed to orders cannot be removed',()=>{
 for(const mutate of [f=>f.state.purchases[0].remainingQty=49,f=>f.state.sales.push({fifoLots:[{purchaseId:'lot',qty:1}]}),f=>f.state.purchases[0].warehouseWrittenOffQty=1,f=>f.state.purchases[0].inventoryAdjustment=true,f=>f.state.purchases[0].relocation=true,f=>f.reserve=1]){
  const f=fixture('received');mutate(f);const before=structuredClone(f.state);f.ctx.deletePurchaseShipment('shipment');assert.deepEqual(f.state,before);assert.equal(f.saves,0);assert.equal(f.deleted.length,0);assert.ok(f.alerts.length);
 }
 const f=fixture('at_warehouse');f.state.purchases[0].warehouseWrittenOffQty=1;f.ctx.deletePurchaseShipment('shipment');assert.equal(f.saves,0);
});
test('removing the last item in the existing editor offers full shipment deletion, and cancel preserves the form',()=>{
 const start=html.indexOf('function removeEditPurchaseItem('),end=html.indexOf('\nfunction ',start+10);
 for(const accepted of [true,false]){const f=fixture();f.accepted=accepted;vm.runInContext(html.slice(start,end),f.ctx);let removed=false;const box={dataset:{shipmentKey:'shipment'},querySelectorAll:()=>[{}]},btn={closest:selector=>selector==='#editPurchaseItems'?box:{remove(){removed=true}}};f.ctx.removeEditPurchaseItem(btn);assert.equal(f.saves,accepted?1:0);assert.equal(f.state.purchases.length,accepted?1:2);assert.equal(removed,false);assert.equal(f.prompts.length,1)}
});
test('both editors visibly offer full deletion even when the shipment has one item',()=>{
 for(const name of ['openEditPurchaseShipment','openCorrectReceivedPurchaseShipment']){const start=html.indexOf('function '+name+'('),end=html.indexOf('\nfunction ',start+10);assert.match(html.slice(start,end),/deletePurchaseShipment\('\$\{key\}'\).*?Удалить поставку полностью/)}
});
