import test from 'node:test';
import assert from 'node:assert/strict';
import {initialKaspiHistory,stepKaspiHistory,kaspiHistoryOrder,syncKaspiHistory,readKaspiHistory,KASPI_HISTORY_STATES} from '../src/kaspi-order-history.js';
import {mergeReportingOrders} from '../src/wb-order-history.js';
const NOW=Date.parse('2026-10-19T01:40:00+05:00'),DAY=86400000;
const raw=(extra={})=>({id:'order-1',attributes:{code:'1001',state:'ARCHIVE',status:'COMPLETED',creationDate:Date.parse('2026-06-12T10:00:00Z'),completionDate:Date.parse('2026-06-15T10:00:00Z'),totalPrice:110,...extra}});
const lines=[{id:'entry1',merchantCode:'toy',quantity:2,totalPrice:50},{id:'entry2',merchantCode:'cat',quantity:1,totalPrice:60}];
const page=data=>({data,meta:{pageCount:data.length?1:0}});
test('initial scan fills the oldest live gap first, with 14-day inclusive intervals and a fixed Almaty year',()=>{
 const live=Date.parse('2026-07-01T00:00:00+05:00'),s=initialKaspiHistory(NOW,live);
 assert.equal(s.to,live+DAY);assert.equal(s.to-s.from,14*DAY-1);assert.equal(s.coveredFrom,live);
 assert.equal(s.goal,Date.parse('2025-10-20T00:00:00+05:00'));
 assert.equal(initialKaspiHistory(NOW).to,Math.floor(NOW/1000)*1000);
});
test('state-date queries retain earlier creation dates, compact pending data and resume entries after restart',async()=>{
 const s=initialKaspiHistory(NOW,Date.parse('2026-07-01T00:00:00+05:00'));
 const r=raw({customer:{name:'private'},deliveryAddress:{street:'private'}});
 const first=await stepKaspiHistory(s,{now:NOW,fetchPage:async q=>{assert.equal(q.state,'ARCHIVE');return page([r])}});
 assert.equal(first.orders.length,0);assert.equal(first.state.pending[0].creationDate,r.attributes.creationDate);
 assert.doesNotMatch(JSON.stringify(first.state),/private|customer|deliveryAddress/);assert.equal(s.pending.length,0);
 const second=await stepKaspiHistory(JSON.parse(JSON.stringify(first.state)),{now:NOW,fetchEntries:async()=>lines});
 assert.equal(second.orders.length,1);assert.equal(second.orders[0].rows.length,2);assert.equal(second.orders[0].rows[0].qty,2);
 assert.equal(second.orders[0].rows.reduce((n,r)=>n+r.totalPrice,0),110);assert.equal(second.state.stateIndex,1);
 assert.equal(second.state.coveredFrom,s.coveredFrom);
});
test('coverage advances only after every state and every page, including confirmed empty states',async()=>{
 let s=initialKaspiHistory(NOW);s.from=s.goal;s.to=s.goal+10*DAY;const old=s.coveredFrom;
 for(let i=0;i<KASPI_HISTORY_STATES.length;i++){
  const r=await stepKaspiHistory(s,{now:NOW,fetchPage:async q=>{assert.equal(q.state,KASPI_HISTORY_STATES[i]);return page([])}});s=r.state;
  if(i<KASPI_HISTORY_STATES.length-1)assert.equal(s.coveredFrom,old);
 }
 assert.equal(s.coveredFrom,s.goal);assert.equal(s.complete,true);
 const restart=await stepKaspiHistory(s,{now:NOW+DAY,fetchPage:async q=>{assert.ok(q.to-q.from<14*DAY);return page([])}});
 assert.equal(restart.state.coveredFrom,s.goal);assert.equal(restart.state.mode,'refresh');
});
test('bad pages, missing compositions, missing status and duplicates cannot acknowledge coverage',async()=>{
 const s=initialKaspiHistory(NOW);
 for(const data of [{},{data:[],meta:{pageCount:4}}, {data:[raw()],meta:{}},{data:[raw({status:''})],meta:{pageCount:1}}])await assert.rejects(stepKaspiHistory(s,{now:NOW,fetchPage:async()=>data}),/Kaspi:/);
 const pending=(await stepKaspiHistory(s,{now:NOW,fetchPage:async()=>page([raw()])})).state;
 for(const entries of [[],[{id:'a',quantity:0,totalPrice:0}],[lines[0],lines[0]]])await assert.rejects(stepKaspiHistory(pending,{now:NOW,fetchEntries:async()=>entries}),/Kaspi:/);
 assert.equal(pending.pending.length,1);assert.equal(pending.coveredFrom,s.coveredFrom);
 const cancelled={...pending.pending[0],status:'CANCELLED'};assert.deepEqual(kaspiHistoryOrder(cancelled,[]).rows,[]);
});
test('multi-entry report merge replaces an entire archived order with live composition without losing other orders',()=>{
 const row=(orderId,entryId,totalPrice,market='Kaspi')=>({market,orderId,entryId,totalPrice,creationDate:1});
 const a=[row('a','1',10),row('a','2',20),row('b','1',30),row('a','x',40,'WB')];
 assert.equal(mergeReportingOrders([],a,100).length,4);
 const out=mergeReportingOrders([row('a','3',60),row('a','4',70)],a,100);
 assert.deepEqual(out.filter(r=>r.market==='Kaspi'&&r.orderId==='a').map(r=>r.entryId),['3','4']);assert.equal(out.length,4);
});
function fixture(input){
 let state=input?structuredClone(input):null,transaction=null;const queries=[],history=new Map();
 const db={release(){},async query(sql,args=[]){queries.push(sql);
  if(sql.includes('pg_try_advisory_lock'))return{rows:[{locked:true}]};
  if(sql.startsWith('SELECT payload FROM kaspi_order_history_state'))return{rows:state?[{payload:structuredClone(state)}]:[]};
  if(sql.includes('MIN(creation_date)'))return{rows:[{first:Date.parse('2026-07-01T00:00:00+05:00')}]};
  if(sql.startsWith('SELECT order_id,entry_id'))return{rows:[]};
  if(sql.startsWith('INSERT INTO kaspi_order_history_state')){state=JSON.parse(args[0]);return{rows:[]};}
  if(sql==='BEGIN'){transaction={state:structuredClone(state),history:new Map(history)};return{rows:[]};}
  if(sql==='ROLLBACK'&&transaction){state=transaction.state;history.clear();for(const [k,v]of transaction.history)history.set(k,v);transaction=null;return{rows:[]};}
  if(sql.startsWith('INSERT INTO kaspi_order_history(')){const inserted=!history.has(args[0]);history.set(args[0],JSON.parse(args[3]));return{rows:[{inserted}]};}
  return{rows:[]};
 }};
 return{client:{connect:async()=>db},db,queries,history,get state(){return state}};
}
test('worker reserves before upstream, persists 429 cooldown and resumes page without warehouse writes',async()=>{
 const f=fixture();let calls=0;
 await syncKaspiHistory({client:f.client,token:'fixture',now:NOW,fetcher:async()=>{calls++;assert.ok(f.state.nextAllowedAt>NOW);return{ok:false,status:429,headers:new Headers({'retry-after':'7200'})}}});
 assert.equal(calls,1);assert.ok(f.state.nextAllowedAt>=NOW+7200000);assert.equal(f.state.page,0);
 await syncKaspiHistory({client:f.client,token:'fixture',now:NOW+DAY/24,fetcher:async()=>assert.fail('cooldown survives restart')});assert.equal(calls,1);
 assert.ok(f.queries.every(sql=>!/(INSERT INTO|UPDATE|DELETE FROM) (marketplace_order_lines|warehouse|reservations)/.test(sql)));
});
test('a failed archive insert rolls back and keeps the exact pending page for retry',async()=>{
 const base=initialKaspiHistory(NOW),pending=(await stepKaspiHistory(base,{now:NOW,fetchPage:async()=>page([raw()])})).state;pending.nextAllowedAt=0;
 const f=fixture(pending),original=f.db.query;
 f.db.query=async(sql,args)=>{if(sql.startsWith('INSERT INTO kaspi_order_history('))throw Error('fixture insert failed');return original(sql,args)};
 await syncKaspiHistory({client:f.client,token:'fixture',now:NOW,fetcher:async url=>({ok:true,json:async()=>url.includes('merchantProduct')?{data:{attributes:{code:'toy',name:'Toy'}}}:{data:lines.map(e=>({id:e.id,attributes:e}))}})});
 assert.equal(f.history.size,0);assert.equal(f.state.page,0);assert.equal(f.state.pending.length,1);assert.equal(f.state.coveredFrom,base.coveredFrom);assert.ok(f.state.nextAllowedAt>=NOW+300000);
});
test('successful worker stores every entry, exact timestamps and only compact report data',async()=>{
 const f=fixture();const paths=[];
 const fetcher=async(url,options)=>{
  const u=new URL(url);paths.push(u.pathname);assert.equal(options.method,undefined);assert.equal(options.headers['X-Auth-Token'],'fixture');
  const data=u.pathname.endsWith('/orders')?page([raw({customer:{name:'private'}})]):u.pathname.endsWith('/entries')?{data:lines.map(e=>({id:e.id,attributes:e}))}:{data:{attributes:{code:'toy'}}};
  return{ok:true,json:async()=>data};
 };
 await syncKaspiHistory({client:f.client,token:'fixture',now:NOW,fetcher});assert.equal(f.state.pending.length,1);
 await syncKaspiHistory({client:f.client,token:'fixture',now:NOW+60000,fetcher});
 const saved=f.history.get('order-1');assert.equal(saved.rows.length,2);assert.equal(saved.rows.reduce((n,r)=>n+r.qty,0),3);assert.equal(saved.order.creationDate,raw().attributes.creationDate);assert.equal(saved.order.completionDate,raw().attributes.completionDate);
 assert.equal(f.state.rows,1);assert.doesNotMatch(JSON.stringify(saved),/private|customer/);assert.ok(paths.some(p=>p.endsWith('/entries')));
});
test('archive reads respect exact date bounds and store filters, with checked coverage even on empty periods',async()=>{
 const queries=[],client={async query(sql,args){queries.push({sql,args});return{rows:sql.includes('history_state')?[{payload:initialKaspiHistory(NOW)}]:[]}}};
 const r=await readKaspiHistory(client,100,200,null,15000);assert.equal(r.state.market,'Kaspi');assert.deepEqual(queries[0].args,[100,200,15000]);
 queries.length=0;await readKaspiHistory(client,100,200,'WB',15000);assert.equal(queries.length,1);assert.match(queries[0].sql,/history_state/);
});
