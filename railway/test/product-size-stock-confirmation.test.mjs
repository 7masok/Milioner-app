import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {preserveWbValidation} from '../src/wb-link-validation.js';
const sync=readFileSync(new URL('../src/wb-stock-sync.js',import.meta.url),'utf8');
const ctx={};vm.createContext(ctx);vm.runInContext(sync.match(/export function wbStockPublishReady[^\n]+/)[0].replace('export ',''),ctx);
test('new size cannot overwrite existing WB quantity until own inventory is confirmed',()=>{assert.equal(ctx.wbStockPublishReady({wbSizeStockPending:{WB:true}},'WB'),false);assert.equal(ctx.wbStockPublishReady({wbSizeStockPending:{WB:true}},'WB2'),true);assert.equal(ctx.wbStockPublishReady({},'WB'),true);assert.match(sync,/for\(const product of linked\)\{\s*if\(!wbStockPublishReady\(product,id\)\)/)});
test('only a new explicit inventory confirmation for this product and cabinet releases the block',()=>{
 const old={products:[{id:'p',stock:0,wbSizeStockPending:{WB:true}}],movements:[{id:'historic',type:'инвентаризация',productId:'p',wbSizeStockConfirmation:['WB']}]};
 for(const movements of [[],old.movements,[{id:'other',type:'инвентаризация',productId:'other',wbSizeStockConfirmation:['WB']}],[{id:'other',type:'инвентаризация',productId:'p',wbSizeStockConfirmation:['WB2']}],[{id:'other',type:'приход',productId:'p',wbSizeStockConfirmation:['WB']}],[{id:'other',type:'инвентаризация',productId:'p'}]]){const next={products:[{id:'p',stock:0}],movements};preserveWbValidation(old,next);assert.equal(next.products[0].wbSizeStockPending.WB,true)}
 const next={products:[{id:'p',stock:0}],movements:[{id:'new-zero',type:'инвентаризация',productId:'p',qty:0,wbSizeStockConfirmation:['WB']}]};preserveWbValidation(old,next);assert.equal(next.products[0].wbSizeStockPending,undefined);
});
test('manual inventory records confirmation even when the counted quantity remains zero',()=>{const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8'),line=html.split('\n').find(x=>x.startsWith('function doInventory(')),p={id:'p',stock:0,cost:10,wbSizeStockPending:{WB:true}},movements=[];const c={document:{getElementById:id=>({value:id==='ip'?'p':id==='iq'?'0':'10'})},prod:()=>p,requireWarehouseEditReady:()=>true,isBundleProduct:()=>false,reserved:()=>0,fifoLots:()=>[],state:{purchases:[]},fmt:String,log:(type,productId,qty,extra)=>{const m={type,productId,qty,extra};movements.push(m);return m},save(){},closeModal(){},render(){}};vm.createContext(c);vm.runInContext(line.slice(0,line.indexOf('function showSheet(')),c);c.doInventory();assert.equal(p.stock,0);assert.equal(p.wbSizeStockPending,undefined);assert.deepEqual([...movements[0].wbSizeStockConfirmation],['WB']);assert.equal(movements[0].qty,0)});
