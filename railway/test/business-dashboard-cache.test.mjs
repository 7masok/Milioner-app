import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {pool} from '../src/db.js';
import {reportsRouter} from '../src/reports.js';
import {businessCacheKey,validBusinessSnapshot,BUSINESS_CACHE_VERSION} from '../src/business-dashboard-cache.js';
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
