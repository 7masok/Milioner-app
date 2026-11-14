import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {stockLedgerViolation} from '../src/warehouse-ledger.js';

const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
const script=readFileSync(new URL('../../purchase-arrival-sort-v1.js',import.meta.url),'utf8');
const lines=['purchaseStatus','purchaseWarehouseQty','purchaseAtWarehouseQty','captureMovementBalance','inventoryReservationNote','inventoryForm','syncInventoryFields','doInventory','movementIsStockAdjustment'];
const cost=html.slice(html.indexOf('function purchaseDisplayUnitCost('),html.indexOf('function productCardUnitCost('));

function fixture(){
 const product={id:'coffee',name:'Кофейные зёрна',stock:0,cost:70};
 const purchases=[{id:'a',productId:product.id,status:'at_warehouse',qty:5,remainingQty:0,unitCost:100,warehouseReceivedAt:1},
  {id:'b',productId:product.id,status:'at_warehouse',qty:3,remainingQty:0,unitCost:180,warehouseReceivedAt:2}];
 const state={products:[product],purchases,movements:[],reservations:[
  {id:'r',active:true,source:'FBO',productId:product.id,warehouseQty:4,warehouseLots:[{purchaseId:'a',qty:4}]}]};
 const fields={inventoryCountScope:{value:'at_warehouse'},ip:{value:product.id},iq:{value:'8'},icost:{value:'130'}};
 const alerts=[];let seq=0,saves=0;
 const ctx={state,window:{},document:{getElementById:key=>fields[key]},prod:key=>state.products.find(p=>p.id===key),stockProducts:()=>state.products,
  isBundleProduct:p=>p?.kind==='bundle',reserved:()=>0,esc:String,id:()=>String(++seq),alert:s=>alerts.push(s),save:()=>saves++,closeModal(){},render(){},requireWarehouseEditReady:()=>true,
  log(type,productId,qty,extra){const movement={id:ctx.id(),date:Date.now(),type,productId,qty,extra};state.movements.unshift(movement);return movement;}};
 vm.createContext(ctx);
 vm.runInContext(lines.map(name=>html.split('\n').find(line=>line.startsWith('function '+name+'('))).join('\n')+'\n'+cost+
  '\nfunction applyInventoryCount(){throw Error("sale count called")}\nfunction sizeInventoryForm(){}\nlet sizeInventorySession=null;',ctx);
 vm.runInContext(script.slice(script.indexOf("if(typeof inventoryForm==="),script.indexOf("if(document.readyState===")),ctx);
 return {ctx,state,product,fields,alerts,get saves(){return saves}};
}
test('warehouse-only product opens at its actual warehouse balance and adds an audited warehouse lot',()=>{
 const f=fixture(),before=structuredClone(f.state);
 const form=f.ctx.inventoryForm(f.product.id);
 assert.match(form,/value="at_warehouse" selected/);
 assert.match(form,/id="iq"[^>]+value="8"/);
 assert.match(form,/id="icost"[^>]+value="130"/);
 f.fields.iq.value='11';f.ctx.doInventory();
 const [lot]=f.state.purchases,[move]=f.state.movements;
 assert.equal(f.saves,1);assert.equal(lot.qty,3);assert.equal(lot.remainingQty,0);assert.equal(lot.status,'at_warehouse');
 assert.equal(move.type,'инвентаризация');assert.equal(move.stockScope,'at_warehouse');
 assert.equal(f.ctx.movementIsStockAdjustment(move),false);
 assert.deepEqual(f.state.products,before.products);assert.deepEqual(f.state.purchases.slice(1),before.purchases);
 assert.equal(stockLedgerViolation(before,f.state),null);
 const bad=structuredClone(f.state);bad.purchases[0].unitCost=1;
 assert.equal(stockLedgerViolation(before,bad).reason,'invalid-warehouse-inventory');
});
test('warehouse shortage uses unreserved units across lots and rejects a count below FBO reserve',()=>{
 const f=fixture(),before=structuredClone(f.state);
 f.ctx.inventoryForm(f.product.id,'at_warehouse');
 f.fields.iq.value='3';f.ctx.doInventory();
 assert.equal(f.saves,0);assert.match(f.alerts.at(-1),/FBO 4/);assert.deepEqual(f.state,before);
 f.fields.iq.value='5';f.ctx.doInventory();
 assert.equal(f.saves,1);assert.equal(f.state.purchases[0].warehouseWrittenOffQty,1);assert.equal(f.state.purchases[1].warehouseWrittenOffQty,2);
 assert.deepEqual(f.state.reservations,before.reservations);assert.deepEqual(f.state.products,before.products);
 assert.equal(f.state.movements[0].stockBalance.after,5);assert.equal(stockLedgerViolation(before,f.state),null);
});
test('stale warehouse count requires reopening the form before writing',()=>{
 const f=fixture();f.ctx.inventoryForm(f.product.id);
 f.state.purchases[0].qty=6;f.fields.iq.value='10';f.ctx.doInventory();
 assert.match(f.alerts.at(-1),/Склад изменился/);assert.equal(f.saves,0);
});
