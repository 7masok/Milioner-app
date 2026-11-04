import test from 'node:test';
import assert from 'node:assert/strict';
import {syncWbSupplies,enableSupplyState} from '../src/wb3-supply-sync.js';
function fixture(initial={}){
 let stored=structuredClone(initial),now=Date.parse('2026-11-04T18:00:00Z'),calls=0,reconciles=0;
 const db={async query(sql,args){if(sql.includes('pg_try_advisory_lock'))return {rows:[{locked:true}]};if(sql.startsWith('SELECT payload'))return {rows:[{payload:structuredClone(stored)}]};if(sql.startsWith('UPDATE wb3_supply_sync'))stored=JSON.parse(args[0]);return {rows:[]}},release(){}};
 const options={profile:'WB3',dbPool:{async connect(){return db}},ensure:async()=>{},tokenFor:async()=> 'fixture-token',clock:()=>now,reconcile:async()=>{reconciles++}};
 return {options,get stored(){return stored},set stored(s){stored=s},advance(ms){now+=ms},get calls(){return calls},fetch(fn){options.fetchImpl=async(...args)=>{calls++;return fn(...args)}}};
}
test('collector persists list, sends goods request next, and never refetches on an idle tick or restart',async()=>{
 const f=fixture();f.fetch((url,opts)=>{assert.match(url,/\/api\/v1\/supplies\?/);assert.equal(opts.method,'POST');return new Response(JSON.stringify([{preorderID:123,statusID:2}]),{headers:{'x-ratelimit-limit':'30'}})});
 await syncWbSupplies(f.options);assert.equal(f.calls,1);f.stored=enableSupplyState(f.stored,f.stored.listAt);await syncWbSupplies(f.options);assert.equal(f.calls,1);
 f.advance(3000);f.fetch((url,opts)=>{assert.match(url,/\/supplies\/123\/goods\?isPreorderID=true&limit=1000&offset=0/);assert.equal(opts.method,'GET');return new Response('[{"barcode":"123","quantity":2}]',{headers:{'x-ratelimit-limit':'30'}})});
 await syncWbSupplies(f.options);assert.equal(f.calls,2);assert.equal(f.stored.goods['preorder:123'].rows[0].quantity,2);
 f.advance(3000);await syncWbSupplies({...f.options});assert.equal(f.calls,2);
});
test('basic token advances to goods after 30 minutes rather than starving goods with another list',async()=>{
 const f=fixture();f.fetch(()=>new Response('[{"preorderID":123,"statusID":2}]'));
 await syncWbSupplies(f.options);f.stored=enableSupplyState(f.stored,f.stored.listAt);f.advance(1800001);
 f.fetch(url=>{assert.match(url,/\/123\/goods/);return new Response('[]')});await syncWbSupplies(f.options);assert.equal(f.calls,2);
});
test('Retry-After survives a fresh worker instance and prevents immediate retry',async()=>{
 const f=fixture();f.fetch(()=>new Response('{}',{status:429,headers:{'retry-after':'7200'}}));await syncWbSupplies(f.options);const next=f.stored.nextAt;assert.equal(next,Date.parse('2026-11-04T20:00:00Z'));
 f.advance(3600000);await syncWbSupplies({...f.options});assert.equal(f.calls,1);assert.match(f.stored.error,/429/);
});
test('incomplete list pagination never publishes a partial baseline',async()=>{
 const f=fixture();f.fetch(()=>new Response(JSON.stringify(Array.from({length:1000},(_,i)=>({preorderID:i+1,statusID:5}))),{headers:{'x-ratelimit-limit':'30'}}));await syncWbSupplies(f.options);
 assert.equal(f.stored.listOffset,1000);assert.equal(f.stored.listAt,undefined);assert.throws(()=>enableSupplyState(f.stored,Date.now()));
 f.advance(3000);f.fetch(url=>{assert.match(url,/offset=1000/);return new Response('[]',{headers:{'x-ratelimit-limit':'30'}})});await syncWbSupplies(f.options);assert.equal(f.stored.supplies.length,1000);assert.ok(f.stored.listAt);
});
