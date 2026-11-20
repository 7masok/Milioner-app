import assert from 'node:assert/strict';
import test from 'node:test';
import {campaignInventory,stockBlock,arrivalDays} from '../src/wb-ad-inventory.js';
const now=Date.parse('2026-09-05T12:00:00Z'),DAY=86400000;
const product=(id,stock,extra={})=>({id,name:id,stock,wb:id,...extra});
const order=(sku,qty,extra={})=>({market:'WB',sku,qty,...extra});
function risk(products,orders=[],extra={}){return campaignInventory({products,...extra},orders,'WB',[{id:1,vendorCodes:products.map(p=>p.wb)}],now).get(1)}
test('zero free stock blocks start even if a shipment is due today',()=>{
 const r=risk([product('a',10)],[order('a',50)],{reservations:[{productId:'a',qty:10,active:true}],purchases:[{productId:'a',qty:50,status:'at_warehouse'}]});
 assert.equal(r.allEmpty,true);assert.match(stockBlock(r),/Нет свободного/);
});
test('less than five days warns, optional auto pause blocks',()=>{
 const r=risk([product('a',8)],[order('a',50)]);
 assert.equal(r.products[0].days,4);assert.equal(r.status,'low');assert.equal(stockBlock(r),'');assert.ok(stockBlock(r,{lowStockMode:'pause'}));
});
test('timely sufficient shipment covers the shortage',()=>{
 const r=risk([product('a',8)],[order('a',50)],{purchases:[{productId:'a',qty:10,status:'to_me',workflowStageAt:now-18*DAY}]});
 assert.equal(r.status,'inbound');assert.equal(r.allRisky,false);
});
test('shipment after stock runs out does not protect campaign',()=>{
 const r=risk([product('a',2)],[order('a',50)],{purchases:[{productId:'a',qty:100,status:'to_me',workflowStageAt:now-18*DAY}]});
 assert.equal(r.status,'low');
});
test('insufficient timely shipment does not suppress warning',()=>{
 const r=risk([product('a',2)],[order('a',50)],{purchases:[{productId:'a',qty:1,status:'at_warehouse'}]});assert.equal(r.status,'low');
});
test('overdue shipment is unknown, not immediate replenishment',()=>{
 assert.equal(arrivalDays({status:'to_me',workflowStageAt:now-21*DAY},{},now),null);
});
test('mixed campaign warns but does not automatically pause all goods',()=>{
 const r=risk([product('a',0),product('b',100)],[order('a',25),order('b',25)]);assert.equal(r.status,'low');assert.equal(r.allEmpty,false);assert.equal(r.allRisky,false);assert.equal(stockBlock(r,{lowStockMode:'pause'}),'');
});
test('unknown mapping and missing stock never imply zero stock',()=>{
 const r=campaignInventory({products:[product('a',10)]},[],'WB',[{id:1,vendorCodes:['missing']}],now).get(1);
 assert.equal(r.known,false);assert.equal(r.allEmpty,false);assert.ok(stockBlock(r));
 assert.equal(risk([product('a',undefined)]).known,false);
});
test('all marketplace demand counts once and cancellations are excluded',()=>{
 const r=risk([product('a',8,{kaspi:'k'})],[order('a',25),order('k',25,{market:'Kaspi'}),order('a',100,{status:'CANCELLED'})]);assert.equal(r.products[0].daily,2);
});
test('bundle reservations consume component inventory',()=>{
 const r=risk([product('a',10),product('bundle',0,{kind:'bundle',components:[{productId:'a',qty:2}]})],[],{reservations:[{productId:'bundle',qty:5,active:true}]});assert.equal(r.allEmpty,true);
});
test('no demand does not invent a stock coverage forecast',()=>{
 const r=risk([product('a',5)]);assert.equal(r.products[0].days,null);assert.equal(r.status,'no_demand');
});
test('string aliases match the warehouse link format without duplicating demand',()=>{
 const p=product('a',8,{wbAliases:'alias; a\nalias'});
 const r=risk([p],[order('alias',50)]);
 assert.equal(r.products[0].daily,2);
 assert.equal(r.status,'low');
});

const withFbo=(products,ids,stock,{market='WB',orders=[]}={})=>campaignInventory(
 {products},orders,market,[{id:1,nmIds:ids,vendorCodes:products.map(p=>p[market==='WB2'?'wb2':'wb'])}],now,stock
).get(1);

test('available FBO permits a campaign with zero local stock and excludes units in delivery and returns',()=>{
 const r=withFbo([product('pink',0)],[123,123],{
  fetchedAt:now-1000,items:{123:{quantity:14,inWayToClient:20,inWayFromClient:5},456:{quantity:100}}
 },{orders:[order('pink',50)]});
 assert.equal(r.available,14);
 assert.equal(r.fboAvailable,14);
 assert.equal(r.products[0].days,7);
 assert.equal(stockBlock(r,{lowStockMode:'pause'}),'');
});

test('FBO is counted once for shared articles and assigned to exact sizes when possible',()=>{
 const products=[product('s',2,{kind:'variant',wbVariant:{market:'WB',nmId:123,chrtId:11}}),
  product('m',0,{kind:'variant',wbVariant:{market:'WB',nmId:123,chrtId:12}})];
 const r=withFbo(products,[123],{fetchedAt:now,items:{123:{quantity:9}},sizes:{'123:11':{quantity:3},'123:12':{quantity:6}}});
 assert.equal(r.available,11);
 assert.deepEqual(r.products.map(p=>p.available),[5,6]);
 const aggregate=withFbo(products,[123],{fetchedAt:now,items:{123:{quantity:9}}});
 assert.equal(aggregate.available,11);
 assert.deepEqual(aggregate.products.map(p=>p.available),[2,0]);
 assert.equal(aggregate.allRisky,false);
});

test('stale or partial FBO cannot turn a zero local balance into a confirmed zero',()=>{
 const products=[product('pink',0,{wb2:'pink',wb2Identity:{nmId:123}})];
 for(const stock of [{fetchedAt:now-3600001,items:{123:{quantity:5}}},{fetchedAt:now,items:{456:{quantity:5}}}]){
  const r=withFbo(products,[123],stock,{market:'WB2'});
  assert.equal(r.known,false);
  assert.equal(r.allEmpty,false);
  assert.match(stockBlock(r),/Ждём подтверждения остатков FBO/);
 }
 const r=withFbo(products,[123],{fetchedAt:now,items:{},fullCatalog:true},{market:'WB2'});
 assert.equal(r.available,0);
 assert.equal(r.allEmpty,true);
});

test('an exact different WB article cannot pick up FBO through a conflicting seller code',()=>{
 const r=withFbo([product('pink',0,{wbIdentity:{nmId:456}})],[123],{fetchedAt:now,items:{123:{quantity:14}}});
 assert.equal(r.known,false);
 assert.equal(r.products.length,0);
 assert.ok(stockBlock(r));
});

test('an exact active article excludes a second warehouse row matched only by seller code',()=>{
 const products=[
  product('black',78,{wbIdentity:{nmId:123}}),
  product('gray',82,{wbAliases:['black']}),
 ];
 const campaigns=[{id:42095728,nmIds:[123],vendorCodes:['black'],vendorCodesByNm:{123:'black'}}];
 const stock=campaignInventory({products},[],'WB',campaigns,now).get(42095728);
 assert.equal(stock.available,78);
 assert.deepEqual(stock.products.map(row=>row.productId),['black']);
});
