import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../../amantrans-v1.js',import.meta.url),'utf8');
function fixture(setup=()=>{}){
 const requests=[],calls={saved:0},fields=new Map(),view={ok:true,connected:true,accountId:'7',phoneHint:'•••0001',fetchedAt:1000,orders:[{id:'11',name:'Правильный',track:'DUPLICATE',amount:1,weight:0.13,priceUsd:3,totalKzt:201.2,statusLabel:'В филиале',fingerprint:'a'},{id:'12',name:'Ошибочный',track:'DUPLICATE',amount:100,weight:null,priceUsd:200,totalKzt:null,statusLabel:'Новый',fingerprint:'b'}]};let markup='';
 const field=id=>{if(!fields.has(id))fields.set(id,{value:'',textContent:'',focus(){},setSelectionRange(){}});return fields.get(id)};
 const ctx={Date,Number,String,Math,Set,Map,JSON,crypto:{randomUUID:()=> 'fixture-operation-0001'},
  state:{purchases:[{id:'p1',shipmentId:'main',productId:'main-product',qty:2,buyTotal:10000,delivery:500},{id:'inferno:p2',shipmentId:'inferno:child',productId:'inferno:product',qty:4,buyTotal:20000,delivery:1000}]},
  document:{getElementById:field,querySelectorAll:()=>[],querySelector:()=>null},MILLIONER_API:'https://warehouse.fixture',
  fetch:async(url,options)=>{requests.push({url,options});return Response.json(view)},
  showSheet:html=>markup=html,esc:x=>String(x??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;'),
  requireWarehouseEditReady:()=>true,save:()=>calls.saved++,renderPurchases(){},renderStoreSettings(){},startAppRuntime(){},
  productNameById:()=> 'Название закупки',alert:()=>{},confirm:()=>true,setTimeout,clearTimeout,setInterval:()=>1};
 ctx.purchaseShipmentRows=key=>ctx.state.purchases.filter(x=>(x.shipmentId||x.id)===decodeURIComponent(key));ctx.window=ctx;setup(ctx,field);vm.createContext(ctx);vm.runInContext(source,ctx);
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
test('old purchases are not sent by opening; a new payment without a track gets its own temporary warehouse code',async()=>{
 const f=fixture(),row=f.ctx.state.purchases[0];f.ctx.purchaseWorkflowStage=x=>x.workflowStageId;row.workflowStageId='paid';
 f.ctx.amanPreparePurchase([row],'paid');await f.ctx.amanSubmitPurchase('main');assert.equal(f.requests.length,0);assert.equal(row.amantransAutoRequestedAt,undefined);
 row.batch='Китай 11.11.2026';
 f.ctx.amanPreparePurchase([row],'cart');assert.equal(row.batch,'Китай 11.11.2026');assert.equal(row.amantransTrack,'TMP-main');
 assert.match(f.ctx.amanPurchaseTrackHtml([row]),/Временный трек · TMP-main/);
 f.view.createdOrderId='11';await f.ctx.amanSubmitPurchase('main');assert.equal(f.requests.length,1);assert.equal(JSON.parse(f.requests[0].options.body).fields.track,row.amantransTrack);
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

const stageWorkflow=()=>[{id:'cart',name:'Корзина',days:0},{id:'paid',name:'Оплачено',days:0,amantransStatus:'NEW'},{id:'departed',name:'У продавца',days:5},{id:'delivery_warehouse',name:'Мой Китай',days:20,amantransStatus:'CHINA'},{id:'my_border',name:'Таможня',days:2,amantransStatus:'ON_BORDER'},{id:'my_branch',name:'Можно забирать',days:0,amantransStatus:'SUB_FILIAL'},{id:'arrived',name:'Получил',days:0}];
function stagedFixture(){
 const f=fixture(),workflow=stageWorkflow();f.workflow=workflow;f.ctx.state.settings={purchaseWorkflow:workflow};f.ctx.warehouseEditReady=()=>true;f.ctx.purchaseWorkflow=()=>f.ctx.state.settings.purchaseWorkflow;
 f.ctx.purchaseWorkflowStage=x=>x.workflowStageId;f.ctx.purchaseStatus=x=>x.status;f.ctx.purchaseWorkflowPhase=id=>{const i=f.ctx.purchaseWorkflow().findIndex(x=>x.id===id);return i>=f.ctx.purchaseWorkflow().findIndex(x=>x.id==='arrived')?'at_warehouse':i>=f.ctx.purchaseWorkflow().findIndex(x=>x.id==='delivery_warehouse')?'to_me':'to_forwarder'};
 Object.assign(f.ctx.state.purchases[0],{workflowStageId:'paid',workflowStageAt:50,status:'to_forwarder',amantransOrderId:'11',amantransAccountId:'7',remainingQty:0});f.view.fetchedAt=Date.now();f.view.orders[0].status='CHINA';return f;
}
test('a saved stage binding advances the exact linked shipment and its filters without touching inventory, prices or carrier orders',async()=>{
 const f=stagedFixture(),row=f.ctx.state.purchases[0],other=structuredClone(f.ctx.state.purchases[1]);await f.ctx.openAmanTrans('main');
 assert.equal(row.workflowStageId,'delivery_warehouse');assert.equal(row.status,'to_me');assert.equal(row.workflowStageAt,f.view.fetchedAt);assert.equal(row.forwarderReceivedAt,undefined,'snapshot observation is not invented as the historical China arrival date');assert.equal(row.buyTotal,10000);assert.equal(row.delivery,500);assert.equal(row.qty,2);assert.equal(row.remainingQty,0);assert.deepEqual(f.ctx.state.purchases[1],other);assert.equal(f.calls.saved,1);
 f.ctx.amanApplyPurchaseStages();assert.equal(f.calls.saved,1,'same stage does not write again');
 f.view.orders[0].status='ON_BORDER';f.view.orders[0].statusLabel='На границе';await f.ctx.amanRefresh({});assert.equal(row.workflowStageId,'my_border');assert.equal(f.ctx.purchaseWorkflowStage(row),'my_border');assert.equal(f.calls.saved,2);
 f.view.orders[0].status='SUB_FILIAL';f.view.orders[0].statusLabel='В филиале';await f.ctx.amanRefresh({});assert.equal(row.workflowStageId,'my_branch');assert.equal(row.status,'to_me');assert.equal(row.receivedAt,undefined);assert.equal(row.warehouseReceivedAt,undefined);assert.equal(f.requests.filter(x=>x.url.includes('/purchases/register')||x.url.includes('/orders/')).length,0);
});
test('stage sync skips stale, disconnected, failed and read-only snapshots and never mixes accounts',async()=>{
 for(const scenario of ['stale','disconnected','failed','readonly','other-account','unmapped']){
  const f=stagedFixture(),row=f.ctx.state.purchases[0];
  if(scenario==='stale')f.view.fetchedAt=Date.now()-11*60000;if(scenario==='disconnected')f.view.connected=false;if(scenario==='failed')f.view.lastError='offline';if(scenario==='readonly')f.ctx.warehouseEditReady=()=>false;if(scenario==='other-account')row.amantransAccountId='8';if(scenario==='unmapped')f.view.orders[0].status='UNKNOWN';
  await f.ctx.openAmanTrans('main');assert.equal(row.workflowStageId,'paid',scenario);assert.equal(f.calls.saved,0,scenario);
 }
});
test('carrier mapping cannot regress seller departure, advance an unpaid cart, conduct receipt or alter received lots',async()=>{
 for(const scenario of ['new-after-departure','earlier-carrier','cart','received','at_warehouse','receipt-mapping','duplicate-mapping']){
  const f=stagedFixture(),row=f.ctx.state.purchases[0];
  if(scenario==='new-after-departure'){row.workflowStageId='departed';f.view.orders[0].status='NEW';}
  if(scenario==='earlier-carrier')row.workflowStageId='my_border';if(scenario==='cart')row.workflowStageId='cart';if(scenario==='received'||scenario==='at_warehouse')row.status=scenario;
  if(scenario==='receipt-mapping'){delete f.workflow[3].amantransStatus;f.workflow.at(-1).amantransStatus='CHINA';}
  if(scenario==='duplicate-mapping')f.workflow[4].amantransStatus='CHINA';
  const before=JSON.stringify(row);await f.ctx.openAmanTrans('main');assert.equal(JSON.stringify(row),before,scenario);assert.equal(f.calls.saved,0,scenario);
 }
});
test('bindings are configurable in the actual stage editor and survive sanitize, rename, reorder and save',()=>{
 const f=stagedFixture(),html=readFileSync(new URL('../../index.html',import.meta.url),'utf8'),fn=name=>html.split('\n').find(line=>line.startsWith('function '+name+'('));
 f.ctx.closeModal=()=>{};f.ctx.render=()=>{};f.ctx.purchaseWorkflowDraft=stageWorkflow();f.ctx.DEFAULT_PURCHASE_WORKFLOW=stageWorkflow();
 const inputs=new Map();f.ctx.document.querySelector=selector=>inputs.get(selector)||null;
 vm.runInContext([fn('purchaseWorkflow'),fn('readPurchaseWorkflowDraft'),fn('savePurchaseWorkflow'),fn('renderPurchaseWorkflowEditor')].join('\n'),f.ctx);
 f.ctx.purchaseWorkflowDraft.splice(5,0,{id:'my_road',name:'Моя дорога',days:1});inputs.set('[data-workflow-aman="5"]',{value:'ON_ROAD_CHINA'});inputs.set('[data-workflow-name="5"]',{value:'Едет из Китая'});
 f.ctx.savePurchaseWorkflow();assert.equal(f.calls.saved,1);assert.equal(f.ctx.purchaseWorkflow().find(x=>x.id==='my_road').amantransStatus,'ON_ROAD_CHINA');assert.equal(f.ctx.purchaseWorkflow().find(x=>x.id==='my_road').name,'Едет из Китая');
 f.ctx.renderPurchaseWorkflowEditor();assert.match(f.html,/data-workflow-aman="5"/);assert.match(f.html,/value="ON_ROAD_CHINA" selected/);assert.match(f.html,/Статус Aman Trans/);
 inputs.set('[data-workflow-aman="5"]',{value:''});f.ctx.savePurchaseWorkflow();assert.equal(f.ctx.purchaseWorkflow().find(x=>x.id==='my_road').amantransStatus,undefined);
 const invalid=stageWorkflow();invalid[4].amantransStatus='CHINA';assert.throws(()=>f.ctx.amanValidateWorkflowBindings(invalid),/только к одному/);invalid[4].amantransStatus='ON_BORDER';invalid.at(-1).amantransStatus='SUB_FILIAL';assert.throws(()=>f.ctx.amanValidateWorkflowBindings(invalid),/вручную/);
});
test('a custom payment stage bound to New keeps the automatic carrier registration trigger',()=>{
 const f=stagedFixture(),row=f.ctx.state.purchases[1];f.workflow[1].id='my_payment';row.workflowStageId='my_payment';f.ctx.amanPreparePurchase([row],'cart','WB3-NEW');assert.ok(row.amantransAutoRequestedAt);assert.equal(f.requests.length,0);
});

test('editing the separate purchase track updates the linked record without changing the title',async()=>{
 const f=fixture(),row=f.ctx.state.purchases[0],html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');let n=0;f.ctx.crypto.randomUUID=()=> 'track-operation-fixture-'+(++n);row.batch='TEMP-ORDER';row.workflowStageId='paid';f.ctx.purchaseWorkflowStage=x=>x.workflowStageId;
 f.ctx.amanPreparePurchase([row],'cart');f.view.createdOrderId='11';await f.ctx.amanSubmitPurchase('main');assert.equal(row.amantransSyncedTrack,'TEMP-ORDER');
 f.ctx.purchaseEditStagePlan=()=>null;f.ctx.applyPurchaseEditStage=()=>{};f.ctx.closeModal=()=>{};f.field('amanPurchaseTrackInput').value='REAL-TRACK';
 vm.runInContext(html.split('\n').find(line=>line.startsWith('function saveQuickPurchaseBatch(')),f.ctx);f.ctx.saveQuickPurchaseBatch('main');await new Promise(setImmediate);
 assert.equal(f.requests.filter(x=>x.url.endsWith('/purchases/register')).length,2);const body=JSON.parse(f.requests.at(-1).options.body);assert.equal(body.orderId,'11');assert.equal(body.accountId,'7');assert.equal(body.previousTrack,'TEMP-ORDER');assert.equal(body.fields.track,'REAL-TRACK');assert.equal(row.amantransOrderId,'11');assert.equal(row.amantransSyncedTrack,'REAL-TRACK');assert.equal(row.buyTotal,10000);assert.equal(row.qty,2);
 assert.equal(row.batch,'TEMP-ORDER');assert.match(f.ctx.amanPurchaseTrackField([row]),/value="REAL-TRACK"/);assert.match(f.ctx.amanShipmentHtml('main',[row]),/В филиале/);assert.doesNotMatch(f.ctx.amanShipmentHtml('main',[row]),/<button|Привязать отправление/);
 f.ctx.saveQuickPurchaseBatch('main');await new Promise(setImmediate);assert.equal(f.requests.filter(x=>x.url.endsWith('/purchases/register')).length,2);
});
test('server purchase identity restores a lost local link without track guessing or manual actions',async()=>{
 const f=fixture(),row=f.ctx.state.purchases[0];row.batch='TEMP-ORDER';row.amantransAutoRequestedAt=100;f.ctx.warehouseEditReady=()=>true;f.view.purchaseLinks={main:{id:'12',track:'TEMP-ORDER'},'inferno:child':{id:'11',track:'OTHER'}};
 await f.ctx.openAmanTrans('main');assert.equal(row.amantransOrderId,'12');assert.equal(row.amantransSyncedTrack,'TEMP-ORDER');assert.equal(row.amantransAccountId,'7');assert.equal(f.ctx.state.purchases[1].amantransOrderId,undefined);assert.equal(f.requests.length,1);assert.equal(f.requests[0].options.method,'GET');
});
test('a track edited while creation is in flight is sent to the newly created ID after the first response',async()=>{
 const f=fixture(),row=f.ctx.state.purchases[0];row.batch='TEMP-ORDER';row.workflowStageId='paid';f.ctx.purchaseWorkflowStage=x=>x.workflowStageId;f.ctx.amanPreparePurchase([row],'cart');f.view.createdOrderId='11';
 let release;const gate=new Promise(resolve=>release=resolve),original=f.ctx.fetch;let first=true;f.ctx.fetch=async(...args)=>{if(first){first=false;await gate;}return original(...args);};
 const creation=f.ctx.amanSubmitPurchase('main');f.ctx.amanPreparePurchase([row],'paid','REAL-EARLY','TEMP-ORDER');await f.ctx.amanSubmitPurchase('main');release();await creation;await new Promise(setImmediate);
 assert.equal(f.requests.length,2);const bodies=f.requests.map(x=>JSON.parse(x.options.body));assert.equal(bodies[0].fields.track,'TEMP-ORDER');assert.equal(bodies[1].orderId,'11');assert.equal(bodies[1].fields.track,'REAL-EARLY');assert.equal(row.amantransSyncedTrack,'REAL-EARLY');
});


test('legacy paid shipment recovers its unique exact track and mapped stage with no carrier writes',async()=>{
 const f=stagedFixture(),row=f.ctx.state.purchases[0],before=structuredClone(row);
 delete row.amantransOrderId;delete row.amantransAccountId;row.batch='EXACT-LEGACY';
 f.view.orders[0].track=row.batch;f.view.orders[0].status='ON_BORDER';
 await f.ctx.openAmanTrans('main');
 assert.equal(row.amantransOrderId,'11');assert.equal(row.amantransAccountId,'7');assert.equal(row.amantransSyncedTrack,row.batch);
 assert.equal(row.workflowStageId,'my_border');assert.equal(row.status,'to_me');
 for(const key of ['qty','buyTotal','delivery','remainingQty'])assert.equal(row[key],before[key]);
 assert.equal(f.requests.length,1);assert.equal(f.requests[0].options.method,'GET');
 const writes=f.calls.saved;f.ctx.renderPurchases();assert.equal(f.calls.saved,writes,'repeat render is idempotent');
});
test('legacy recovery rejects ambiguous tracks, stale data, other accounts, unpaid and received purchases',async()=>{
 for(const scenario of ['carrier-duplicate','purchase-duplicate','stale','failed','readonly','other-account','cart','received','pending-create','pending-track','partial-link']){
  const f=stagedFixture(),row=f.ctx.state.purchases[0];delete row.amantransOrderId;delete row.amantransAccountId;row.batch='EXACT-LEGACY';f.view.orders[0].track=row.batch;
  if(scenario==='carrier-duplicate')f.view.orders[1].track=row.batch;
  if(scenario==='purchase-duplicate')f.ctx.state.purchases[1].batch=row.batch;
  if(scenario==='stale')f.view.fetchedAt=Date.now()-11*60000;
  if(scenario==='failed')f.view.lastError='offline';
  if(scenario==='readonly')f.ctx.warehouseEditReady=()=>false;
  if(scenario==='other-account')row.amantransAccountId='8';
  if(scenario==='cart')row.workflowStageId='cart';
  if(scenario==='received')row.status='received';
  if(scenario==='pending-create')row.amantransAutoRequestedAt=123;
  if(scenario==='pending-track')row.amantransPendingTrack='OTHER';
  if(scenario==='partial-link')f.ctx.state.purchases.push({...row,id:'p3',amantransOrderId:'11',amantransAccountId:'7'});
  const before=JSON.stringify(f.ctx.state.purchases);await f.ctx.openAmanTrans('main');
  assert.equal(JSON.stringify(f.ctx.state.purchases),before,scenario);assert.equal(f.calls.saved,0,scenario);assert.equal(f.requests.length,1,scenario);
 }
});
test('legacy recovery waits for warehouse hydration even when carrier snapshot arrived earlier',async()=>{
 const f=stagedFixture(),row=f.ctx.state.purchases[0];delete row.amantransOrderId;delete row.amantransAccountId;row.batch='LATE-HYDRATE';f.view.orders[0].track=row.batch;f.ctx.warehouseEditReady=()=>false;
 await f.ctx.openAmanTrans('main');assert.equal(row.amantransOrderId,undefined);
 f.ctx.warehouseEditReady=()=>true;f.ctx.renderPurchases();assert.equal(row.amantransOrderId,'11');assert.equal(row.workflowStageId,'delivery_warehouse');assert.equal(f.requests.length,1);
});


function deliveryFixture(){
 const f=stagedFixture(),row=f.ctx.state.purchases[0];row.delivery=0;row.batch='YT7651969553711';f.view.orders[0].track=row.batch;
 f.view.orders[0].totalKzt=(1.156+18.496)*454.7;return f;
}
test('carrier delivery plus box and exchange rate fill the linked paid purchase without changing goods, stock or FIFO',async()=>{
 const f=deliveryFixture(),row=f.ctx.state.purchases[0];row.qty=10;row.buyTotal=12842;const other=structuredClone(f.ctx.state.purchases[1]);
 await f.ctx.openAmanTrans('main');
 assert.equal(row.delivery,8935.76);assert.equal(row.shipmentDeliveryTotal,8935.76);assert.equal(row.amantransDeliveryTotal,8935.76);
 assert.equal(row.buyTotal,12842);assert.equal(row.qty,10);assert.equal(row.remainingQty,0);assert.equal(row.receivedAt,undefined);assert.deepEqual(f.ctx.state.purchases[1],other);
 assert.equal(f.requests.length,1);assert.equal(f.requests[0].options.method,'GET');
 const writes=f.calls.saved;f.ctx.renderPurchases();assert.equal(f.calls.saved,writes,'repeat render does not import twice');
 f.view.orders[0].totalKzt=9000.25;await f.ctx.amanRefresh({});assert.equal(row.delivery,9000.25,'unchanged automatic amount follows updated carrier amount');
 row.delivery=9500;f.view.orders[0].totalKzt=9100;await f.ctx.amanRefresh({});assert.equal(row.delivery,9500,'manual correction is preserved');
});
test('carrier costs allocate once across all purchase lines, preserving cents even with tiny totals',async()=>{
 for(const zeroBuy of [false,true]){
  const f=deliveryFixture(),row=f.ctx.state.purchases[0];row.buyTotal=zeroBuy?0:100;row.qty=1;
  const b={...row,id:'p3',productId:'b',buyTotal:zeroBuy?0:200,qty:2};f.ctx.state.purchases.push(b);f.view.orders[0].totalKzt=100.01;
  await f.ctx.openAmanTrans('main');assert.equal(row.delivery,33.34);assert.equal(b.delivery,66.67);assert.equal(row.shipmentDeliveryTotal,100.01);assert.equal(b.shipmentDeliveryTotal,100.01);
 }
 const f=deliveryFixture(),row=f.ctx.state.purchases[0];row.qty=1;row.buyTotal=1;f.ctx.state.purchases.push({...row,id:'p3'},{...row,id:'p4'});f.view.orders[0].totalKzt=0.02;await f.ctx.openAmanTrans('main');
 const shares=f.ctx.state.purchases.filter(x=>x.shipmentId==='main').map(x=>x.delivery);assert.equal(Math.round(shares.reduce((a,b)=>a+b,0)*100),2);assert.ok(shares.every(x=>x>=0));
});
test('delivery import skips manual amounts, stale or missing prices, different tracking, duplicate links and locked lots',async()=>{
 for(const scenario of ['manual','stale','failed','readonly','null','zero','nan','wrong-track','other-account','cart','at_warehouse','received','duplicate-link','manual-zero-after-import']){
  const f=deliveryFixture(),row=f.ctx.state.purchases[0];
  if(scenario==='manual')row.delivery=200;
  if(scenario==='stale')f.view.fetchedAt=Date.now()-11*60000;
  if(scenario==='failed')f.view.lastError='offline';
  if(scenario==='readonly')f.ctx.warehouseEditReady=()=>false;
  if(scenario==='null')f.view.orders[0].totalKzt=null;
  if(scenario==='zero')f.view.orders[0].totalKzt=0;
  if(scenario==='nan')f.view.orders[0].totalKzt='bad';
  if(scenario==='wrong-track')f.view.orders[0].track='PREVIOUS-TRACK';
  if(scenario==='other-account')row.amantransAccountId='8';
  if(scenario==='cart')row.workflowStageId='cart';
  if(['at_warehouse','received'].includes(scenario))row.status=scenario;
  if(scenario==='duplicate-link')f.ctx.state.purchases.push({...row,id:'p3',shipmentId:'different'});
  if(scenario==='manual-zero-after-import')row.amantransDeliveryTotal=500;
  const before=row.delivery;await f.ctx.openAmanTrans('main');assert.equal(row.delivery,before,scenario);assert.equal(row.amantransDeliveryObservedAt,undefined,scenario);
 }
});
test('a late carrier response fills an untouched open editor but preserves typing',async()=>{
 for(const dirty of [false,true]){
  let listener,calcs=0;
  const f=fixture((ctx,field)=>{ctx.openEditPurchaseShipment=()=>{Object.assign(field('editPorDelivery'),{value:'0',dataset:{},addEventListener:(_name,fn)=>listener=fn});field('editPurchaseItems').dataset={shipmentKey:'main'};};ctx.updateEditPurchaseCalculator=()=>calcs++;});
  const row=f.ctx.state.purchases[0];Object.assign(row,{workflowStageId:'paid',status:'to_forwarder',batch:'EXACT',delivery:0,amantransOrderId:'11',amantransAccountId:'7'});
  f.ctx.warehouseEditReady=()=>true;f.ctx.purchaseWorkflow=stageWorkflow;f.ctx.purchaseWorkflowStage=x=>x.workflowStageId;f.ctx.purchaseStatus=x=>x.status;f.ctx.purchaseWorkflowPhase=()=> 'to_forwarder';
  f.view.fetchedAt=Date.now();f.view.orders[0].track='EXACT';f.view.orders[0].totalKzt=123.45;
  let release;f.ctx.fetch=async()=>{await new Promise(resolve=>release=resolve);return Response.json(f.view)};
  f.ctx.openEditPurchaseShipment('main');if(dirty){f.field('editPorDelivery').value='777';listener();}
  release();await new Promise(setImmediate);
  assert.equal(f.field('editPorDelivery').value,dirty?'777':'123.45');assert.equal(calcs,dirty?0:1);
 }
});

test('an existing automatic TMP title displays the original order date and retains its exact track',()=>{
 const f=fixture(),row=f.ctx.state.purchases[0];
 row.batch='TMP-main';row.orderedAt=Date.parse('2026-11-10T21:00:00Z');
 assert.equal(f.ctx.amanPurchaseTitle(row),'Китай 11.11.2026');
 assert.equal(f.ctx.amanPurchaseTrack([row]),'TMP-main');
 assert.match(f.ctx.amanPurchaseTrackHtml([row]),/Временный трек · TMP-main/);
 assert.equal(row.batch,'TMP-main');
});
