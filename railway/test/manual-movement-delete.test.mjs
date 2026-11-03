import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
function fixture(stock=10,remaining=3){
 const product={id:'p',stock,cost:5};
 const movement={id:'m',type:'инвентаризация',productId:'p',qty:3,date:10,extra:'было 7, стало 10'};
 const lot={id:'lot',productId:'p',qty:3,remainingQty:remaining,adjustmentMovementId:'m'};
 const state={movements:[movement],purchases:[lot]};
 let saves=0;
 const c=vm.createContext({state,Date,Number,Math,String,decodeURIComponent,requireWarehouseEditReady:()=>true,prod:()=>product,isBundleProduct:()=>false,confirm:()=>true,alert:()=>{},movementIsStockAdjustment:m=>m.type==='инвентаризация',movementAdjustmentLots:()=>[lot],movementAdjustmentLabel:()=>'',fifoLots:()=>[],fmt:String,save:()=>saves++,closeModal(){},render(){},document:{getElementById:()=>null}});
 for(const name of ['deleteManualMovement','saveMovementEdit'])vm.runInContext(html.split('\n').find(x=>x.startsWith('function '+name+'(')),c);
 return {c,state,product,lot,saves:()=>saves};
}
test('deleting inventory reverses stock and its own lot once',()=>{
 const f=fixture();f.c.deleteManualMovement('m');
 assert.equal(f.product.stock,7);assert.equal(f.lot.remainingQty,0);assert.equal(f.state.movements.length,0);assert.equal(f.saves(),1);
 f.c.deleteManualMovement('m');assert.equal(f.product.stock,7);assert.equal(f.saves(),1);
});
test('used inventory cannot silently remove another purchase lot',()=>{
 const f=fixture(8,1);f.c.deleteManualMovement('m');
 assert.equal(f.product.stock,8);assert.equal(f.lot.remainingQty,1);assert.equal(f.state.movements.length,1);assert.equal(f.saves(),0);
});
test('automatic inventory cannot be deleted as a manual entry',()=>{
 const f=fixture();f.state.movements[0].extra='Автокоррекция';f.c.deleteManualMovement('m');assert.equal(f.saves(),0);
});
