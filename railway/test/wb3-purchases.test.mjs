import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const profile=readFileSync(new URL('../../wb3-profile.js',import.meta.url),'utf8');
const ignore=readFileSync(new URL('../../purchase-plan-ignore-v1.js',import.meta.url),'utf8');
const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
function setup(){
 const p={id:'a',name:'Браслет',stock:6,wbVariant:{nmId:123,chrtId:1}};
 const state={products:[p],settings:{purchasePlanIgnored:{}},purchases:[],wbOrderFeed:[]};
 let cover=25;
 const ctx={state,window:{WB3_ONLY:true},document:{getElementById:()=>null},setTimeout(){},
  purchaseCoverDays:()=>cover,reportPeriodStart:()=>1,reportPeriodEnd:()=>100,
  prod:id=>state.products.find(p=>p.id===id),stockProducts:()=>state.products,
  productAvailableStock:p=>Math.max(0,p.stock-(p.reserved||0)),isBundleProduct:()=>false,
  marketplaceLifecycleStage:(m,s)=>s==='cancel'?'cancelled':'new',
  purchaseInboundTimeline:id=>state.purchases.filter(x=>x.productId===id&&x.status!=='received').map(row=>({row,status:row.status,qty:row.qty,days:row.days||0})),
  purchaseWorkflowStage:x=>x.workflowStageId,
  purchaseWarehouseQty:x=>Math.max(0,x.qty-(x.warehouseWrittenOffQty||0)),
  purchaseLastUnitCost:()=>100,purchaseRecommendations:()=>{throw Error('WB3 must not use the full-batch calculator');},renderPurchasePlan(){},
 };
 vm.createContext(ctx);
 vm.runInContext(profile.slice(profile.indexOf('let wb3Inventory='),profile.indexOf('const originalStats=')),ctx);
 vm.runInContext(profile.slice(profile.indexOf('let wb3PurchaseUnknown='),profile.indexOf('async function loadWb3Stock(')),ctx);
 vm.runInContext(ignore,ctx);
 const order=(qty,extra={})=>state.wbOrderFeed.push({productId:'a',creationDate:50,qty,fulfillment:'FBO',...extra});
 return {ctx,state,p,order,setCover:n=>cover=n,setStock:data=>{ctx.data=data;vm.runInContext('wb3Inventory=data;wb3StockReady=Number(data.fetchedAt)>0',ctx);},rows:()=>ctx.purchaseRecommendations()};
}
test('FBS and FBO demand subtract free own stock, exact FBO size and paid inbound; cached/bulk quantities agree',()=>{
 const f=setup();f.p.reserved=2;f.order(30,{fulfillment:'FBS'});f.order(20);
 f.setStock({fetchedAt:1,sizes:{'123:1':{quantity:12},'123:2':{quantity:99}},items:{123:{quantity:111}}});
 f.state.purchases.push({productId:'a',qty:10,status:'to_me',workflowStageId:'shipping'});
 const before=JSON.stringify(f.state),[row]=f.rows();
 assert.equal(row.target,50);assert.equal(row.localAvailable,4);assert.equal(row.fbo,12);assert.equal(row.inbound,10);assert.equal(row.qty,24);assert.equal(row.estimatedCost,2400);
 assert.equal(f.ctx.window.__lastPurchaseRecommendations[0].qty,24);
 assert.equal(JSON.stringify(f.state),before);
 f.setStock({fetchedAt:2,sizes:{'123:1':{quantity:40}}});assert.equal(f.rows().length,0);
});
test('received purchases are not counted twice; cart is excluded and warehouse writeoffs reduce supply',()=>{
 const f=setup();f.order(50);f.setStock({fetchedAt:1,sizes:{'123:1':{quantity:5}}});
 f.state.purchases.push(...[
  {qty:100,status:'to_forwarder',workflowStageId:'cart'},
  {qty:100,status:'received'},
  {qty:10,status:'at_warehouse',warehouseWrittenOffQty:4},
  {qty:5,status:'to_forwarder',workflowStageId:'paid'}
 ].map(x=>({productId:'a',...x})));
 const [row]=f.rows();assert.equal(row.inbound,11);assert.equal(row.qty,28);
 f.state.purchases.push({productId:'a',qty:28,status:'to_me'});assert.equal(f.rows().length,0);
});
test('unknown FBO never creates a buy recommendation, confirmed zero does; hidden items stay hidden',()=>{
 const f=setup();f.order(10);assert.equal(f.rows().length,0);assert.equal(vm.runInContext('wb3PurchaseUnknown',f.ctx),1);
 f.setStock({fetchedAt:1,items:{},sizes:{}});assert.equal(f.rows()[0].qty,4);
 f.state.settings.purchasePlanIgnored={a:{hidden:true}};assert.equal(f.rows().length,0);assert.equal(vm.runInContext('wb3PurchaseUnknown',f.ctx),0);
});
test('cancellations, returns and dates outside the selected range do not inflate demand',()=>{
 const f=setup();f.setStock({fetchedAt:1});f.order(10);f.order(100,{orderStatus:'cancel'});f.order(100,{orderStatus:'return'});f.order(100,{orderStatus:'returnDefective'});f.order(100,{status:'cancel'});f.order(100,{creationDate:101});f.order(100,{creationDate:0});
 assert.equal(f.rows()[0].target,10);f.setCover(40);assert.equal(f.rows()[0].daily,.25);
});
test('rendered quantities use the same deficit for individual and bulk purchase drafts',()=>{
 const f=setup();f.setStock({fetchedAt:1,sizes:{'123:1':{quantity:2}}});f.order(20);
 f.ctx.decodeURIComponent=decodeURIComponent;f.ctx.purchasePlanSelection=new Set(['a']);f.ctx.openModal=()=>{};
 vm.runInContext(html.split('\n').filter(x=>/^function open(RecommendedPurchase|SelectedRecommendedPurchase)\(/.test(x)).join('\n'),f.ctx);
 f.ctx.openRecommendedPurchase('a');assert.equal(f.ctx.window.pendingPurchaseRecommendations[0].qty,12);
 f.ctx.openSelectedRecommendedPurchase();assert.equal(f.ctx.window.pendingPurchaseRecommendations[0].qty,12);
});
test('legacy warehouse still calls its original full-batch provider',()=>{
 const ctx={window:{WB3_ONLY:false},state:{settings:{}},purchaseRecommendations:()=>[{productId:'old',qty:50}],renderPurchasePlan(){},setTimeout(){}};
 vm.createContext(ctx);vm.runInContext(ignore,ctx);assert.equal(ctx.purchaseRecommendations()[0].qty,50);
});
