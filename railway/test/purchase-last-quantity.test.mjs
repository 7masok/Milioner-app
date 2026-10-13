import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
const source=html.slice(html.indexOf('function purchaseLastQuantity('),html.indexOf('function updatePurchaseAverageEstimates('));
function setup(purchases){
 const ctx={state:{purchases},purchaseWorkflow:()=>[{id:'cart',name:'Корзина'}],normalizeName:x=>x.toLowerCase(),purchaseStatus:x=>x.status||'received',purchaseWorkflowStage:x=>x.workflowStageId,prod:id=>id==='p'?{id}:null,purchaseAverageBuyUnitCost:()=>0,fmt:n=>n+' ₸'};
 vm.createContext(ctx);vm.runInContext(source,ctx);return ctx;
}
const row=(id,qty,date,extra={})=>({id,productId:'p',qty,orderedAt:date,...extra});
test('last purchase uses original quantity, stable product identity and order date',()=>{
 const rows=[row('recent',50,20,{remainingQty:3}),row('older',100,10,{receivedAt:50}),row('other',999,30,{productId:'other'})],before=JSON.stringify(rows),c=setup(rows);
 assert.equal(c.purchaseLastQuantity('p'),50);assert.equal(JSON.stringify(rows),before);
});
test('split lines in the same last shipment are summed including paid transit',()=>{
 const c=setup([row('a',15,20,{shipmentId:'s',status:'at_warehouse'}),row('b',35,20,{shipmentId:'s',status:'received'}),row('c',60,30,{status:'to_me'})]);
 assert.equal(c.purchaseLastQuantity('p'),60);assert.equal(c.purchaseLastQuantity('p','c'),50);
});
test('cart and stock bookkeeping cannot replace purchase history',()=>{
 const c=setup([row('real',25,10),row('cart',800,30,{status:'to_forwarder',workflowStageId:'cart'}),row('move',900,40,{relocation:true}),row('inv',900,50,{inventoryAdjustment:true}),row('opening',900,60,{opening:true}),row('zero',0,70)]);
 assert.equal(c.purchaseLastQuantity('p'),25);
});
test('editing excludes all current shipment lines and subsequent purchases',()=>{
 const c=setup([row('a',5,20,{shipmentId:'current'}),row('b',10,20,{shipmentId:'current'}),row('past',40,10),row('future',100,30)]);
 assert.equal(c.purchaseLastQuantity('p','current'),40);
 assert.match(html,/id="editPurchaseItems" data-shipment-key=/);
 assert.match(html,/purchaseAverageEstimate\(x.productId,x.qty,x.row.closest\('#editPurchaseItems'\)/);
});
test('last quantity remains visible with unknown price or empty quantity',()=>{
 const c=setup([row('last',50,10)]);
 assert.match(c.purchaseAverageEstimate('p',19),/В прошлой закупке: 50 шт\.\nНет закупочной цены/);
 assert.match(c.purchaseAverageEstimate('p',0),/В прошлой закупке: 50 шт\.\nУкажите количество/);
 c.purchaseAverageBuyUnitCost=()=>191;
 assert.match(c.purchaseAverageEstimate('p',19),/В прошлой закупке: 50 шт\.\nОриентировочно без доставки: ≈ 3629 ₸/);
 assert.equal(c.state.purchases[0].qty,50);
});
test('missing history is explicit rather than a fabricated zero',()=>{
 const c=setup([]);assert.equal(c.purchaseLastQuantity('p'),null);
 assert.match(c.purchaseAverageEstimate('p',10),/Прошлой закупки этого товара нет/);
 assert.equal(c.purchaseAverageEstimate('',10),'Выберите товар и укажите количество');
});
