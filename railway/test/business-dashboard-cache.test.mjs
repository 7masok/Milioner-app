import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {pool} from '../src/db.js';
import {reportsRouter} from '../src/reports.js';
import {businessCacheKey,validBusinessSnapshot,validBusinessDay,BUSINESS_CACHE_VERSION} from '../src/business-dashboard-cache.js';
const DAY=86400000,today=Math.floor((Date.now()+18000000)/DAY)*DAY-18000000,start=today-2*DAY;
function snapshot(begin=start){return{period:'day',bounds:{start:begin,end:begin+DAY},buckets:Array.from({length:24},(_,i)=>({start:begin+i*3600000,end:begin+(i+1)*3600000,orders:5,buyouts:4})),orders:{amount:120,qty:2,profit:10,orderCount:1,coverage:1},summary:{revenue:100,qty:2,profit:null},netProfit:null,hourly:{ozonHourlyComplete:false}}}
const model=()=>({...snapshot(),dayOffset:-2,yesterday:snapshot(start-DAY),yesterdayCompare:snapshot(start-DAY)});
let cached=null,marker={warehouse:1,orders:2},calls=[];
const revision=()=>crypto.createHash('sha256').update(JSON.stringify(marker)).digest('hex');
async function invoke(method,body=null,query={period:'day',start}){const route=reportsRouter.stack.find(x=>x.route?.path==='/business-dashboard-cache'&&x.route.methods[method]).route,handler=route.stack.at(-1).handle,old=pool.query;let status=200,out;calls=[];
 pool.query=async(sql,args)=>{calls.push({sql,args});if(sql.includes(' AS warehouse,'))return{rows:[marker]};if(sql.startsWith('SELECT version'))return{rows:cached?[cached]:[]};if(sql.startsWith('INSERT INTO business_dashboard_cache'))cached={version:args[1],source_revision:args[2],payload:JSON.parse(args[3]),generated_at:args[4]};return{rows:[]}};
 try{await handler({query,body},{status(n){status=n;return this},json(x){out=x}},e=>{throw e})}finally{pool.query=old}return{status,out,calls,route};}
test('cache stores only a bounded derived snapshot, preserving unknown profit and all source markers',async()=>{
 cached=null;const first=await invoke('get');assert.equal(first.out.snapshot,null);assert.equal(first.out.sourceRevision,revision());
 const put=await invoke('put',{period:'day',start,version:BUSINESS_CACHE_VERSION,sourceRevision:first.out.sourceRevision,snapshot:model()});assert.equal(put.status,200);assert.equal(put.route.stack.length,2);
 const get=await invoke('get');assert.equal(get.out.stale,false);assert.equal(get.out.snapshot.summary.profit,null);assert.equal(get.out.snapshot.yesterday.summary.profit,null);assert.equal(get.out.snapshot.hourly.ozonHourlyComplete,false);
 assert.ok(get.calls.every(x=>x.sql.startsWith('SELECT')));assert.ok(get.calls.every(x=>!x.sql.includes('FROM wb_finance_rows')));
 assert.ok(put.calls.filter(x=>/^(INSERT|DELETE|CREATE)/.test(x.sql)).every(x=>x.sql.includes('business_dashboard_cache')));
});
test('late source corrections mark the saved snapshot stale and reject a build made against old inputs',async()=>{
 const prior=revision();marker={...marker,orders:3};const get=await invoke('get');assert.equal(get.out.stale,true);assert.ok(get.out.snapshot);
 const rejected=await invoke('put',{period:'day',start,version:BUSINESS_CACHE_VERSION,sourceRevision:prior,snapshot:model()});assert.equal(rejected.status,409);assert.ok(rejected.calls.every(x=>!x.sql.startsWith('INSERT')));
});
test('snapshots crossing a day/week/month boundary require rebuilding, even inside historical cache TTL',async()=>{
 cached={version:BUSINESS_CACHE_VERSION,source_revision:revision(),payload:model(),generated_at:start+DAY-1000};const get=await invoke('get');assert.equal(get.out.stale,true);
});
test('wrong dates, versions, shapes, HTML and oversized snapshots are rejected before cache writes',async()=>{
 assert.equal(businessCacheKey('month',start),null);assert.equal(businessCacheKey('day',today+DAY),null);assert.equal(businessCacheKey('year',start),null);
 for(const patch of [{version:'old'},{start:start+1},{snapshot:{...model(),period:'week'}},{snapshot:{...model(),summary:{revenue:'fake',qty:1,profit:null}}},{snapshot:{...model(),label:'<img src=x onerror=alert(1)>'}},{snapshot:{...model(),big:'a'.repeat(600000)}}]){
  const r=await invoke('put',{period:'day',start,version:BUSINESS_CACHE_VERSION,sourceRevision:revision(),snapshot:model(),...patch});assert.equal(r.status,400);assert.equal(r.calls.length,0);
 }
 assert.equal(validBusinessSnapshot(model(),'day',start),true);
});
test('dashboard order-history reads both date bounds with parameters and exposes archive coverage',async()=>{
 const {ordersRouter}=await import('../src/orders.js'),handler=ordersRouter.stack.find(x=>x.route?.path==='/orders'&&x.route.methods.get).route.stack[0].handle,old=pool.query,queries=[];let out;
 pool.query=async(sql,args)=>{queries.push({sql,args});return{rows:sql.includes('MIN(creation_date)')?[{market:'Kaspi',from:1}]:[]}};
 try{await handler({query:{after:String(start),before:String(start+DAY),limit:'15000'}},{json(x){out=x}},e=>{throw e})}finally{pool.query=old}
 const q=queries.find(x=>x.sql.includes('FROM marketplace_order_lines o'));assert.match(q.sql,/o\.creation_date >= \$1/);assert.match(q.sql,/o\.creation_date < \$2/);assert.deepEqual(q.args,[start,start+DAY,15000]);assert.equal(out.historyCoverage[0].from,1);assert.ok(queries.every(x=>x.sql.startsWith('SELECT')));
});

let savedDays=[];
async function dailyInvoke(method,body=null,query={from:start,to:start+2*DAY}){
 const route=reportsRouter.stack.find(x=>x.route?.path==='/business-dashboard-days'&&x.route.methods[method]).route,old=pool.query,queries=[];let status=200,out;
 pool.query=async(sql,args)=>{queries.push({sql,args});if(sql.includes(' AS warehouse,'))return{rows:[marker]};if(sql.startsWith('SELECT cache_key'))return{rows:savedDays.filter(r=>args[0].includes(r.cache_key))};if(sql.startsWith('INSERT INTO business_dashboard_cache'))savedDays=JSON.parse(args[0]).map(r=>({cache_key:r.key,version:args[1],source_revision:args[2],payload:r.payload,generated_at:args[3]}));return{rows:[]}};
 try{await route.stack.at(-1).handle({query,body},{status(n){status=n;return this},json(x){out=x}},e=>{throw e})}finally{pool.query=old}return{status,out,queries,route};
}
test('shared days use one bounded aggregate batch and reuse it for any contained range',async()=>{
 savedDays=[];const get=await dailyInvoke('get');assert.deepEqual(get.out.days,[]);
 const days=[snapshot(),snapshot(start+DAY)];days[0].events=[[start+1000,120,2,10,1,120,2]];
 assert.equal(validBusinessDay(days[0]),true);
 const put=await dailyInvoke('put',{days,version:BUSINESS_CACHE_VERSION,sourceRevision:get.out.sourceRevision});assert.equal(put.status,200);assert.equal(put.route.stack.length,2);assert.equal(put.queries.filter(q=>q.sql.startsWith('INSERT')).length,1);assert.match(put.queries.find(q=>q.sql.startsWith('INSERT')).sql,/jsonb_array_elements/);
 const narrow=await dailyInvoke('get',null,{from:start,to:start+DAY});assert.equal(narrow.out.days.length,1);assert.equal(narrow.out.days[0].fresh,true);assert.equal(narrow.out.days[0].day.summary.profit,null);assert.deepEqual(narrow.out.days[0].day.events,days[0].events);assert.ok(narrow.queries.every(q=>q.sql.startsWith('SELECT')));
 const prior=revision();marker={...marker,finance:99};assert.equal((await dailyInvoke('get')).out.days[0].fresh,false);assert.equal((await dailyInvoke('put',{days,version:BUSINESS_CACHE_VERSION,sourceRevision:prior})).status,409);
 savedDays[0].generated_at=start+DAY-1;savedDays[0].source_revision=revision();assert.equal((await dailyInvoke('get')).out.days[0].fresh,false);
});
test('shared day writes reject duplicate days, HTML, unknown shape, excessive ranges and old versions',async()=>{
 for(const patch of [{days:[snapshot(),snapshot()]},{days:[{...snapshot(),summary:{revenue:null,qty:2,profit:null}}]},{days:[{...snapshot(),label:'<script>'}]},{version:'calendar-v1'},{days:Array(65).fill(snapshot())}]){const out=await dailyInvoke('put',{days:[snapshot()],version:BUSINESS_CACHE_VERSION,sourceRevision:revision(),...patch});assert.equal(out.status,400);assert.equal(out.queries.length,0)}
 for(const query of [{from:start+1,to:start+DAY},{from:start-367*DAY,to:start},{from:today,to:today+2*DAY}]){const out=await dailyInvoke('get',null,query);assert.equal(out.status,400);assert.equal(out.queries.length,0)}
});

test('daily cache accepts previous-year history beyond 400 days without relaxing range or shape validation',async()=>{
 savedDays=[];const old=today-650*DAY,read=await dailyInvoke('get',null,{from:old,to:old+DAY});
 assert.equal(read.status,200);assert.equal(businessCacheKey('day',old),'day:'+old);
 const put=await dailyInvoke('put',{days:[snapshot(old)],version:BUSINESS_CACHE_VERSION,sourceRevision:read.out.sourceRevision});
 assert.equal(put.status,200);assert.ok(put.queries.some(q=>q.sql.startsWith('INSERT')));
});


test('saving an overview retains the same 5000 derived records as saving shared days',async()=>{
 const overview=await invoke('put',{period:'day',start,version:BUSINESS_CACHE_VERSION,sourceRevision:revision(),snapshot:model()});
 const days=await dailyInvoke('put',{days:[snapshot()],version:BUSINESS_CACHE_VERSION,sourceRevision:revision()});
 for(const queries of [overview.calls,days.queries])assert.match(queries.find(q=>q.sql.startsWith('DELETE FROM business_dashboard_cache')).sql,/LIMIT 5000/);
});

test('month batch reads only bounded compact saved month totals, including a known previous month',async()=>{
 const makeMonth=(year,month)=>{const begin=Date.UTC(year,month,1)-18000000,end=Date.UTC(year,month+1,1)-18000000;return{...snapshot(begin),period:'month',bounds:{start:begin,end},buckets:Array.from({length:(end-begin)/DAY},(_,i)=>({start:begin+i*DAY,end:begin+(i+1)*DAY,orders:5,buyouts:4})),pending:false}};
 const year=new Date(today+18000000).getUTCFullYear()-1,current=makeMonth(year,8),previous=makeMonth(year,7),payload={...current,yesterday:previous,yesterdayCompare:previous};
 const route=reportsRouter.stack.find(x=>x.route?.path==='/business-dashboard-months').route,old=pool.query,queries=[];let out,status=200;
 pool.query=async(sql,args)=>{queries.push({sql,args});return{rows:sql.includes(' AS warehouse,')?[marker]:sql.startsWith('SELECT cache_key')?[{cache_key:'month:'+current.bounds.start,version:BUSINESS_CACHE_VERSION,source_revision:revision(),payload,generated_at:Date.now()}]:[]}};
 try{await route.stack.at(-1).handle({query:{from:Date.UTC(year,0,1)-18000000,to:Date.UTC(year+2,0,1)-18000000}},{status(n){status=n;return this},json(x){out=x}},e=>{throw e})}finally{pool.query=old}
 assert.equal(status,200);assert.equal(out.months.length,2);assert.ok(out.months.every(x=>!x.month.yesterday&&!x.month.events));assert.equal(out.sourceRevision,revision());
 assert.ok(queries.every(q=>!/FROM (wb_finance_rows|marketplace_order_lines)/.test(q.sql)));assert.equal(queries.find(q=>q.sql.startsWith('SELECT cache_key')).args[0].length,24);
 let rejected;await route.stack.at(-1).handle({query:{from:today,to:today+1000*DAY}},{status(n){rejected=n;return this},json(){}},e=>{throw e});assert.equal(rejected,400);
});


test('confirmed order-only snapshots persist unknown finance and cannot masquerade as completed financial days',async()=>{
 const partial={...snapshot(),pending:true,ordersReady:true,summary:{revenue:null,qty:null,profit:null}},screen={...partial,yesterday:snapshot(start-DAY),yesterdayCompare:snapshot(start-DAY)};
 assert.equal(validBusinessDay(partial),true);assert.equal(validBusinessDay({...partial,ordersReady:false}),false);
 const put=await invoke('put',{period:'day',start,version:BUSINESS_CACHE_VERSION,sourceRevision:revision(),snapshot:screen});assert.equal(put.status,200);
 const read=await invoke('get');assert.equal(read.out.snapshot.orders.amount,120);assert.equal(read.out.snapshot.summary.revenue,null);assert.equal(read.out.stale,true);
 const daily=await dailyInvoke('put',{days:[partial],version:BUSINESS_CACHE_VERSION,sourceRevision:revision()});assert.equal(daily.status,200);
 const get=await dailyInvoke('get');assert.equal(get.out.days[0].day.ordersReady,true);assert.equal(get.out.days[0].fresh,false);
});

test('store-specific screen and day cache keys cannot overwrite All or another store',async()=>{
 const screen=await invoke('put',{market:'WB',period:'day',start,version:BUSINESS_CACHE_VERSION,sourceRevision:revision(),snapshot:model()});assert.equal(screen.status,200);assert.equal(screen.calls.find(q=>q.sql.startsWith('INSERT')).args[0],'day:'+start+':WB');
 const query=await invoke('get',null,{market:'Kaspi',period:'day',start});assert.equal(query.calls.find(q=>q.sql.startsWith('SELECT version')).args[0],'day:'+start+':Kaspi');
 savedDays=[];const put=await dailyInvoke('put',{market:'WB',days:[snapshot()],version:BUSINESS_CACHE_VERSION,sourceRevision:revision()});assert.equal(put.status,200);assert.equal(savedDays[0].cache_key,'base:'+start+':WB');
 assert.equal((await dailyInvoke('get',null,{market:'WB',from:start,to:start+DAY})).out.days.length,1);assert.equal((await dailyInvoke('get',null,{market:'Kaspi',from:start,to:start+DAY})).out.days.length,0);assert.equal((await dailyInvoke('get')).out.days.length,0);
 assert.equal((await dailyInvoke('get',null,{market:'invalid',from:start,to:start+DAY})).status,400);
});

function storeRow(m,begin,amount,at=Date.now(),starts={}){
 const day={...snapshot(begin),market:m,storeStarts:JSON.stringify(starts),ordersReady:true,pending:false,orders:{amount,qty:1,profit:amount/5,orderCount:1,coveredAmount:amount/2,coveredQty:.5,coverage:.5},events:[[begin+1000,amount,1,amount/5,1,amount/2,.5]],summary:{revenue:amount/2,qty:1,profit:amount/10}};
 for(const h of day.buckets){h.orders=0;h.orderQty=0;h.orderProfit=0;h.buyouts=0;h.buyoutQty=0;h.buyoutProfit=0}Object.assign(day.buckets[0],{orders:amount,orderQty:1,orderProfit:amount/5,buyouts:amount/2,buyoutQty:1,buyoutProfit:amount/10});
 return {cache_key:'base:'+begin+':'+m,version:BUSINESS_CACHE_VERSION,source_revision:revision(),payload:day,generated_at:at};
}
const markets=['Kaspi','WB','WB2','Ozon'];
test('All day route composes four persisted stores in one bounded read without writes or provider queries',async()=>{
 const begin=today-10*DAY;savedDays=markets.map((m,i)=>storeRow(m,begin,(i+1)*10));const {out,queries}=await dailyInvoke('get',null,{from:begin,to:begin+DAY});
 assert.equal(out.days.length,1);const row=out.days[0],d=row.day;assert.equal(row.composed,true);assert.equal(row.reusable,true);assert.equal(d.market,'all');assert.equal(d.orders.amount,100);assert.equal(d.orders.coverage,.5);assert.equal(d.orders.qty,4);assert.equal(d.orders.orderCount,4);assert.equal(d.summary.revenue,50);assert.equal(d.summary.profit,10);assert.equal(d.buckets[0].orders,100);assert.equal(d.events.length,1);assert.deepEqual(d.events[0],[begin+1000,100,4,20,4,50,2]);assert.equal(validBusinessDay(d),true);
 assert.equal(queries.find(q=>q.sql.startsWith('SELECT cache_key')).args[0].length,5);assert.ok(queries.every(q=>q.sql.startsWith('SELECT')));assert.ok(queries.every(q=>!q.sql.includes('FROM marketplace_order_lines')&&!q.sql.includes('FROM wb_finance_rows')));
});
test('missing store days and stale opening signatures never become zero; complete All fallback survives partial finance',async()=>{
 const {composeBusinessDays}=await import('../src/business-dashboard-cache.js'),begin=today-10*DAY,rows=markets.map((m,i)=>storeRow(m,begin,(i+1)*10));
 assert.equal(composeBusinessDays(rows.slice(1),begin,begin+DAY,{},revision()).length,0);
 const warehouse=JSON.stringify({settings:{reportStoreStarts:{WB:'2020-01-01'}}});assert.equal(composeBusinessDays(rows,begin,begin+DAY,warehouse,revision()).length,0);
 rows[0].payload.pending=true;rows[0].payload.summary={revenue:null,qty:null,profit:null};let composed=composeBusinessDays(rows,begin,begin+DAY,{},revision())[0];assert.equal(composed.day.ordersReady,true);assert.equal(composed.day.pending,true);assert.equal(composed.day.summary.profit,null);assert.equal(composed.reusable,false);
 const ready={...storeRow('all',begin,999),cache_key:'base:'+begin};delete ready.payload.ordersReady;composed=composeBusinessDays([...rows,ready],begin,begin+DAY,{},revision())[0];assert.equal(composed.day.orders.amount,999);assert.equal(composed.day.pending,false);assert.equal(composed.composed,undefined);
});
test('confirmed pre-opening stores contribute zero from current TEXT settings without inventing a missing active store',async()=>{
 const {composeBusinessDays}=await import('../src/business-dashboard-cache.js'),begin=today-10*DAY,starts={Ozon:new Date(today-DAY+18000000).toISOString().slice(0,10)},warehouse=JSON.stringify({settings:{reportStoreStarts:starts}}),rows=markets.slice(0,3).map(m=>storeRow(m,begin,10,Date.now(),{}));
 const d=composeBusinessDays(rows,begin,begin+DAY,warehouse,revision())[0].day;assert.equal(d.orders.amount,30);assert.equal(d.summary.revenue,15);assert.equal(d.storeStarts,JSON.stringify(starts));assert.equal(d.ordersReady,true);assert.equal(d.pending,false);assert.equal(composeBusinessDays(rows.slice(1),begin,begin+DAY,warehouse,revision()).length,0);
});
test('All preserves unknown profit, weighted coverage and oldest input time through stale revisions',async()=>{
 const {composeBusinessDays}=await import('../src/business-dashboard-cache.js'),begin=today-10*DAY,rows=markets.map((m,i)=>storeRow(m,begin,(i+1)*10));rows[0].payload.summary.profit=null;rows[1].payload.orders.coveredAmount=0;rows[1].payload.orders.coverage=0;rows[2].generated_at=begin+DAY-1;rows[2].source_revision='old';
 const result=composeBusinessDays(rows,begin,begin+DAY,{},revision())[0];assert.equal(result.day.summary.profit,null);assert.equal(result.day.netProfit,null);assert.equal(result.day.orders.coverage,.4);assert.equal(result.generatedAt,begin+DAY-1);assert.equal(result.fresh,false);assert.equal(result.reusable,false);assert.equal(result.day.hourly.ozonHourlyComplete,false);
});
