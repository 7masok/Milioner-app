import test from 'node:test';
import assert from 'node:assert/strict';
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
