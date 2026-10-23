import test from 'node:test';
import assert from 'node:assert/strict';
import {createPerformanceCache} from '../src/ozon-performance-cache.js';
import {createPerformanceDaily} from '../src/ozon-performance-daily.js';
function fixture(store=new Map()){
 let time=Date.parse('2026-10-21T12:00:00+05:00'),scope='seller',fail=null,calls=[];
 const options={scope:()=>scope,read:async k=>structuredClone(store.get(k)),write:async(k,v)=>store.set(k,structuredClone(v)),readDays:async(from,to)=>new Map([...store].filter(([k])=>k.startsWith(scope+':2026')&&k.split(':')[1]===k.split(':')[2]&&k.split(':')[1]>=from&&k.split(':')[1]<=to).map(([k,v])=>[k.split(':')[1],structuredClone(v)])),now:()=>time,schedule:()=>({unref(){}}),cancel(){},settled:async()=>{},loadDay:async(day,{force=false}={})=>{const key=scope+':'+day+':'+day;const old=store.get(key);if(old?.data&&!force)return old.data;calls.push(day);if(fail){store.set(scope+':cooldown',{error:'quota',retryAt:time+3600000,limited:true});return{pending:false,error:'quota',retryAt:time+3600000}}const data={from:day,to:day,rows:[{sku:'p',spent:Number(day.slice(-2)),orders:1}],totalSpent:Number(day.slice(-2))};store.set(key,{data,at:time});return data}};
 return{store,calls,cache:createPerformanceDaily(options),restart:()=>createPerformanceDaily(options),advance:n=>time+=n,scope:s=>scope=s,fail:()=>fail=true};
}
test('overlapping periods reuse saved daily reports and aggregate exact SKU amounts after restart',async()=>{
 const f=fixture();assert.equal((await f.cache.get('2026-10-10','2026-10-12')).pending,true);for(let i=0;i<3;i++)await f.cache.tick();const ready=await f.cache.get('2026-10-10','2026-10-12');assert.equal(ready.pending,false);assert.equal(ready.totalSpent,33);assert.equal(ready.daily.length,3);assert.deepEqual(f.calls,['2026-10-12','2026-10-11','2026-10-10']);
 const restart=f.restart();const narrow=await restart.get('2026-10-11','2026-10-12');assert.equal(narrow.totalSpent,23);assert.equal(f.calls.length,3);
 await restart.get('2026-10-10','2026-10-13');await restart.tick();assert.equal((await restart.get('2026-10-10','2026-10-13')).totalSpent,46);assert.equal(f.calls.length,4);assert.equal(f.calls.at(-1),'2026-10-13');
 f.advance(30*86400000);assert.equal((await restart.get('2026-10-10','2026-10-13')).totalSpent,46);assert.equal(f.calls.length,4);
});
test('a failed day never becomes a zero or a complete multi-day total, and shared cooldown is reported',async()=>{
 const f=fixture();await f.cache.get('2026-10-10','2026-10-12');await f.cache.tick();f.fail();await f.cache.tick();const data=await f.cache.get('2026-10-10','2026-10-12');assert.equal(data.error,'quota');assert.equal(data.coveredDays,1);assert.equal(data.totalDays,3);assert.deepEqual(data.rows,[]);assert.equal(data.pending,false);
});
test('legacy exact-range success remains visible during daily warming but never leaks to changed dates',async()=>{
 const f=fixture();f.store.set('seller:2026-10-10:2026-10-12',{data:{rows:[{sku:'p',spent:123}],totalSpent:123},at:1});const exact=await f.cache.get('2026-10-10','2026-10-12');assert.equal(exact.totalSpent,123);assert.equal(exact.refreshing,true);const changed=await f.cache.get('2026-10-10','2026-10-13');assert.equal(changed.pending,true);assert.deepEqual(changed.rows,[]);
});
test('persisted priority queue resumes without the browser and recent days get refreshed before archival backfill',async()=>{
 const f=fixture();await f.cache.get('2026-10-10','2026-10-11');const restarted=f.restart();await restarted.tick();await restarted.tick();assert.deepEqual(f.calls,['2026-10-11','2026-10-10']);await restarted.tick();assert.equal(f.calls.at(-1),'2026-10-21');await restarted.tick();await restarted.tick();await restarted.tick();assert.equal(f.calls.at(-1),'2026-10-18');
});

test('week to day remains available after TTL, during quota and after restart',async()=>{
 const f=fixture();await f.cache.get('2026-10-19','2026-10-21');for(let i=0;i<3;i++)await f.cache.tick();
 assert.equal((await f.cache.get('2026-10-19','2026-10-21')).totalSpent,60);
 f.advance(20*60000);assert.equal((await f.restart().get('2026-10-21','2026-10-21')).totalSpent,21);assert.equal(f.calls.length,3);
 f.advance(7*3600000);f.store.set('seller:cooldown',{error:'quota',retryAt:Date.parse('2026-10-23T00:00:00Z'),limited:true});
 const restarted=f.restart(),day=await restarted.get('2026-10-20','2026-10-20');
 assert.equal(day.totalSpent,20);assert.equal(day.coveredDays,1);assert.equal(day.stale,true);assert.equal(day.error,'quota');assert.equal(day.pending,false);
 assert.equal((await restarted.get('2026-10-19','2026-10-21')).totalSpent,60);
 await restarted.tick();assert.equal(f.calls.length,3,'cooldown must not cause another provider job');
});
test('missing days are filled before refreshing stale days in the same requested week',async()=>{
 const f=fixture();await f.cache.get('2026-10-19','2026-10-21');await f.cache.tick();
 f.advance(7*3600000);await f.cache.tick();assert.deepEqual(f.calls,['2026-10-21','2026-10-20']);
 await f.cache.tick();assert.equal(f.calls.at(-1),'2026-10-19');
 assert.equal((await f.cache.get('2026-10-19','2026-10-21')).totalSpent,60);
});

test('real exact cache integration retains day sums through expiry, restart and failed refresh',async()=>{
 const db=new Map();let time=Date.parse('2026-10-23T12:00:00+05:00'),calls=0,fail=false;
 const read=async key=>structuredClone(db.get(key)),write=async(key,value)=>db.set(key,structuredClone(value));
 const readDays=async(from,to)=>new Map([...db].filter(([k])=>/^seller:2026-\d\d-\d\d:2026/.test(k)&&k.split(':')[1]>=from&&k.split(':')[1]<=to).map(([k,v])=>[k.split(':')[1],structuredClone(v)]));
 function restart(){const exact=createPerformanceCache({scope:()=> 'seller',read,write,now:()=>time,automaticRetry:false,build:async(from,to)=>{calls++;if(fail)throw Object.assign(Error('quota'),{code:'DAILY_LIMIT',retryAt:time+DAY});return{from,to,rows:[{sku:'p',spent:Number(from.slice(-2))}],totalSpent:Number(from.slice(-2))}}});return createPerformanceDaily({scope:()=> 'seller',read,write,readDays,now:()=>time,schedule:()=>({unref(){}}),cancel(){},loadDay:(day,o)=>exact.get(day,day,o),settled:()=>exact.settled()})}
 const DAY=86400000,first=restart();await first.get('2026-10-16','2026-10-22');for(let i=0;i<7;i++)await first.tick();
 assert.equal(calls,7);assert.equal((await first.get('2026-10-16','2026-10-22')).totalSpent,133);
 time+=7*3600000;fail=true;const second=restart();await second.get('2026-10-16','2026-10-22');await second.tick();
 // The missing current day hits quota; all seven previously saved days remain readable.
 const week=await second.get('2026-10-16','2026-10-22');assert.equal(week.totalSpent,133);assert.equal(week.coveredDays,7);assert.equal(week.stale,true);
 for(let d=16;d<=22;d++){const day='2026-10-'+d,result=await second.get(day,day);assert.equal(result.totalSpent,d);assert.equal(result.pending,false)}
 const atQuota=calls;await second.tick();assert.equal(calls,atQuota);
});
