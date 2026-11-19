import test from 'node:test';
import assert from 'node:assert/strict';
import {createKaspiIdentityCollector,decorateKaspiIdentities} from '../src/kaspi-product-identities.js';

function fixture(options={}){
 let cache=null,token='test-token',at=1800000000000;const calls=[],changes=[];
 const service=createKaspiIdentityCollector({token:async()=>token,read:async()=>cache,write:async(value,changed)=>{changes.push(changed);cache=structuredClone(value)},
  list:async()=>[{sku:'897281226',entryId:'entry/opaque'}],pause:async()=>{},now:()=>at,
  fetchImpl:async(url,request)=>{
   calls.push(url);assert.equal(request.headers['X-Auth-Token'],'test-token');assert.equal(request.redirect,'error');
   if(options.status)return new Response('',{status:options.status,headers:{'Retry-After':'3600'}});
   return Response.json({data:url.includes('/orderentries/')
    ?{type:'masterproducts',id:'master/opaque',attributes:{code:'186427214'}}
    :{type:'merchantproducts',attributes:{code:options.mismatch?'wrong':'897281226'}}});
  },...options.dependencies});
 return {service,calls,changes,get cache(){return cache},changeToken(value){token=value},advance(ms){at+=ms}};
}
test('two official reads confirm catalog code to seller SKU without changing stock or ad amounts',async()=>{
 const f=fixture();await f.service.collect();
 assert.deepEqual(f.calls.map(url=>new URL(url).pathname),[
  '/shop/api/v2/orderentries/entry%2Fopaque/product','/shop/api/v2/masterproducts/master%2Fopaque/merchantProduct']);
 const snapshot=await f.service.snapshot();assert.deepEqual(snapshot.items,[{productCode:'186427214',merchantSkus:['897281226'],checkedAt:1800000000000}]);
 assert.equal(snapshot.pending,0);assert.deepEqual(f.changes,[true]);assert.ok(!JSON.stringify(snapshot).includes('test-token'));
 await f.service.collect();assert.equal(f.calls.length,2);
 const batches=[{id:'a',amount:10,lines:[{sku:'186427214',amount:10},{sku:'unknown',amount:20,kaspiMerchantSkus:['forged']}]}],before=JSON.stringify(batches);
 const enriched=decorateKaspiIdentities(batches,snapshot.items);
 assert.equal(JSON.stringify(batches),before);assert.equal(enriched[0].lines[0].sku,'186427214');assert.equal(enriched[0].lines[0].amount,10);
 assert.deepEqual(enriched[0].lines[0].kaspiMerchantSkus,['897281226']);assert.equal(enriched[0].lines[1].kaspiMerchantSkus,undefined);
 f.changeToken('another-account');assert.equal((await f.service.snapshot()).items.length,0);
});
test('mismatched seller SKU never creates a link, and provider cooldown survives another collection',async()=>{
 const f=fixture({mismatch:true});await f.service.collect();assert.equal((await f.service.snapshot()).items.length,0);assert.deepEqual(f.changes,[false]);
 await f.service.collect();assert.equal(f.calls.length,2);
 const limited=fixture({status:429});await limited.service.collect();assert.equal(limited.calls.length,1);
 assert.ok(limited.cache.retryAt>=1800000000000+3600000);
 await limited.service.collect();assert.equal(limited.calls.length,1);
});
test('unsold warehouse offers are diagnosed without speculative provider requests',async()=>{
 const f=fixture({dependencies:{list:async()=>[{sku:'unsold',entryId:''}]}});
 await f.service.collect();assert.equal(f.calls.length,0);assert.equal((await f.service.snapshot()).pending,0);
 assert.deepEqual(await f.service.diagnostics(),[{merchantSku:'unsold',productCode:'',status:'no-order-entry'}]);
 const confirmed=fixture();await confirmed.service.collect();
 assert.deepEqual(await confirmed.service.diagnostics(),[{merchantSku:'897281226',productCode:'186427214',status:'confirmed'}]);
 assert.ok(!JSON.stringify(await confirmed.service.diagnostics()).includes('opaque'));
});
