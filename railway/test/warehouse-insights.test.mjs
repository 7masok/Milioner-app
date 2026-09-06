import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const context={window:{}};
vm.runInNewContext(readFileSync(new URL('../../warehouse-insights.js',import.meta.url),'utf8'),context);
const analyze=context.window.WarehouseInsights.analyze;
const now=Date.now(),products=[{id:'a',stock:10,reserved:2,cost:100}];
const orders=[{key:'WB:1:a',productId:'a',qty:50,date:now}];
test('stock value excludes reserves and duplicate orders do not double demand',()=>{
 const r=analyze(products,[...orders,...orders],[],now);
 assert.equal(r.freeValue,800);assert.equal(r.rows[0].days,4);assert.equal(r.rows[0].risk,true);
});
test('late and insufficient supplies do not hide a stock gap',()=>{
 assert.equal(analyze(products,orders,[{productId:'a',qty:100,days:5}],now).rows[0].gap,true);
 assert.equal(analyze(products,orders,[{productId:'a',qty:1,days:1}],now).rows[0].risk,true);
 assert.equal(analyze(products,orders,[{productId:'a',qty:100,days:2}],now).rows[0].risk,false);
});
test('missing costs and no orders stay visible without inventing demand',()=>{
 const r=analyze([{id:'a',stock:4}],[],[],now);
 assert.equal(r.missingCost,1);assert.equal(r.rows[0].days,null);assert.equal(r.rows[0].noOrders,true);
});
test('cancelled orders and future records do not create demand',()=>{
 const r=analyze(products,[{...orders[0],cancelled:true},{...orders[0],date:now+1}],[],now);
 assert.equal(r.rows[0].qty,0);
});
