import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../../index.html',import.meta.url),'utf8');
function extract(name){const start=html.indexOf('function '+name+'(');assert.ok(start>=0);return html.slice(start,html.indexOf('\nfunction ',start+10))}
function fixture(purchases,products=[{id:'red',name:'Леденец ярый',stock:0,cost:0}]){
 const state={products,purchases},context={state,prod:id=>products.find(p=>p.id===id)};
 vm.createContext(context);vm.runInContext(['isBundleProduct','bundleComponents','productDisplayCost','purchaseStatus','purchaseDisplayUnitCost','productCardUnitCost','productLifetimeAverageCost'].map(extract).join('\n'),context);
 return {context,state,p:products[0],cost:(p=products[0],inventory=null)=>context.productCardUnitCost(p,inventory),lifetimeCost:(p=products[0])=>context.productLifetimeAverageCost(p)};
}
test('five warehouse lollipops display purchase plus delivery without sales and survive rename',()=>{
 const f=fixture([{productId:'red',status:'at_warehouse',qty:5,unitCost:46,delivery:80,landedUnitCost:62}]);
 const before=JSON.stringify(f.state);assert.equal(f.cost(),62);assert.equal(JSON.stringify(f.state),before);
 f.p.name='Красный леденец';assert.equal(f.cost(),62);assert.equal(f.p.cost,0);assert.equal(f.p.stock,0);
});
test('multiple warehouse batches use quantity weighting and exclude baskets, transit and other products',()=>{
 const f=fixture([{productId:'red',status:'at_warehouse',qty:5,landedUnitCost:62},{productId:'red',status:'at_warehouse',qty:15,landedUnitCost:100},...['to_me','to_forwarder','received'].map(status=>({productId:'red',status,qty:100,landedUnitCost:999})),{productId:'blue',status:'at_warehouse',qty:100,landedUnitCost:999},{productId:'red',status:'at_warehouse',qty:0,landedUnitCost:999}]);
 assert.equal(f.cost(),90.5);assert.equal(f.cost(f.p,{warehouse:20,warehouseCost:1810}),90.5);
});
test('legacy batch computes landed cost while explicit zero remains known',()=>{
 const f=fixture([{productId:'red',status:'at_warehouse',qty:5,unitCost:46,delivery:80}]);assert.equal(f.cost(),62);
 f.state.purchases[0]={productId:'red',status:'at_warehouse',qty:5,buyTotal:230,delivery:80,landedUnitCost:null};assert.equal(f.cost(),62);
 f.state.purchases[0].landedUnitCost=0;assert.equal(f.cost(),0);
});
test('stock already in sale and bundle economics retain original cost',()=>{
 const f=fixture([{productId:'red',status:'at_warehouse',qty:5,landedUnitCost:62}]);f.p.stock=3;f.p.cost=91;assert.equal(f.cost(),91);
 const bundle={id:'bundle',kind:'bundle',components:[{productId:'red',qty:2}]};assert.equal(f.cost(bundle),182);
 f.p.stock=0;f.state.purchases=[];assert.equal(f.cost(),91);
});
test('rendered card uses warehouse display cost and keeps historical sales cost separate',()=>{
 assert.match(extract('productCard'),/unitCost=productCardUnitCost\(p,inventory\)/);
 assert.match(extract('buildProductRenderStats'),/productMapAdd\(atWarehouseCostMap,key,qty\*purchaseDisplayUnitCost\(row\)\)/);
 assert.match(extract('productInventoryRow'),/warehouseCost:Math.max/);
 assert.doesNotMatch(extract('reportSaleUnitCost'),/productCardUnitCost/);
});

test('opened lollipop card shows cost from the five accepted warehouse units before any sales',async()=>{
 const f=fixture([{productId:'red',status:'at_warehouse',qty:5,unitCost:46,delivery:80,landedUnitCost:62}]);
 const before=JSON.stringify(f.state);assert.equal(f.lifetimeCost(),62);
 let sheet='';
 Object.assign(f.context,{
  document:{getElementById:()=>null},window:{allMarketUnitProfit30:new Map([['red',{profit:0,ads:0,sources:{}}]])},
  productDisplayStock:p=>p.stock,productAverageDailySales:()=>0,reportPeriodStart:()=>0,reportPeriodEnd:()=>Date.now(),
  purchaseAtWarehouseQty:()=>5,productAvailableStock:()=>0,wbRelinkNotice:()=>'',esc:x=>String(x),fmt:x=>x+' ₸',showSheet:html=>{sheet=html;}
 });
 const start=html.indexOf('async function openProduct(');
 vm.runInContext(html.slice(start,html.indexOf('\nfunction ',start)),f.context);
 await f.context.openProduct('red');
 assert.match(sheet,/Средняя себестоимость 1 шт\. · все поставки<\/div><b>62 ₸<\/b>/);
 assert.match(sheet,/Из склада в продажу · 5 шт\./);
 assert.equal(JSON.stringify(f.state),before);
 f.p.name='Красный леденец';assert.equal(f.lifetimeCost(),62);
});

test('lifetime modal cost weights accepted and released purchases but excludes transit and stock relocation',()=>{
 const f=fixture([
  {productId:'red',status:'received',qty:5,landedUnitCost:62,remainingQty:0},
  {productId:'red',status:'at_warehouse',qty:15,landedUnitCost:100},
  ...['to_me','to_forwarder'].map(status=>({productId:'red',status,qty:100,landedUnitCost:999})),
  {productId:'red',status:'at_warehouse',qty:4,landedUnitCost:999,relocation:true},
  {productId:'red',status:'received',qty:4,landedUnitCost:999,relocation:true},
  {productId:'blue',status:'received',qty:100,landedUnitCost:999},
  {productId:'red',status:'at_warehouse',qty:0,landedUnitCost:999}
 ]);
 assert.equal(f.lifetimeCost(),90.5);
 // Splitting a warehouse batch for partial release must not change purchase weighting.
 f.state.purchases[1].qty=10;
 f.state.purchases.push({productId:'red',status:'received',qty:5,landedUnitCost:100});
 assert.equal(f.lifetimeCost(),90.5);
});

test('modal lifetime cost reuses delivery fallback and preserves explicit zero, bundle components and saved fallback',()=>{
 const f=fixture([{productId:'red',status:'at_warehouse',qty:5,unitCost:46,buyTotal:230,delivery:80,landedUnitCost:null}]);
 assert.equal(f.lifetimeCost(),62);
 for(const missing of [undefined,'',null]){f.state.purchases[0].landedUnitCost=missing;assert.equal(f.lifetimeCost(),62);}
 const bundle={id:'bundle',kind:'bundle',components:[{productId:'red',qty:2}]};assert.equal(f.lifetimeCost(bundle),124);
 f.state.purchases[0].landedUnitCost=0;assert.equal(f.lifetimeCost(),0);
 f.state.purchases=[];f.p.cost=91;assert.equal(f.lifetimeCost(),91);
 f.state.purchases=[{productId:17,status:'at_warehouse',qty:5,landedUnitCost:62}];f.p.id='17';assert.equal(f.lifetimeCost(),62);
});
