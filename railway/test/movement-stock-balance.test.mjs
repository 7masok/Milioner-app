import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {captureMovementBalance as serverCapture} from '../src/movement-stock-balance.js';
import {stockLedgerViolation} from '../src/warehouse-ledger.js';
const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
const compat=readFileSync(new URL('../../kaspi-status-compat-v1.js',import.meta.url),'utf8');
function fn(name){const start=html.indexOf('function '+name+'(');assert.ok(start>=0);return html.slice(start,html.indexOf('\n',start));}
function fixture(q='3',cost='200',withLot=true){
 const p={id:'p',name:'Брелок',stock:10,cost:100,wbSizeStockPending:{WB:true}},old={id:'old',productId:'p',qty:10,remainingQty:10,unitCost:100,landedUnitCost:100};
 const state={products:[p],purchases:withLot?[old]:[],movements:[],reservations:[{active:true,qty:7}]},alerts=[];let n=0,saves=0;
 const fields={foundStockProduct:{value:'p'},foundStockQty:{value:q},foundStockCost:{value:cost},foundStockPreview:{}};
 const ctx={state,Date,Number,String,Math,document:{getElementById:id=>fields[id]},id:()=>String(++n),prod:id=>id==='p'?p:null,requireWarehouseEditReady:()=>true,isBundleProduct:()=>false,fifoLots:id=>state.purchases.filter(l=>l.productId===id&&l.remainingQty>0),fmt:String,save:()=>saves++,closeModal(){},render(){},alert:m=>alerts.push(m)};
 vm.createContext(ctx);vm.runInContext(['captureMovementBalance','recordedMovementBalance','movementBalanceHtml','log','refreshProductAverageCost','updateFoundStockPreview','addFoundStock'].map(fn).join('\n'),ctx);
 return {ctx,p,old,state,alerts,fields,saves:()=>saves};
}
test('found units add a delta, preserve old FIFO cost/reservations and record before/after without treating it as a purchase',()=>{
 const f=fixture(),before=structuredClone(f.state);f.ctx.updateFoundStockPreview();assert.match(f.fields.foundStockPreview.textContent,/Было 10 .* найдено 3 .* станет 13/);
 f.ctx.addFoundStock();assert.equal(f.p.stock,13);assert.equal(f.old.unitCost,100);assert.equal(f.old.remainingQty,10);assert.equal(f.state.purchases[0].qty,3);assert.equal(f.state.purchases[0].inventoryAdjustment,true);assert.equal(f.state.purchases[0].foundStock,true);assert.equal(f.state.purchases[0].unitCost,200);assert.equal(f.saves(),1);assert.equal(f.state.reservations[0].qty,7);assert.equal(f.p.wbSizeStockPending.WB,true);
 assert.ok(Math.abs(f.p.cost-1600/13)<1e-9);const m=f.state.movements[0];assert.equal(m.type,'излишек');assert.equal(m.qty,3);assert.equal(m.stockBalance.before,10);assert.equal(m.stockBalance.after,13);assert.equal(f.state.purchases[0].adjustmentMovementId,m.id);assert.equal(stockLedgerViolation(before,f.state),null);
});
test('legacy stock receives its own baseline at old cost and only found units get the entered cost',()=>{
 const f=fixture('3','200',false);f.ctx.addFoundStock();assert.equal(f.state.purchases.length,2);assert.equal(f.state.purchases[1].qty,10);assert.equal(f.state.purchases[1].landedUnitCost,100);assert.equal(f.p.stock,13);assert.ok(Math.abs(f.p.cost-1600/13)<1e-9);
});
test('invalid quantities and costs never partially mutate stock or lots',()=>{
 for(const [q,c] of [['','200'],['0','200'],['-1','200'],['1.5','200'],['9007199254740991','200'],['3',''],['3','-1'],['3','Infinity']]){const f=fixture(q,c),before=JSON.stringify(f.state);f.ctx.addFoundStock();assert.equal(JSON.stringify(f.state),before);assert.equal(f.saves(),0);assert.equal(f.alerts.length,1);}
});
test('balance observes zero once reached; client and server use the same validated observation format',()=>{
 const f=fixture(),m={id:'m',date:123,type:'продажа',productId:'p',qty:-2};f.ctx.captureMovementBalance(m,0);const server=serverCapture({id:'m',date:123,type:'продажа',productId:'p',qty:-2},0);assert.equal(JSON.stringify(m),JSON.stringify(server));assert.match(f.ctx.movementBalanceHtml(m),/Осталось: 0 шт. · Закончился/);
 m.qty=-1;assert.equal(f.ctx.recordedMovementBalance(m),null);assert.match(f.ctx.movementBalanceHtml(m),/Остаток не записан/);
 const ware={id:'w',date:124,type:'списание',productId:'p',qty:-1,stockScope:'at_warehouse'};serverCapture(ware,3,'at_warehouse');assert.match(f.ctx.movementBalanceHtml(ware),/На складе: 3/);
});
test('old inventory can show its explicitly recorded count; other historical balances are never invented',()=>{
 const f=fixture();const old={type:'инвентаризация',productId:'p',qty:-10,extra:'было 10, стало 0 · себестоимость 100/шт.'};assert.equal(f.ctx.recordedMovementBalance(old).after,0);assert.match(f.ctx.movementBalanceHtml(old),/Закончился/);
 old.stockBalanceInvalidated=true;assert.equal(f.ctx.recordedMovementBalance(old),null);assert.equal(f.ctx.recordedMovementBalance({type:'продажа',productId:'p',qty:-1}),null);
});
test('both movement renderers show balance after signed quantities and final compatibility log captures it without trimming history',()=>{
 assert.match(fn('renderMovement'),/movementBalanceHtml\(m\)/);assert.match(compat,/movementBalanceHtml\(m\)/);assert.match(compat,/captureMovementBalance\(movement,p.stock\)/);assert.doesNotMatch(fn('log'),/slice\(0,1000\)/);assert.match(html,/＋ Добавить остаток<\/button>/);assert.match(html,/value="излишек"/);
});
