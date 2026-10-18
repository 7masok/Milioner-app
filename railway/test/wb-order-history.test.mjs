import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {initialWbOrderHistory,stepWbOrderHistory,historicalWbOrder,mergeReportingOrders,readWbOrderHistory,syncWbOrderHistory} from '../src/wb-order-history.js';
const now=Date.parse('2026-10-18T15:10:00Z'),DAY=86400000;
const order=(extra={})=>({id:101,createdAt:new Date(now-DAY).toISOString(),article:'toy',skus:['barcode'],techSize:'0',currencyCode:643,convertedCurrencyCode:398,price:10000,convertedPrice:60000,...extra});
const status=(extra={})=>({id:101,supplierStatus:'complete',wbStatus:'sold',...extra});
test('backfill scans at most 30 calendar days, newest first, and covers an empty full window',async()=>{
 const s=initialWbOrderHistory(now);assert.ok(s.to-s.from<30*DAY);assert.equal(s.coveredFrom,s.anchor);
 const result=await stepWbOrderHistory(s,{market:'WB',now,fetchPage:async args=>{assert.equal(args.cursor,0);assert.equal(args.to,s.anchor);return{orders:[],next:0}}});
 assert.equal(result.state.coveredFrom,s.from);assert.equal(result.state.to,s.from);assert.equal(result.state.from,s.from-29*DAY);assert.equal(result.state.complete,false);
 assert.equal(s.coveredFrom,s.anchor,'pure step never mutates persisted cursor');
});
test('page and status phases persist separately; coverage advances only after the final page',async()=>{
 const initial=initialWbOrderHistory(now);
 const page=await stepWbOrderHistory(initial,{market:'WB',now,fetchPage:async()=>({orders:[order({address:{secret:'never store'}})],next:101})});
 assert.equal(page.rows.length,0);assert.equal(page.state.phase,'statuses');assert.equal(page.state.coveredFrom,initial.anchor);assert.equal(JSON.stringify(page.state).includes('never store'),false);
 const saved=await stepWbOrderHistory(JSON.parse(JSON.stringify(page.state)),{market:'WB',now:now+60000,fetchStatuses:async ids=>{assert.deepEqual(ids,[101]);return{orders:[status({wbStatus:'canceled_by_client'})]}}});
 assert.equal(saved.rows[0].state,'canceled_by_client');assert.equal(saved.rows[0].totalPrice,600);assert.equal(saved.rows[0].historyOnly,true);assert.equal(saved.state.cursor,101);assert.equal(saved.state.coveredFrom,initial.anchor);
 const end=await stepWbOrderHistory(saved.state,{market:'WB',now:now+120000,fetchPage:async args=>{assert.equal(args.cursor,101);return{orders:[],next:0}}});assert.equal(end.state.coveredFrom,initial.from);
});
test('invalid pages, missing statuses and unknown currency never advance coverage or become fabricated zero sales',async()=>{
 const s=initialWbOrderHistory(now);
 for(const value of [{next:0},{orders:[order()],next:-1},{orders:[order({createdAt:'bad'})],next:0},{orders:[order({createdAt:new Date(s.from-1).toISOString()})],next:0}])await assert.rejects(stepWbOrderHistory(s,{market:'WB',now,fetchPage:async()=>value}));
 const page=await stepWbOrderHistory(s,{market:'WB',now,fetchPage:async()=>({orders:[order()],next:0})});
 await assert.rejects(stepWbOrderHistory(page.state,{market:'WB',now,fetchStatuses:async()=>({orders:[]})}));
 assert.throws(()=>historicalWbOrder('WB',order({convertedCurrencyCode:643}),status()),/тенге/);
 assert.equal(historicalWbOrder('WB2',order({techSize:'42'}),status()).sku,'barcode');
 assert.equal(historicalWbOrder('WB2',order(),status()).sku,'toy');
});
test('completed archive refresh preserves old coverage and resumes the status phase after restart',async()=>{
 const s={...initialWbOrderHistory(now),complete:true,coveredFrom:now-364*DAY,anchor:now-DAY,goal:now-364*DAY};
 const page=await stepWbOrderHistory(s,{market:'WB',now,fetchPage:async()=>({orders:[order()],next:0})});assert.equal(page.state.mode,'refresh');
 const final=await stepWbOrderHistory(page.state,{market:'WB',now:now+60000,fetchStatuses:async()=>({orders:[status()]})});
 assert.equal(final.rows.length,1);assert.equal(final.state.mode,undefined);assert.equal(final.state.coveredFrom,s.coveredFrom);assert.equal(final.state.anchor,now);assert.ok(final.state.nextAllowedAt>now+23*3600000);
});
test('report merge deduplicates only within the same shop; live prices and statuses take priority',()=>{
 const a=historicalWbOrder('WB',order(),status()),b={...a,market:'WB2'},live={...a,totalPrice:700,state:'canceled'};
 const rows=mergeReportingOrders([live],[a,b],15000);assert.equal(rows.length,2);assert.equal(rows.find(x=>x.market==='WB').totalPrice,700);assert.equal(rows.find(x=>x.market==='WB').state,'canceled');assert.equal(mergeReportingOrders([live],[a,b],1).length,1);
});
test('archive reads use both bounds and shop, and never write warehouse or active orders',async()=>{
 const queries=[];const client={query:async(sql,args)=>{queries.push({sql,args});assert.match(sql,/^SELECT/);return{rows:sql.includes('FROM wb_order_history a')?[{payload:historicalWbOrder('WB',order(),status()),productId:'p'}]:[{market:'WB',payload:initialWbOrderHistory(now)}]}}};
 const result=await readWbOrderHistory(client,now-30*DAY,now,'WB',15000);assert.deepEqual(queries[0].args,[now-30*DAY,now,'WB',15000]);assert.equal(result.rows[0].productId,'p');assert.equal(result.states[0].status,'loading');
 const source=readFileSync(new URL('../src/wb-order-history.js',import.meta.url),'utf8');
 assert.doesNotMatch(source,/reconcile|INSERT INTO marketplace_order_lines|UPDATE warehouse|INSERT INTO warehouse/);
 const api=readFileSync(new URL('../src/orders.js',import.meta.url),'utf8');assert.match(api,/before&&after&&req.query.history==='1'/);
});
function database(state){
 let saved=structuredClone(state),backup,failRows=false;const queries=[];
 const db={release(){},async query(sql,args=[]){queries.push({sql,args});
  if(sql.includes('pg_try_advisory_lock'))return{rows:[{locked:true}]};
  if(sql.startsWith('SELECT payload'))return{rows:[{payload:structuredClone(saved)}]};
  if(sql==='BEGIN')backup=structuredClone(saved);if(sql==='ROLLBACK'&&backup){saved=backup;backup=null}if(sql==='COMMIT')backup=null;
  if(sql.includes('INSERT INTO wb_order_history_state'))saved=JSON.parse(args[1]);
  if(sql.includes('INSERT INTO wb_order_history(')){if(failRows)throw Error('fixture DB failure');return{rows:[{inserted:true}]}}
  return{rows:[]};}};
 return{connect:async()=>db,queries,state:()=>saved,fail(){failRows=true}};
}
test('worker persists cooldown before network and preserves cursor/retry across 429 and restart',async()=>{
 const client=database(initialWbOrderHistory(now));let calls=0;
 await syncWbOrderHistory('WB',{client,token:'fixture',now,fetcher:async url=>{calls++;assert.match(url,/dateTo=/);assert.ok(client.state().nextAllowedAt>now);return{ok:false,status:429,headers:new Headers({'retry-after':'7200'})}}});
 assert.equal(calls,1);assert.equal(client.state().cursor,0);assert.equal(client.state().nextAllowedAt,now+7200000);
 await syncWbOrderHistory('WB',{client,token:'fixture',now:now+60000,fetcher:async()=>{throw Error('must not fetch')}});assert.equal(calls,1);
 assert.ok(client.queries.some(q=>q.sql.includes('pg_advisory_unlock')));
});
test('failed archive insert rolls back without acknowledging a page or advancing its cursor',async()=>{
 const initial=initialWbOrderHistory(now),page=await stepWbOrderHistory(initial,{market:'WB',now,fetchPage:async()=>({orders:[order()],next:101})}),client=database(page.state);client.fail();
 await syncWbOrderHistory('WB',{client,token:'fixture',now:now+60000,fetcher:async()=>({ok:true,json:async()=>({orders:[status()]}),headers:new Headers()})});
 assert.equal(client.state().phase,'statuses');assert.equal(client.state().cursor,0);assert.equal(client.state().pending.length,1);assert.equal(client.state().rows,0);assert.ok(client.queries.some(q=>q.sql==='ROLLBACK'));
});
test('report-only orders route includes archive and checked coverage; ordinary feed stays isolated',async()=>{
 const {ordersRouter}=await import('../src/orders.js'),{pool}=await import('../src/db.js');
 const handler=ordersRouter.stack.find(x=>x.route?.path==='/orders'&&x.route.methods.get).route.stack[0].handle,prior=pool.query;
 const live={...historicalWbOrder('WB',order(),status()),totalPrice:900};let archiveReads=0;
 pool.query=async(sql,args)=>{
  if(sql.includes('FROM marketplace_order_lines o'))return{rows:[live]};
  if(sql.includes('MIN(creation_date)'))return{rows:[{market:'WB',from:now-14*DAY}]};
  if(sql.includes('FROM wb_order_history a')){archiveReads++;return{rows:[{payload:{...live,totalPrice:500}},{payload:historicalWbOrder('WB2',order({id:102}),status({id:102}))}]};}
  if(sql.includes('FROM wb_order_history_state'))return{rows:['WB','WB2'].map(market=>({market,payload:{...initialWbOrderHistory(now),coveredFrom:now-60*DAY}}))};
  return{rows:[]};
 };
 try{
  let result;const invoke=async history=>{await handler({query:{after:String(now-30*DAY),before:String(now),history,limit:'15000'}},{json:x=>{result=x}},e=>{throw e});return result;};
  const report=await invoke('1');assert.equal(report.orders.length,2);assert.equal(report.orders.find(r=>r.market==='WB').totalPrice,900);assert.equal(report.historyCoverage.find(r=>r.market==='WB').from,now-60*DAY);
  const normal=await invoke(undefined);assert.equal(normal.orders.length,1);assert.equal(archiveReads,1);
 }finally{pool.query=prior}
});
