import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../../amantrans-v1.js',import.meta.url),'utf8');
function fixture(){
 const requests=[],calls={saved:0},fields=new Map(),view={ok:true,connected:true,accountId:'7',phoneHint:'•••0001',fetchedAt:1000,orders:[{id:'11',name:'Правильный',track:'DUPLICATE',amount:1,weight:0.13,priceUsd:3,totalKzt:201.2,statusLabel:'В филиале',fingerprint:'a'},{id:'12',name:'Ошибочный',track:'DUPLICATE',amount:100,weight:null,priceUsd:200,totalKzt:null,statusLabel:'Новый',fingerprint:'b'}]};let markup='';
 const field=id=>{if(!fields.has(id))fields.set(id,{value:'',textContent:'',focus(){},setSelectionRange(){}});return fields.get(id)};
 const ctx={Date,Number,String,Math,Set,Map,JSON,crypto:{randomUUID:()=> 'fixture-operation-0001'},
  state:{purchases:[{id:'p1',shipmentId:'main',productId:'main-product',qty:2,buyTotal:10000,delivery:500},{id:'inferno:p2',shipmentId:'inferno:child',productId:'inferno:product',qty:4,buyTotal:20000,delivery:1000}]},
  document:{getElementById:field,querySelectorAll:()=>[],querySelector:()=>null},MILLIONER_API:'https://warehouse.fixture',
  fetch:async(url,options)=>{requests.push({url,options});return Response.json(view)},
  showSheet:html=>markup=html,esc:x=>String(x??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;'),
  requireWarehouseEditReady:()=>true,save:()=>calls.saved++,renderPurchases(){},renderStoreSettings(){},startAppRuntime(){},
  productNameById:()=> 'Название закупки',alert:()=>{},confirm:()=>true,setTimeout,clearTimeout,setInterval:()=>1};
 ctx.purchaseShipmentRows=key=>ctx.state.purchases.filter(x=>(x.shipmentId||x.id)===decodeURIComponent(key));ctx.window=ctx;vm.createContext(ctx);vm.runInContext(source,ctx);
 return{ctx,view,requests,calls,field,get html(){return markup}};
}
test('opening carrier data is read-only and goes through the signed-in warehouse API',async()=>{
 const f=fixture();await f.ctx.openAmanTrans('main');assert.equal(f.calls.saved,0);assert.equal(f.requests.length,1);assert.equal(f.requests[0].url,'https://warehouse.fixture/api/amantrans/state');assert.equal(f.requests[0].options.method,'GET');
 assert.match(f.html,/Правильный/);assert.match(f.html,/Ошибочный/);assert.match(f.html,/Скрыть в складе/);assert.doesNotMatch(f.html,/Удалить в Aman/);
});
test('linking an exact duplicate ID changes metadata only in the selected warehouse shipment',async()=>{
 const f=fixture(),before=structuredClone(f.ctx.state.purchases);await f.ctx.openAmanTrans('main');f.ctx.amanLink('12');
 assert.equal(f.calls.saved,1);assert.equal(f.ctx.state.purchases[0].amantransOrderId,'12');assert.equal(f.ctx.state.purchases[0].amantransAccountId,'7');
 assert.deepEqual(f.ctx.state.purchases[1],before[1]);for(const key of ['qty','buyTotal','delivery','productId'])assert.equal(f.ctx.state.purchases[0][key],before[0][key]);
 f.ctx.amanUnlink();assert.deepEqual(f.ctx.state.purchases,before);
});
test('an Inferno purchase keeps its virtual warehouse ID and cannot link its neighbour',async()=>{
 const f=fixture();await f.ctx.openAmanTrans('inferno%3Achild');f.ctx.amanLink('11');assert.equal(f.ctx.state.purchases[1].amantransOrderId,'11');assert.equal(f.ctx.state.purchases[1].id,'inferno:p2');assert.equal(f.ctx.state.purchases[0].amantransOrderId,undefined);
});
test('carrier statuses and costs are displayed only for the connected account',async()=>{
 const f=fixture();await f.ctx.openAmanTrans('main');const row=f.ctx.state.purchases[0];row.amantransOrderId='11';row.amantransAccountId='7';assert.match(f.ctx.amanShipmentHtml('main',[row]),/201,2/);
 row.amantransAccountId='other';const html=f.ctx.amanShipmentHtml('main',[row]);assert.match(html,/Связь требует проверки/);assert.doesNotMatch(html,/201,2/);
});
test('new registration never treats a tenge purchase total as a dollar declaration',async()=>{
 const f=fixture();await f.ctx.openAmanTrans('main');f.ctx.amanEditOrder();assert.match(f.html,/id="amanPrice"[^>]*value=""/);assert.match(f.html,/Отправить в Aman Trans/);assert.equal(f.requests.length,1);
 assert.doesNotMatch(f.html,/>10000|value="10000"/);
});
test('the carrier module is static before auth and skipped on the legacy Inferno page',()=>{
 const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8'),server=readFileSync(new URL('../src/server.js',import.meta.url),'utf8');
 assert.ok(html.indexOf('amantrans-v1.js')<html.indexOf('<script>initOwnerAuth();'));
 assert.match(source,/WAREHOUSE_SCOPE_CONFIG\?\.inferno/);assert.match(server,/'amantrans-v1.js'/);
 assert.doesNotMatch(source,/localStorage|sessionStorage|api\.amantrans/);
});

test('only an explicit paid transition registers the first visible name, total quantity, same numeric price and dedicated track',async()=>{
 const f=fixture(),row=f.ctx.state.purchases[0],other={...row,id:'p3',productId:'second',qty:3,buyTotal:7500};f.ctx.state.purchases.push(other);
 f.ctx.purchaseWorkflowStage=x=>x.workflowStageId;f.ctx.productNameById=id=>id==='second'?'А первый товар':'Я второй товар';row.workflowStageId=other.workflowStageId='paid';
 f.ctx.amanPreparePurchase([row,other],'cart','NEW-TRACK');assert.ok(row.amantransAutoRequestedAt);assert.equal(f.requests.length,0);
 f.view.createdOrderId='11';await f.ctx.amanSubmitPurchase('main');
 const sent=f.requests.filter(x=>x.options.method==='POST');assert.equal(sent.length,1);assert.equal(sent[0].url,'https://warehouse.fixture/api/amantrans/purchases/register');
 const body=JSON.parse(sent[0].options.body);assert.equal(body.purchaseKey,'main');assert.equal(body.fields.name,'А первый товар');assert.equal(body.fields.amount,5);assert.equal(body.fields.priceUsd,17500);assert.equal(body.fields.track,'NEW-TRACK');
 assert.equal(row.amantransOrderId,'11');assert.equal(other.amantransOrderId,'11');assert.equal(f.ctx.state.purchases[1].amantransOrderId,undefined);assert.equal(row.buyTotal,10000);assert.equal(row.delivery,500);
 await f.ctx.amanSubmitPurchase('main');assert.equal(f.requests.filter(x=>x.options.method==='POST').length,1);
 assert.match(f.ctx.amanShipmentHtml('main',[row,other]),/В филиале/);
});
test('opening old paid purchases does not send anything and a missing track stays visible until supplied',async()=>{
 const f=fixture(),row=f.ctx.state.purchases[0];f.ctx.purchaseWorkflowStage=x=>x.workflowStageId;row.workflowStageId='paid';
 f.ctx.amanPreparePurchase([row],'paid');await f.ctx.amanSubmitPurchase('main');assert.equal(f.requests.length,0);assert.equal(row.amantransAutoRequestedAt,undefined);
 f.ctx.amanPreparePurchase([row],'cart');await f.ctx.amanSubmitPurchase('main');assert.equal(f.requests.length,0);assert.match(f.ctx.amanShipmentHtml('main',[row]),/Укажи трек/);
 f.ctx.amanPreparePurchase([row],'paid','NEW-TRACK');f.view.createdOrderId='11';await f.ctx.amanSubmitPurchase('main');assert.equal(f.requests.length,1);
});
test('an Inferno payment uses its own stable purchase key and never merges quantities with the main warehouse',async()=>{
 const f=fixture(),row=f.ctx.state.purchases[1];f.ctx.purchaseWorkflowStage=x=>x.workflowStageId;row.workflowStageId='paid';f.ctx.amanPreparePurchase([row],'cart','WB3-TRACK');f.view.createdOrderId='11';await f.ctx.amanSubmitPurchase('inferno%3Achild');
 const body=JSON.parse(f.requests[0].options.body);assert.equal(body.purchaseKey,'inferno:child');assert.equal(body.fields.amount,4);assert.equal(body.fields.priceUsd,20000);assert.equal(f.ctx.state.purchases[0].amantransOrderId,undefined);
});

test('the real quick stage action dispatches a paid intent and never dispatches old purchases on render',async()=>{
 const f=fixture(),row=f.ctx.state.purchases[0],html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');row.workflowStageId='cart';row.status='to_forwarder';row.batch='NEW-TRACK';
 f.ctx.purchaseWorkflowStage=x=>x.workflowStageId;f.ctx.purchaseStatus=x=>x.status;f.ctx.purchaseWorkflow=()=>[{id:'cart'},{id:'paid'},{id:'delivery_warehouse'},{id:'arrived'}];f.ctx.purchaseWorkflowPhase=()=> 'to_forwarder';f.view.createdOrderId='11';
 vm.runInContext(html.split('\n').find(line=>line.startsWith('function quickSetPurchaseWorkflowStage(')),f.ctx);
 f.ctx.quickSetPurchaseWorkflowStage('main','paid');await new Promise(setImmediate);assert.equal(row.workflowStageId,'paid');assert.equal(row.amantransOrderId,'11');assert.equal(f.requests.filter(x=>x.options.method==='POST').length,1);
 f.ctx.renderPurchases();await new Promise(setImmediate);assert.equal(f.requests.filter(x=>x.options.method==='POST').length,1);
});
