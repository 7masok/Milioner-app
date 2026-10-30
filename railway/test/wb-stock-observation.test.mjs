import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {preserveWbValidation,linkFingerprint} from '../src/wb-link-validation.js';
const ui=readFileSync(new URL('../../wb-variants-v1.js',import.meta.url),'utf8');
const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
const storeHelpers=['productStoreCodes','productStoreLinksHtml'].map(name=>{const start=html.indexOf('function '+name+'(');return html.slice(start,html.indexOf('\nfunction ',start+10));}).join('\n');
const backend=readFileSync(new URL('../src/wb-stock-sync.js',import.meta.url),'utf8');
function product(id,stock,amount,at=Date.now()){
 return {id,name:id,stock,variantGroupId:'g',reserved:0,wb:id,wbVariant:{market:'WB',nmId:'1',chrtId:Number(id),barcode:id,wbAmount:0,checkedAt:Date.now()-4*86400000,stockObservation:amount===undefined?undefined:{amount,at,warehouseId:'wh',pending:false}}};
}
function harness(rows){
 const group={id:'g',kind:'variant-group',name:'Кольца'};let readonly=false,sheet='';
 const context={window:{},state:{products:[group,...rows]},warehouseRemoteReady:false,document:{documentElement:{hasAttribute:()=>readonly},createElement:()=>({}),head:{appendChild(){}}},stockProducts(){},reserved:p=>p.reserved||0,productDisplayStock:p=>p.stock,productAvailableStock:p=>Math.max(0,p.stock-(p.reserved||0)),productCard:()=>'',openProduct(){},buildProductRenderStats:()=>({products:[]}),prod:id=>context.state.products.find(p=>p.id===id),esc:x=>String(x),isBundleProduct:()=>false,packagingProductBlock:()=>'',setTimeout(){},showSheet:s=>sheet=s};
 vm.createContext(context);vm.runInContext("let productStoreFilter='all';\n"+storeHelpers,context);vm.runInContext(ui,context);
 return {context,group,card:()=>context.productCard(group),open:()=>{context.openProduct('g');return sheet},readonly:v=>readonly=v};
}
test('reload displays cached quantities immediately with update marker, then replaces them with server data',()=>{
 const h=harness([product('1',0,44)]),before=JSON.stringify(h.context.state);
 assert.match(h.card(),/В продаже: 0/);assert.match(h.card(),/WB: 44 шт. · обновляется/);assert.match(h.card(),/Обновляется/);assert.doesNotMatch(h.card(),/Остатки: —/);
 assert.match(h.open(),/WB: 44 шт. · обновляется/);assert.match(h.open(),/последние данные/);assert.equal(JSON.stringify(h.context.state),before);
 h.context.state.products[1]=product('1',44,undefined);h.context.warehouseRemoteReady=true;
 assert.match(h.card(),/В продаже: 44/);assert.match(h.card(),/WB: 0 шт. · снимок/);assert.doesNotMatch(h.card(),/WB: —|склад:/);
 const authoritative=JSON.stringify(h.context.state);
 h.readonly(true);assert.match(h.card(),/В продаже: 44/);assert.match(h.card(),/Обновляется/);h.readonly(false);assert.match(h.card(),/В продаже: 44/);
 assert.equal(JSON.stringify(h.context.state),authoritative);assert.notEqual(before,authoritative);
});
test('old WB observations retain numbers with snapshot label; incomplete or mixed warehouses never manufacture totals',()=>{
 const rows=[product('1',20,0),product('2',24,0)],h=harness(rows);h.context.warehouseRemoteReady=true;
 assert.match(h.card(),/WB: 0 шт/);assert.doesNotMatch(h.card(),/снимок/);
 rows[1].wbVariant.stockObservation.at=Date.now()-31*60000;assert.match(h.card(),/WB: 0 шт. · снимок/);assert.doesNotMatch(h.card(),/color:#a40000/);
 rows[1].wbVariant.stockObservation.at=Date.now();rows[1].wbVariant.stockObservation.warehouseId='other';assert.match(h.card(),/WB: обновляется/);
 rows[1].wbVariant.stockObservation.warehouseId='wh';rows[1].wbVariant.stockObservation.amount=null;assert.match(h.card(),/WB: обновляется/);
 rows[1].wbVariant.stockObservation.amount=24;rows[0].wbVariant.stockObservation.amount=20;rows[0].reserved=1;rows[0].wbVariant.stockObservation.amount=19;
 assert.match(h.card(),/В продаже: 43/);assert.doesNotMatch(h.card(),/color:#a40000/);
 rows[0].wbVariant.stockObservation.pending=true;assert.match(h.card(),/WB: 43 шт. · обновляется/);
});
test('no WB history keeps warehouse quantities visible without fake marketplace zero',()=>{
 const row=product('1',44,undefined);delete row.wbVariant.wbAmount;const h=harness([row]);
 assert.match(h.card(),/В продаже: 44/);assert.match(h.card(),/WB: обновляется/);assert.doesNotMatch(h.card(),/WB: 0|WB: —/);
});
test('server observations survive an older client but cannot follow a changed characteristic',()=>{
 const old=product('1',44,44),next=structuredClone(old);next.stock=40;delete next.wbVariant.stockObservation;
 preserveWbValidation({products:[old]},{products:[next]});assert.deepEqual(next.wbVariant.stockObservation,old.wbVariant.stockObservation);assert.equal(next.stock,40);
 next.wbVariant.chrtId=2;preserveWbValidation({products:[old]},{products:[next]});assert.equal(next.wbVariant.stockObservation,undefined);
});
test('background observation persistence changes metadata only, rejects relink races and omits missing WB amounts',async()=>{
 const rows=[product('1',44,undefined),product('2',32,undefined),product('3',5,undefined)];const state={products:rows,movements:[{id:'m',qty:-1}],purchases:[{id:'b',remainingQty:4}],reservations:[{qty:1}]};
 const before=structuredClone(state),items=rows.map(p=>({productId:p.id,chrtId:p.wbVariant.chrtId,fingerprint:linkFingerprint(p,'wb')}));rows[2].wb='relinked';
 let persisted=0;const queries=[];const client={query:async(sql,args)=>{queries.push({sql,args});return {rowCount:1,rows:[{payload:JSON.stringify(state)}]}}};
 const ctx={transaction:fn=>fn(client),hydrateWarehouseProducts:async(_c,s)=>s,persistWarehouseProducts:async(_c,products)=>{persisted++;state.products=products},warehousePayloadForStorage:s=>({...s,products:undefined}),linkFingerprint,Date};
 vm.createContext(ctx);vm.runInContext(backend.replace(/^import .*;\r?\n/gm,'').replace(/export /g,'')+'\nthis.persist=persistWbStockObservations;this.read=readStocks;',ctx);
 await ctx.persist('WB','wh',items,new Map([[1,0],[3,5]]),new Set([1]),Date.now());
 assert.equal(persisted,1);assert.equal(state.products[0].wbVariant.stockObservation.amount,0);assert.equal(state.products[0].wbVariant.stockObservation.pending,true);assert.equal(state.products[1].wbVariant.stockObservation,undefined);assert.equal(state.products[2].wbVariant.stockObservation,undefined);
 assert.deepEqual(structuredClone(state.products.map(p=>p.stock)),before.products.map(p=>p.stock));for(const k of ['movements','purchases','reservations'])assert.deepEqual(structuredClone(state[k]),before[k]);
 assert.ok(queries[0].sql.includes('pg_advisory_xact_lock'));assert.ok(queries[1].sql.includes('FOR UPDATE'));assert.ok(queries.some(x=>x.sql.includes('revision=revision+1')));
});
test('malformed/missing stock response is never a confirmed zero',async()=>{
 const ctx={setTimeout,clearTimeout,AbortController,fetch:async()=>({ok:true,text:async()=>JSON.stringify({stocks:[{chrtId:1,amount:0},{chrtId:2,amount:null},{chrtId:3},{chrtId:4,amount:'bad'},{chrtId:5,amount:7}]})})};vm.createContext(ctx);vm.runInContext(backend.replace(/^import .*;\r?\n/gm,'').replace(/export /g,'')+'\nthis.read=readStocks;',ctx);
 assert.deepEqual(structuredClone([...await ctx.read('test','wh',[1,2,3,4,5])]),[[1,0],[5,7]]);
});
