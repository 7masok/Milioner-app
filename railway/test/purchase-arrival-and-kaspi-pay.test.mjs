import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {matchKaspiSettlements} from '../src/kaspi-purchase-settlements.js';

test('shipment editor exposes distribution while the manual-total warning stays hidden',()=>{
 const distribute={};
 const actions={
  hidden:true,
  querySelector:selector=>selector==='button[onclick^="applyPurchaseGrandTotal("]'?distribute:null,
  before(button){visibleButtons.push(button)}
 };
 const visibleButtons=[];
 const sheet={querySelector:selector=>selector==='#editPorBuyTotalActions, #correctPorBuyTotalActions'?actions:null};
 const context={
  window:{addEventListener(){}},
  document:{getElementById:id=>id==='sheet'?sheet:null,readyState:'loading',addEventListener(){}},
  createArrival(){},openEditPurchaseShipment(){},purchaseSortChanged(){},sortPurchaseGroups(){}
 };
 vm.runInNewContext(readFileSync(new URL('../../purchase-arrival-sort-v1.js',import.meta.url),'utf8'),context);
 context.openEditPurchaseShipment('354');
 assert.deepEqual(visibleButtons,[distribute]);
 assert.equal(actions.hidden,true);
});

test('direct receipt lands on the warehouse without changing sellable stock or FIFO',()=>{
 const product={id:'coffee',stock:4,cost:600},state={purchases:[],products:[product]};
 const fields={ar:{value:'2026-11-13'},ad:{value:'100'},ab:{value:'Ибр'}};
 let saves=0,seq=0;
 const c={window:{addEventListener(){}},document:{getElementById:id=>fields[id],readyState:'loading',addEventListener(){}},
  createArrival(){},openEditPurchaseShipment(){},purchaseSortChanged(){},sortPurchaseGroups(){},
  state,prod:id=>id===product.id?product:null,requireWarehouseEditReady:()=>true,
  arrivalDraftRows:()=>[{productId:product.id,qty:100,buy:70000}],id:()=>String(++seq),localDateStart:Date.parse,
  save:()=>saves++,closeModal(){},render(){},alert:assert.fail};
 vm.runInNewContext(readFileSync(new URL('../../purchase-arrival-sort-v1.js',import.meta.url),'utf8'),c);
 c.createArrival();
 assert.equal(saves,1);assert.equal(product.stock,4);assert.equal(product.cost,600);
 assert.equal(state.purchases[0].status,'at_warehouse');assert.equal(state.purchases[0].remainingQty,0);
 assert.equal(state.purchases[0].qty,100);assert.equal(state.purchases[0].landedUnitCost,701);
});

test('shipment correction summarizes split lots by product ID and keeps every original edit row',()=>{
 const rows=[
  {id:'a',productId:'apple',qty:80,status:'at_warehouse'},
  {id:'b',productId:'apple',qty:5,status:'received',remainingQty:0},
  {id:'c',productId:'apple',qty:5,status:'received',remainingQty:0},
  {id:'d',productId:'apple',qty:10,status:'received',remainingQty:0},
  {id:'e',productId:'berry',qty:4,status:'at_warehouse'}
 ];
 const original=structuredClone(rows),inserted=[];
 const elements=rows.map(row=>{
  const price={value:row.id==='b'?'650.0000000000001':row.id==='c'?'650.123456':'650'};
  return {dataset:{id:row.id},price,querySelector:()=>price,before:node=>inserted.push(node)};
 });
 const createElement=tag=>({tag,style:{},children:[],append(...children){this.children.push(...children)}});
 const sheet={querySelector:()=>true,querySelectorAll:()=>elements};
 const context={window:{addEventListener(){}},document:{getElementById:()=>sheet,createElement,readyState:'loading',addEventListener(){}},
  createArrival(){},openEditPurchaseShipment(){},openCorrectReceivedPurchaseShipment(){},purchaseSortChanged(){},sortPurchaseGroups(){},
  purchaseShipmentRows:()=>rows,purchaseStatus:row=>row.status,purchaseWarehouseQty:row=>row.status==='at_warehouse'?row.qty:0,
  productNameById:id=>id==='apple'?'Форма яблоко':'Малина'};
 vm.runInNewContext(readFileSync(new URL('../../purchase-arrival-sort-v1.js',import.meta.url),'utf8'),context);
 context.openCorrectReceivedPurchaseShipment('shipment');
 assert.equal(inserted.length,1);
 const [detail]=inserted,[summary,...parts]=detail.children;
 assert.equal(detail.tag,'details');
 assert.equal(summary.children[0].textContent,'Форма яблоко · 100 шт.');
 assert.match(summary.children[1].textContent,/Выбыло 20 шт. · На складе 80 шт./);
 assert.deepEqual(parts,elements.slice(0,4));
 assert.equal(elements[1].price.value,'650');
 assert.equal(elements[2].price.value,'650.123456');
 assert.deepEqual(rows,original);
});

test('Kaspi commission reconciles by order code with actual expenses and full refunds',()=>{
 const order={id:'sale-1',qty:2,order_id:'internal-id',code:'4200',total_price:1000,status:'COMPLETED',entry_count:1};
 const sale={orderId:'4200',operation:'Покупка',amount:1000,commission:-120,kaspiPay:-8,delivery:-51};
 assert.deepEqual(matchKaspiSettlements([order],[sale]),{'sale-1':{sold:2,proceeds:821}});
 const refund={...sale,operation:'Возврат',amount:-1000,commission:120,kaspiPay:8,delivery:0};
 assert.deepEqual(matchKaspiSettlements([order],[sale,refund]),{'sale-1':{sold:0,proceeds:-51}});
 assert.deepEqual(matchKaspiSettlements([{...order,entry_count:2}],[sale]),{});
 assert.deepEqual(matchKaspiSettlements([order],[{...sale,amount:990}]),{});
});
