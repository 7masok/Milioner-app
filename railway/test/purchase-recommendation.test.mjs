import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
const sourceLines=html.split('\n');
const constants=sourceLines.find(line=>line.startsWith('const MIN_PURCHASE_COVER_DAYS='));
const coverFunction=sourceLines.find(line=>line.startsWith('function purchaseCoverDays()'));
const batchFunction=sourceLines.find(line=>line.startsWith('function fullPurchaseBatchQty('));
const costFunction=sourceLines.find(line=>line.startsWith('function purchasePlanCostSummary('));
const lightweightOptionsFunction=sourceLines.find(line=>line.startsWith('function lightweightPurchaseOptions('));

test('purchase planning period never drops below 25 days',()=>{
  for(const [saved,expected] of [[undefined,25],[10,25],[25,25],[40,40],[999,180]]){
    const context={state:{settings:{purchaseCoverDays:saved}}};
    vm.runInNewContext(`${constants}\n${coverFunction}\nresult=purchaseCoverDays()`,context);
    assert.equal(context.result,expected);
  }
});

test('recommends a full 25-day batch when stock coverage is below 25 days',()=>{
  const context={};
  vm.runInNewContext(`${constants}\nfunction purchaseCoverDays(){return 25}\n${batchFunction}`,context);
  assert.equal(context.fullPurchaseBatchQty(2,48,0,25),50);
  assert.equal(context.fullPurchaseBatchQty(2,0,49,25),50);
  assert.equal(context.fullPurchaseBatchQty(2,50,0,25),0);
  assert.equal(context.fullPurchaseBatchQty(2,48,50,25),0);
  assert.equal(context.fullPurchaseBatchQty(0,0,0,25),1);
});

test('purchase plan cost includes only positions with a known purchase price',()=>{
  const context={};
  vm.runInNewContext(`${costFunction}\nresult=purchasePlanCostSummary([{unitCost:100,estimatedCost:500},{unitCost:0,estimatedCost:0},{unitCost:200,estimatedCost:600}])`,context);
  assert.equal(context.result.total,1100);
  assert.equal(context.result.missing,1);
});

test('bulk purchase rows initially render only their selected product option',()=>{
  const context={
    prod:id=>id==='p1'?{id:'p1',name:'Товар 1'}:null,
    isBundleProduct:()=>false,
    esc:value=>String(value),
  };
  vm.runInNewContext(`${lightweightOptionsFunction}\nselected=lightweightPurchaseOptions('p1');empty=lightweightPurchaseOptions('')`,context);
  assert.equal((context.selected.match(/<option/g)||[]).length,1);
  assert.match(context.selected,/Товар 1/);
  assert.equal((context.empty.match(/<option/g)||[]).length,1);
  assert.match(context.empty,/Начните вводить название/);
});

test('purchase plan reuses calculated rows and collapses without a full redraw',()=>{
  assert.match(html,/rows=Array\.isArray\(cached\)\?cached:purchaseRecommendations\(\)/);
  assert.match(html,/body\.hidden=!expanded/);
  assert.match(html,/document\.querySelectorAll\('\.purchase-plan-check'\)\.forEach\(x=>x\.checked=true\)/);
  assert.match(html,/available=Math\.max\(0,\(Number\(product\.stock\)\|\|0\)-\(reservedByProduct\.get\(productId\)\|\|0\)\)/);
});

function recommendationFixture(){
 const state={settings:{purchaseCoverDays:25},products:[{id:'p',name:'Новый товар',stock:0}],purchases:[],reservations:[],kaspiOrderFeed:[],wbOrderFeed:[],ozonOrderFeed:[]};
 const ctx=vm.createContext({state,Date,Map,Infinity,prod:id=>state.products.find(p=>p.id===id),isBundleProduct:p=>p?.kind==='bundle',bundleComponents:p=>p?.components||[],stockProducts:()=>state.products.filter(p=>p.kind!=='bundle'),reportPeriodStart:()=>Date.now()-25*86400000,reportPeriodEnd:()=>Date.now()+86400000,marketplaceLifecycleStage:(_market,status)=>status==='CANCELLED'?'cancelled':'delivery',productAvailableStock:p=>Math.max(0,p.stock-state.reservations.filter(r=>r.active&&r.productId===p.id).reduce((n,r)=>n+r.qty,0)),purchaseRemainingDeliveryDays:()=>5});
 const fn=name=>sourceLines.find(l=>l.startsWith('function '+name+'('));
 vm.runInContext([constants,coverFunction,batchFunction,...['purchaseStatus','purchaseWarehouseQty','purchaseInboundTimeline','purchaseDemandQty','purchaseLastUnitCost','purchaseRecommendation'].map(fn),html.slice(html.indexOf('function purchaseRecommendations(){'),html.indexOf('\nfunction fifoLots('))].join('\n'),ctx);
 return{state,ctx,single:()=>ctx.purchaseRecommendation(state.products[0]),all:()=>ctx.purchaseRecommendations()};
}
test('no-sale empty products get an editable minimum recommendation from both calculation paths without mutating business data',()=>{
 const f=recommendationFixture(),before=structuredClone(f.state);for(const row of [f.single(),f.all()[0]]){assert.equal(row.qty,1);assert.equal(row.demand,0);assert.equal(row.daily,0);assert.equal(row.noDemand,true);assert.equal(row.days,0);assert.equal(row.estimatedCost,0)}assert.deepEqual(f.state,before);
});
test('stock, reserved stock and arriving goods control zero-demand recommendations without pretending there were sales',()=>{
 const f=recommendationFixture();f.state.products[0].stock=1;assert.equal(f.single(),null);assert.equal(f.all().length,0);
 f.state.reservations=[{active:true,productId:'p',qty:1}];assert.equal(f.all()[0].qty,1);
 for(const status of ['to_forwarder','to_me','at_warehouse']){f.state.purchases=[{productId:'p',status,qty:3}];assert.equal(f.single(),null);assert.equal(f.all().length,0)}
 f.state.purchases=[{productId:'p',status:'at_warehouse',qty:3,warehouseWrittenOffQty:3}];assert.equal(f.single().qty,1);assert.equal(f.all()[0].qty,1);
});
test('ordinary demand keeps full-batch math and bundles remain excluded',()=>{
 const f=recommendationFixture();f.state.kaspiOrderFeed=[{market:'Kaspi',productId:'p',qty:10,creationDate:Date.now()}];assert.equal(f.single().qty,10);assert.equal(f.all()[0].qty,10);assert.equal(f.all()[0].noDemand,false);
 f.state.products.push({id:'bundle',kind:'bundle',components:[{productId:'p',qty:2}]});assert.equal(f.all().length,1);f.state.products[0].stock=10;assert.equal(f.all().length,0);
});
test('the actual purchase row explains zero demand without Infinity or a fabricated daily forecast',()=>{
 const f=recommendationFixture(),box={innerHTML:''};Object.assign(f.ctx,{document:{getElementById:id=>id==='purchasePlan'?box:null},purchasePlanSelection:new Set(),purchasePlanCollapsed:false,syncPurchasePlanSelection(){},fmt:String,esc:String});
 vm.runInContext(sourceLines.find(l=>l.startsWith('function renderPurchasePlan()')),f.ctx);f.ctx.renderPurchasePlan();assert.match(box.innerHTML,/Купить 1/);assert.match(box.innerHTML,/продаж за 25 дн. нет/);assert.doesNotMatch(box.innerHTML,/Infinity|NaN|продажи 0\.0\/день/);
});
