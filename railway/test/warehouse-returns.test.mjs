import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {returnReceiptViolation,preserveReturnReceipts} from '../src/warehouse-returns.js';
const key='WB:order:entry',receipt={at:10,action:'Возврат WB в продажу'},stock=(id,k=key)=>({id,type:'возврат',qty:1,productId:'p',externalKey:k,returnReceiptKey:k});
test('server rejects repeated receipt from an old client and structured repeated stock credits',()=>{
 const previous={settings:{wbReturnReceipts:{[key]:receipt}},movements:[]};
 assert.equal(returnReceiptViolation(previous,{settings:{wbReturnReceipts:{[key]:{at:11}}},movements:[{id:'legacy',type:'возврат',qty:1}]}).reason,'return-already-processed');
 assert.equal(returnReceiptViolation(previous,{settings:{},movements:[stock('second')]}).reason,'return-already-processed');
 assert.equal(returnReceiptViolation(previous,{settings:{},movements:[stock('other','WB:other:entry')]}),null);
});
test('server preserves accepted receipts on missing, stale or changed settings snapshots',()=>{
 const prior={settings:{wbReturnReceipts:{[key]:receipt},kaspiReturnReceipts:{order:{at:20}}}};
 const next={settings:{other:true,wbReturnReceipts:{[key]:{at:99},new:{at:30}}}};preserveReturnReceipts(prior,next);
 assert.deepEqual(next.settings.wbReturnReceipts,{[key]:receipt,new:{at:30}});assert.deepEqual(next.settings.kaspiReturnReceipts,prior.settings.kaspiReturnReceipts);assert.equal(next.settings.other,true);
});
test('duplicate debits and same-order credits are blocked while bundle products and separate order entries are allowed',()=>{
 const previous={movements:[{...stock('first'),reversesMovementId:'debit'}]};
 assert.equal(returnReceiptViolation(previous,{movements:[...previous.movements,{...stock('next'),reversesMovementId:'debit'}]}).reason,'return-already-processed');
 assert.equal(returnReceiptViolation({}, {movements:[stock('a'),stock('b')]}).reason,'duplicate-order-return');
 assert.equal(returnReceiptViolation({}, {movements:[stock('a'),{...stock('b'),productId:'component'}]}),null);
 assert.equal(returnReceiptViolation({}, {movements:[{...stock('a','Kaspi:o:e1'),returnReceiptKey:'Kaspi:o'},{...stock('b','Kaspi:o:e2'),returnReceiptKey:'Kaspi:o'}]}),null);
 assert.equal(returnReceiptViolation({settings:{kaspiReturnReceipts:{o:{at:10}}}}, {movements:[{...stock('a','Kaspi:o:e1'),returnReceiptKey:'Kaspi:o'}]}).reason,'return-already-processed');
});
const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8'),fn=name=>html.split('\n').find(s=>s.startsWith('function '+name+'('));
function browser(){
 const state={settings:{},products:[{id:'p',name:'Клавиши',stock:0,cost:310}],sales:[{externalKey:key}],movements:[{id:'debit',type:'продажа',externalKey:key,productId:'p',qty:-1}],purchases:[]},alerts=[];let saved=0,id=0;
 const ctx=vm.createContext({state,wbReturnResolved:{externalKey:key,market:'WB',orderId:'order',productId:'p',qty:1},requireWarehouseEditReady:()=>true,isWbMarket:m=>m==='WB',prod:pid=>state.products.find(p=>p.id===pid),isBundleProduct:()=>false,id:()=>String(++id),log:(type,productId,qty,extra)=>{const m={id:String(++id),type,productId,qty,extra};state.movements.unshift(m);return m},refreshProductAverageCost(){},returnMarketLabel:()=> 'WB1',save:()=>saved++,stopWbReturnScan(){},closeModal(){},render(){},alert:message=>alerts.push(message)});
 vm.runInContext(fn('wbReturnTargets')+'\n'+fn('processWbReturn'),ctx);return{state,ctx,alerts,get saved(){return saved}};
}
test('manual WB return stamps its exact order and debit and a double click cannot credit stock twice',()=>{
 const f=browser();f.ctx.processWbReturn('stock');assert.equal(f.state.products[0].stock,1);assert.equal(f.saved,1);const m=f.state.movements.find(m=>m.type==='возврат');assert.equal(m.externalKey,key);assert.equal(m.returnReceiptKey,key);assert.equal(m.manualReturn,true);assert.ok(f.state.movements.find(m=>m.id==='debit').stockRestoredAt);
 f.ctx.processWbReturn('stock');assert.equal(f.state.products[0].stock,1);assert.equal(f.saved,1);assert.match(f.alerts.at(-1),/уже обработан/);
});
test('a forgotten receipt cannot enable the old fallback after an automatic restoration',()=>{
 const f=browser();f.state.movements[0].stockRestoredAt=100;f.ctx.processWbReturn('stock');assert.equal(f.state.products[0].stock,0);assert.equal(f.saved,0);assert.match(f.alerts.at(-1),/Ничего не изменено/);
});
test('warehouse save validates duplicate receipts under the existing revision/transaction lock before writing stock',()=>{
 const server=readFileSync(new URL('../src/warehouse.js',import.meta.url),'utf8');assert.ok(server.indexOf('returnReceiptViolation(previous, state)')>server.indexOf('baseRevision !== currentRevision'));assert.ok(server.indexOf('returnReceiptViolation(previous, state)')<server.indexOf('await persistWarehouseMovements(client, movementRows'));assert.match(server,/preserveReturnReceipts\(previous,state\)/);
});

test('an old client cannot credit an automatically restored WB debit even when no manual receipt existed',()=>{
 const previous={movements:[{id:'old-debit',type:'продажа',externalKey:key,stockRestoredAt:5,qty:-1}]};
 assert.equal(returnReceiptViolation(previous,{settings:{wbReturnReceipts:{[key]:{at:20}}},movements:[...previous.movements,{id:'legacy',type:'возврат',qty:1}]}).reason,'return-already-processed');
 assert.equal(returnReceiptViolation(previous,{settings:{},movements:[...previous.movements,stock('modern')]}).reason,'return-already-processed');
});

test('new manual return movements and receipts retain the confirmed size and barcode for later review',()=>{
 const f=browser();Object.assign(f.ctx.wbReturnResolved,{size:'8',sizeKnown:true,variantBarcode:'barcode-eight'});f.ctx.processWbReturn('stock');const m=f.state.movements.find(m=>m.type==='возврат');assert.equal(m.returnSize,'8');assert.equal(m.returnBarcode,'barcode-eight');assert.match(m.extra,/размер 8/);assert.equal(f.state.settings.wbReturnReceipts[key].size,'8');assert.equal(f.state.settings.wbReturnReceipts[key].sizeKnown,true);
});
