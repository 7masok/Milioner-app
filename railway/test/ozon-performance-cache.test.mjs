import test from 'node:test';
import assert from 'node:assert/strict';
import {createPerformanceCache} from '../src/ozon-performance-cache.js';
const day='2026-10-11';
function setup(build,store=new Map()){
 let time=Date.parse('2026-10-19T12:00:00Z');const options={read:async key=>structuredClone(store.get(key)),write:async(key,value)=>store.set(key,structuredClone(value)),scope:()=> 'seller',now:()=>time,build};
 return {store,cache:createPerformanceCache(options),restart:()=>createPerformanceCache(options),advance:n=>time+=n};
}
test('cold reads return pending without waiting for the external report, and concurrent reads share one build',async()=>{
 let resolve,calls=0;const s=setup(()=>{calls++;return new Promise(r=>resolve=r)});
 const results=await Promise.all([s.cache.get(day,day),s.cache.get(day,day)]);assert.ok(results.every(r=>r.pending));await new Promise(r=>setImmediate(r));assert.equal(calls,1);resolve({rows:[{sku:'1',spent:20}],totalSpent:20});await s.cache.settled();const ready=await s.cache.get(day,day);assert.equal(ready.pending,false);assert.equal(ready.totalSpent,20);
});
test('successful exact-period SKU reports survive restart and never leak into a different date range',async()=>{
 let calls=0;const s=setup(async()=>{calls++;return {rows:[{sku:'1',spent:20}],totalSpent:20}});await s.cache.get(day,day);await s.cache.settled();const restored=await s.restart().get(day,day);assert.equal(restored.totalSpent,20);assert.equal(calls,1);assert.equal((await s.cache.get('2026-10-12','2026-10-12')).pending,true);await s.cache.settled();assert.equal(calls,2);
});
test('429 preserves the last successful snapshot and persists a cooldown across restart and other periods',async()=>{
 let fail=false,calls=0;const s=setup(async()=>{calls++;if(fail)throw Object.assign(Error('Лимит'),{code:'RATE_LIMIT',retryAt:Date.parse('2026-10-20T12:00:00Z')});return {rows:[{sku:'1',spent:20}],totalSpent:20}});
 await s.cache.get(day,day);await s.cache.settled();s.advance(7*60*60*1000);fail=true;assert.equal((await s.cache.get(day,day)).totalSpent,20);await s.cache.settled();const restored=s.restart(),old=await restored.get(day,day);assert.equal(old.totalSpent,20);assert.equal(old.stale,true);assert.equal(old.error,'Лимит');assert.equal(old.pending,false);const other=await restored.get('2026-10-12','2026-10-12');assert.equal(other.pending,false);assert.equal(other.error,'Лимит');await restored.settled();assert.equal(calls,2);
});
test('queued periods do not call Ozon after an earlier job hits the shared quota',async()=>{
 let calls=0;const s=setup(async()=>{calls++;throw Object.assign(Error('Daily quota'),{code:'DAILY_LIMIT',retryAt:Date.parse('2026-10-20T12:00:00Z')})});await Promise.all([s.cache.get(day,day),s.cache.get('2026-10-12','2026-10-12')]);await s.cache.settled();assert.equal(calls,1);assert.equal((await s.cache.get(day,day)).limited,true);
});
test('a transient failure retries only after its saved deadline and accepts a confirmed zero report',async()=>{
 let calls=0;const s=setup(async()=>{if(++calls===1)throw Error('timeout');return{rows:[],totalSpent:0}});await s.cache.get(day,day);await s.cache.settled();const failed=await s.cache.get(day,day);assert.equal(failed.pending,false);assert.equal(calls,1);s.advance(6*60*1000);await s.cache.get(day,day);await s.cache.settled();const ready=await s.cache.get(day,day);assert.deepEqual(ready.rows,[]);assert.equal(ready.pending,false);assert.equal(ready.error,undefined);assert.equal(calls,2);
});

test('a saved provider deadline retries in the background without another browser read or bypassing the shared cooldown',async()=>{
 let time=Date.parse('2026-10-20T09:00:00Z'),calls=0,timerId=0;const db=new Map(),timers=new Map();
 const cache=createPerformanceCache({scope:()=> 'seller',now:()=>time,read:async k=>db.get(k),write:async(k,v)=>db.set(k,structuredClone(v)),schedule:(fn,delay)=>{timers.set(++timerId,{fn,at:time+delay});return timerId},cancel:id=>timers.delete(id),build:async()=>{if(++calls===1)throw Object.assign(Error('quota'),{code:'DAILY_LIMIT',retryAt:time+18*3600000});return {rows:[{sku:'100',spent:123}],totalSpent:123}}});
 await cache.get(day,day);await cache.settled();assert.equal(calls,1);
 const failed=await cache.get(day,day);assert.equal(failed.limited,true);assert.equal(failed.pending,false);
 const request=[...timers.values()][0];time=request.at-1;assert.equal(calls,1);
 time++;timers.clear();request.fn();await cache.settled();assert.equal(calls,2);
 const ready=await cache.get(day,day);assert.equal(ready.totalSpent,123);assert.equal(ready.pending,false);assert.equal(ready.error,undefined);
});
