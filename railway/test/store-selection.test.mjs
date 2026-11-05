import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const code=readFileSync(new URL('../../store-selection-v1.js',import.meta.url),'utf8');
const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
function fixture(saved=new Map()){
 const elements=new Map(),requests=[],calls={renders:0};
 const element={innerHTML:'',classList:{add(){},toggle(){}},setAttribute(){}};elements.set('orderStoreSelection',{...element});
 const ctx={URL,URLSearchParams,Response,AbortController,Date,Number,String,Math,Map,Set,JSON,
  WAREHOUSE_SCOPE_CONFIG:{enabled:true},warehouseScope:{enabled:true},WB3_ONLY:false,
  location:{href:'https://warehouse.test/',origin:'https://warehouse.test',pathname:'/',search:'',assign(){throw Error('must not navigate');}},
  localStorage:{getItem:k=>saved.get(k)||null,setItem:(k,v)=>saved.set(k,v)},sessionStorage:{getItem:()=>null},APP_FRESH_LOGIN_KEY:'fresh',
  document:{getElementById:id=>elements.get(id)||null,querySelectorAll:()=>[]},
  state:{products:[{id:'main',wb:'MAIN',stock:6},{id:'inferno:child',wb3:'CHILD',stock:6,wbVariant:{nmId:'123',chrtId:456}}],settings:{},purchases:[],movements:[],wbOrderFeed:[]},
  MILLIONER_API:'https://warehouse.test',selectedOrderMarket:'all',selectedWbAccount:'all',orderPage:1,productPage:1,productFboOnly:false,
  fetch:async(url,options)=>{requests.push({url,options});return Response.json({ok:true,fetchedAt:1,sizes:{'123:456':{quantity:12}},items:{}});},
  normalizeWarehouseSnapshot:s=>({...s}),renderMarketplaceOrders(){calls.renders++;},renderIntegrationStatus(){},renderProducts(){},renderPurchases(){},renderPurchasePlan(){},renderMovement(){},
  purchaseShipmentGroups:()=>[],purchaseRecommendations:()=>[],productForm:()=>'<h3>Добавить товар</h3>',validateProductMarketplaceSkus:()=>true,
  startAppRuntime(){},applyWarehouseSnapshot:s=>{ctx.state=s;},save(){throw Error('selection must not save warehouse');},
  prod:id=>ctx.state.products.find(p=>p.id===id),purchaseCoverDays:()=>25,reportPeriodStart:()=>1,reportPeriodEnd:()=>100,
  isBundleProduct:()=>false,marketplaceLifecycleStage:()=> 'new',stockProducts:()=>ctx.state.products,
  productAvailableStock:p=>p.stock-(p.reserved||0),purchaseInboundTimeline:id=>ctx.state.purchases.filter(p=>p.productId===id).map(row=>({row,qty:row.qty,status:row.status,days:1})),purchaseWorkflowStage:r=>r.workflowStageId,purchaseWarehouseQty:r=>r.qty,purchaseLastUnitCost:()=>100,
  alert:m=>{throw Error(m);},setTimeout,clearTimeout,setInterval:()=>1,
 };
 ctx.window=ctx;vm.createContext(ctx);vm.runInContext(code,ctx);
 return {ctx,elements,requests,calls,saved};
}
test('five independent store buttons toggle without a navigation, parent WB category or All button',()=>{
 const f=fixture(),ctx=f.ctx,buttons=f.elements.get('orderStoreSelection');
 assert.doesNotMatch(buttons.innerHTML,/>Все<|>WB</);for(const label of ['Kaspi','WB1','WB2','WB3','Ozon'])assert.ok(buttons.innerHTML.includes('>'+label+'</button>'));
 ctx.toggleStoreSelection('home','WB3');assert.equal(ctx.selectedStoreIds('home').length,5);
 ctx.toggleStoreSelection('home','WB');assert.deepEqual([...ctx.selectedStoreIds('home')],['Kaspi','WB2','Ozon','WB3']);
 assert.equal(ctx.selectedOrderMarket,'all');assert.equal(f.calls.renders,2);
 const reload=fixture(f.saved);assert.deepEqual([...reload.ctx.selectedStoreIds('home')],['Kaspi','WB2','Ozon','WB3']);
});
test('identical vendor codes in WB1 and WB3 never merge the product catalogs',()=>{
 const f=fixture();for(const m of ['Kaspi','WB','WB2','Ozon'])f.ctx.toggleStoreSelection('products',m);f.ctx.toggleStoreSelection('products','WB3');
 assert.equal(f.ctx.productMatchesSelectedStores(f.ctx.state.products[0],'products'),false);assert.equal(f.ctx.productMatchesSelectedStores(f.ctx.state.products[1],'products'),true);
});
test('the same main session is forwarded to the gateway and full-snapshot revisions stay composite',async()=>{
 const f=fixture(),headers={Authorization:'Bearer opaque-session'};
 await f.ctx.fetch('https://warehouse.test/api/warehouse-state',{method:'PUT',headers,body:JSON.stringify({baseRevision:100000002,state:{}})});
 assert.equal(f.requests[0].url,'https://warehouse.test/api/unified/warehouse-state');assert.equal(JSON.parse(f.requests[0].options.body).baseRevision,100000002);assert.equal(f.requests[0].options.headers.Authorization,headers.Authorization);
 await f.ctx.fetch('https://warehouse.test/api/market-prices?market=WB3',{method:'POST',body:JSON.stringify({market:'WB3',baseRevision:100000002})});
 assert.equal(JSON.parse(f.requests[1].options.body).baseRevision,2);assert.match(f.requests[1].url,/\/api\/unified\/market-prices/);
 await f.ctx.fetch('https://warehouse.test/api/fbo-warehouse/reserve',{method:'POST',body:JSON.stringify({warehouseRevision:100000002})});assert.equal(JSON.parse(f.requests[2].options.body).warehouseRevision,1);
});
test('a main-only response from a legacy editor retains Inferno instead of treating it as deleted',()=>{
 const f=fixture();f.ctx.state.settings={unifiedWarehouseVersion:1,infernoSettings:{name:'Inferno'}};
 f.ctx.applyWarehouseSnapshot({products:[{id:'new-main'}],settings:{name:'main'}});
 assert.deepEqual(Array.from(f.ctx.state.products,x=>x.id),['new-main','inferno:child']);assert.equal(f.ctx.state.settings.unifiedWarehouseVersion,1);
});
test('Inferno procurement uses its exact FBO size and subtracts own free stock and paid inbound',async()=>{
 const f=fixture();f.ctx.toggleStoreSelection('purchases','WB3');const p=f.ctx.prod('inferno:child');p.reserved=2;
 f.ctx.state.wbOrderFeed=[{market:'WB3',productId:p.id,qty:50,creationDate:50}];f.ctx.state.purchases=[{id:'inferno:p',productId:p.id,qty:10,status:'to_me',workflowStageId:'paid'}];
 f.ctx.startAppRuntime();await new Promise(resolve=>setTimeout(resolve,0));
 const [row]=f.ctx.purchaseRecommendations();assert.equal(row.qty,24);assert.equal(row.fbo,12);assert.equal(row.inbound,10);assert.equal(f.ctx.__lastPurchaseRecommendations[0].qty,24);
});
test('order totals never label an unknown or foreign WB3 currency as tenge',()=>{
 const context={String,Number,Math,marketplaceLifecycleStage:()=> 'new',isPendingMarketplaceLine:()=>false};
 const line=html.split('\n').find(l=>l.startsWith('function marketplaceOrderTotals('));vm.createContext(context);vm.runInContext(line,context);
 const result=context.marketplaceOrderTotals([{market:'WB3',lines:[{qty:1,totalPrice:300,currency:'RUB'}]}]);assert.equal(result.qty,1);assert.equal(result.amount,0);assert.equal(result.partial,true);assert.equal(result.amountKnown,false);
});

test('new Inferno record IDs are canonical on the wire without changing foreign product references',()=>{
 const f=fixture();f.ctx.state.purchases=[{id:'new-lot',productId:'inferno:child',shipmentId:'new-shipment',adjustmentMovementId:'new-move'}];f.ctx.state.movements=[{id:'new-move',productId:'inferno:child'}];
 const wire=f.ctx.normalizeWarehouseSnapshot(f.ctx.state);assert.equal(wire.purchases[0].id,'inferno:new-lot');assert.equal(wire.purchases[0].shipmentId,'inferno:new-shipment');assert.equal(wire.purchases[0].adjustmentMovementId,wire.movements[0].id);assert.equal(f.ctx.state.purchases[0].id,'new-lot');
 f.ctx.state.products[1].components=[{productId:'main',qty:1}];const invalid=f.ctx.normalizeWarehouseSnapshot(f.ctx.state);assert.equal(invalid.products[1].components[0].productId,'main');
});

test('product analytics include only selected store sources even for a shared product',()=>{
 const start=html.indexOf('function selectedProductPeriodStats('),end=html.indexOf('function currentProductPeriodStats(',start),ctx={Map,Set,Object,Number,globalThis:null,unifiedWarehouseEnabled:true,selectedStoreIds:()=>['WB3']};ctx.globalThis=ctx;vm.createContext(ctx);vm.runInContext(html.slice(start,end),ctx);
 const source=new Map([['shared',{qty:12,profit:600,unitProfit:50,sources:{Ozon:{qty:10,profit:500},WB3:{qty:2,profit:100}}}]]),row=ctx.selectedProductPeriodStats(source).get('shared');assert.equal(row.qty,2);assert.equal(row.profit,100);assert.equal(row.unitProfit,50);assert.deepEqual(Object.keys(row.sources),['WB3']);assert.equal(source.get('shared').qty,12);
});

test('turning off Ozon clears its hidden FBO-only filter before rendering another store',()=>{
 const f=fixture();f.ctx.productFboOnly=true;f.ctx.toggleStoreSelection('products','Ozon');assert.equal(f.ctx.productFboOnly,false);
});
