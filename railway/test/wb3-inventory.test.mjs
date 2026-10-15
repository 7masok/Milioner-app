import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFileSync} from 'node:fs';
import {inventoryPage,aggregateInventory} from '../src/wb3-inventory-model.js';
const rows=[{nmId:123,chrtId:1,warehouseId:10,quantity:5,inWayToClient:2,inWayFromClient:1},{nmId:123,chrtId:1,warehouseId:11,quantity:3,inWayToClient:1},{nmId:123,chrtId:2,warehouseId:10,quantity:7}];
test('FBO aggregates warehouses without mixing sizes or counting duplicate rows',()=>{
 const data=aggregateInventory([...rows,rows[0]]);assert.equal(data.total,15);assert.equal(data.items['123'].quantity,15);assert.equal(data.sizes['123:1'].quantity,8);assert.equal(data.sizes['123:2'].quantity,7);assert.equal(data.toClient,3);assert.equal(data.fromClient,1);
});
test('missing or malformed WB inventory is an error, never an empty zero snapshot',()=>{
 assert.throws(()=>inventoryPage(undefined));assert.throws(()=>inventoryPage([{nmId:123,chrtId:1,warehouseId:10}]));assert.throws(()=>inventoryPage([{...rows[0],quantity:-1}]));assert.throws(()=>inventoryPage([{...rows[0],chrtId:0}]));assert.equal(aggregateInventory([]).total,0);
});
function browser(){const source=readFileSync(new URL('../../wb3-profile.js',import.meta.url),'utf8'),ctx={state:{products:[]},window:{},document:{},esc:x=>String(x),productCard:()=>'<div class="item row"><div class="grow"><div>В продаже: 0 шт.</div><div class="product-stock-secondary"></div></div></div>'};vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('let wb3Inventory='),source.indexOf('const originalStats=')),ctx);vm.runInContext(source.slice(source.indexOf('const originalProductCard='),source.indexOf('const oldFboFilter=')),ctx);return ctx;}
test('each product gets its own size quantity and an imported parent never doubles the total',()=>{
 const ctx=browser();ctx.data=aggregateInventory(rows);vm.runInContext('wb3Inventory=data;wb3StockReady=true',ctx);ctx.state.products=[{id:'a',wbVariant:{nmId:123,chrtId:1}},{id:'b',wbVariant:{nmId:123,chrtId:2}}];assert.equal(ctx.fboQty(ctx.state.products[0]),8);assert.equal(ctx.fboQty(ctx.state.products[1]),7);assert.equal(ctx.fboQty({wbVariant:{nmId:123,chrtId:3}}),0);assert.equal(ctx.fboQty({wbVariant:{nmId:123}}),null);
 const card=ctx.productCard(ctx.state.products[0]);assert.match(card,/FBO WB: 8 шт/);assert.match(card,/У меня: 0 шт/);
});
test('unknown FBO data is distinct from a confirmed empty snapshot',()=>{
 const ctx=browser(),p={id:'a',wbVariant:{nmId:123,chrtId:1}};ctx.state.products=[p];assert.equal(ctx.fboQty(p),null);assert.match(ctx.productCard(p),/FBO WB: не загружено/);vm.runInContext('wb3StockReady=true',ctx);assert.equal(ctx.fboQty(p),0);
});
