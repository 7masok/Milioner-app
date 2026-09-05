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
