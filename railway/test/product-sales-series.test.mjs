import test from 'node:test';
import assert from 'node:assert/strict';
import {pool} from '../src/db.js';
import {reportsRouter} from '../src/reports.js';
import {buildProductOrderSeries} from '../src/product-sales-series.js';
const DAY=86400000,at=d=>Date.parse(d+'T00:00:00+05:00');
const order=(market,id,sku,qty=1,extra={})=>({market,order_id:id,entry_id:id,sku,qty,creation_date:at('2026-10-08')+3600000,raw_json:'{}',...extra});
const products=[{id:'a',name:'a',payload:{kaspi:'ka',wb:'same'}},{id:'b',name:'b',payload:{kaspi:'kb',wb2:'same'}}];
const links=[{market:'Kaspi',sku:'ka',productId:'a'},{market:'Kaspi',sku:'kb',productId:'b'},{market:'WB',sku:'same',productId:'a'},{market:'WB2',sku:'same',productId:'b'}];
test('placed quantity includes cancelled and completed orders by creation, not delivery or completion date',()=>{
 const orders=[order('Kaspi','cancelled','ka',3,{status:'CANCELLED',completion_date:at('2026-10-15')}),order('Kaspi','completed','ka',2,{status:'COMPLETED',completion_date:at('2026-10-16')})];
 const out=buildProductOrderSeries({orders,links,products});assert.deepEqual(out.rows,[{market:'Kaspi',productId:'a',day:'2026-10-08',qty:5}]);
});
test('multi-product orders retain entry quantities, duplicated observations do not add orders, cabinets are separate',()=>{
 const first=order('Kaspi','multi','ka',3,{entry_id:'line-a'}),orders=[first,{...first,status:'RETURNED'},order('Kaspi','multi','kb',2,{entry_id:'line-b'}),order('WB','same-id','same'),order('WB2','same-id','same')];
 const out=buildProductOrderSeries({orders,links,products});assert.deepEqual(out.rows.map(x=>[x.market,x.productId,x.qty]),[['Kaspi','a',3],['Kaspi','b',2],['WB','a',1],['WB2','b',1]]);
});
test('Almaty midnight and exact saved Kaspi aliases apply; unrelated and pending lines do not become a product',()=>{
 const out=buildProductOrderSeries({orders:[order('Kaspi','alias','alias',2,{creation_date:Date.parse('2026-10-08T19:01:00Z')}),order('Kaspi','pending',''),order('Kaspi','unknown','other')],links,products:[{...products[0],payload:{kaspi:'ka',kaspiAliases:['alias']}}]});
 assert.deepEqual(out.rows,[{market:'Kaspi',productId:'a',day:'2026-10-09',qty:2}]);assert.equal(out.unlinked,2);
});
test('WB precise barcode keeps sizes separate; shared card and conflicting Kaspi links remain uncertain',()=>{
 const sizes=[{id:'small',payload:{wb:'shirt',wbIdentity:{nmId:'71'}}},{id:'large',payload:{wb:'shirt',wbIdentity:{nmId:'71'}}}];
 const sizeLinks=[{market:'WB',sku:'111',productId:'small'},{market:'WB',sku:'222',productId:'large'},{market:'WB',sku:'shirt',productId:'small'},{market:'Kaspi',sku:'conflict',productId:'small'},{market:'Kaspi',sku:'conflict',productId:'large'}];
 const out=buildProductOrderSeries({products:sizes,links:sizeLinks,orders:[order('WB','small','shirt',1,{raw_json:{identity:{nmId:'71',article:'shirt',barcode:'111'}}}),order('WB','ambiguous','shirt',1,{raw_json:{identity:{nmId:'71',article:'shirt'}}}),order('Kaspi','ambiguous','conflict')]});
 assert.deepEqual(out.rows.map(x=>[x.productId,x.qty]),[['small',1]]);assert.deepEqual(out.uncertain.map(x=>[x.market,x.productId]).sort(),[['Kaspi','large'],['Kaspi','small'],['WB','large'],['WB','small']]);
});
async function invoke(query={from:at('2026-10-02'),to:at('2026-10-17')},overflow=false){
 const handler=reportsRouter.stack.find(x=>x.route?.path==='/product-order-series').route.stack[0].handle,old=pool.query,calls=[];let status=200,out;
 pool.query=async(sql,args)=>{calls.push({sql,args});if(sql.startsWith('SELECT market,order_id'))return{rows:overflow?Array(50001).fill(order('Kaspi','a','ka')):[order('Kaspi','a','ka',3)]};if(sql.includes('FROM product_links'))return{rows:links};if(sql.includes('FROM warehouse_products'))return{rows:products};if(sql.includes('FROM sync_runs'))return{rows:[{market:'Kaspi',firstDate:1,lastDate:at('2026-10-16')+3600000}]};throw Error(sql)};
 try{await handler({query},{status(n){status=n;return this},json(x){out=x}},e=>{throw e})}finally{pool.query=old}return{status,out,calls};
}
test('order endpoint reads only cached placed lines and last successful sync; no status filter or finance query',async()=>{
 const {out,calls,status}=await invoke();assert.equal(status,200);assert.equal(out.rows[0].qty,3);assert.equal(out.history[0].lastDate,at('2026-10-16')+3600000);assert.ok(calls.every(x=>x.sql.startsWith('SELECT ')));assert.doesNotMatch(calls.map(x=>x.sql).join('\n'),/wb_finance|wb_sales_live|status\s*=|COMPLETED|DELETE|UPDATE|INSERT/);assert.match(calls.at(-1).sql,/ok=1 AND finished_at>0/);assert.deepEqual(calls[0].args,[['Kaspi','WB','WB2'],at('2026-10-02'),at('2026-10-17')]);
});
test('bad bounds and overflow fail explicitly; two 365-day windows plus today are accepted',async()=>{
 for(const query of [{from:0,to:1},{from:3,to:2},{from:'x',to:4},{from:1,to:1+732*DAY}]){const r=await invoke(query);assert.equal(r.status,400);assert.equal(r.calls.length,0)}assert.equal((await invoke({from:1,to:1+731*DAY})).status,200);assert.equal((await invoke(undefined,true)).status,422);
});
