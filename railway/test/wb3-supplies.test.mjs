import test from 'node:test';
import assert from 'node:assert/strict';
import {readWb3Supplies} from '../src/wb3-supplies.js';
test('supply reads preserve permission failures and obey retry windows',async()=>{
 let calls=0;
 const fetchImpl=async(url,options)=>{
  calls++;assert.match(url,/supplies-api\.wildberries\.ru\/api\/v1\/supplies/);
  assert.equal(options.method,'POST');assert.deepEqual(JSON.parse(options.body),{dates:[],statusIDs:[]});
  return new Response('{}',{status:403});
 };
 const first=await readWb3Supplies({fetchImpl,tokenFor:async()=> 'fixture-token',now:1000});
 assert.equal(first.ok,false);assert.equal(first.status,403);assert.match(first.error,/Поставки/);
 const again=await readWb3Supplies({fetchImpl,tokenFor:async()=> 'fixture-token',now:2000});
 assert.equal(again,first);assert.equal(calls,1);
 const ready=await readWb3Supplies({fetchImpl:async()=>new Response('[{"supplyID":123,"statusID":2}]'),tokenFor:async()=> 'fixture-token',now:first.nextAt+1});
 assert.equal(ready.ok,true);assert.equal(ready.supplies[0].supplyID,123);
});
