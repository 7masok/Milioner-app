import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {matchKaspiSettlements} from '../src/kaspi-purchase-settlements.js';

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

test('Kaspi commission reconciles by order code with actual expenses and full refunds',()=>{
 const order={id:'sale-1',qty:2,order_id:'internal-id',code:'4200',total_price:1000,status:'COMPLETED',entry_count:1};
 const sale={orderId:'4200',operation:'Покупка',amount:1000,commission:-120,kaspiPay:-8,delivery:-51};
 assert.deepEqual(matchKaspiSettlements([order],[sale]),{'sale-1':{sold:2,proceeds:821}});
 const refund={...sale,operation:'Возврат',amount:-1000,commission:120,kaspiPay:8,delivery:0};
 assert.deepEqual(matchKaspiSettlements([order],[sale,refund]),{'sale-1':{sold:0,proceeds:-51}});
 assert.deepEqual(matchKaspiSettlements([{...order,entry_count:2}],[sale]),{});
 assert.deepEqual(matchKaspiSettlements([order],[{...sale,amount:990}]),{});
});
