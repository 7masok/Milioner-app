import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createUnifiedWarehouseRouter} from '../src/unified-warehouse.js';
import {mergeWarehouses,splitWarehouses,LISTS,combinedRevision,applyUnifiedPatch,warehouseDelta,scopeApiValue} from '../src/unified-warehouse-model.js';

function state(name){return {...Object.fromEntries(LISTS.map(k=>[k,[]])),products:[{id:'same',name,stock:10,wb:'SKU',wbVariant:{market:'WB',nmId:'123',chrtId:456}}],settings:{name}};}
test('colliding IDs, FIFO references, packaging and ignored purchase plans round-trip to their original warehouse',()=>{
 const main=state('main'),child=state('Inferno');
 child.purchases=[{id:'purchase',productId:'same',qty:10}];child.products[0].packagingRecipe=[{packagingId:'pack',qty:1,scope:'item'}];
 child.settings.purchasePlanIgnored={same:{hidden:true}};child.settings.packagingV1={items:[{id:'pack',stock:3}],movements:[{id:'m',packagingId:'pack',qty:3}]};
 const combined=mergeWarehouses(main,child);assert.equal(combined.products[1].id,'inferno:same');assert.equal(combined.products[1].wb3,'SKU');assert.equal(combined.products[0].wb,'SKU');assert.equal(combined.purchases[0].productId,'inferno:same');
 const split=splitWarehouses(combined,child);assert.deepEqual(split.inferno,child);assert.deepEqual(split.main.products,main.products);assert.equal(split.main.purchases.length,0);assert.equal(split.main.settings.packagingV1,undefined);
});
test('references across warehouse boundaries are rejected',()=>{
 const main=state('main'),child=state('child'),combined=mergeWarehouses(main,child);combined.products[0].components=[{productId:'inferno:same',qty:1}];
 assert.throws(()=>splitWarehouses(combined,child),/другого склада|не может ссылаться/);
});
test('combined revisions are monotonic for either database and remain safe integers',()=>{
 assert.ok(combinedRevision(10,3)>combinedRevision(10,2));assert.ok(combinedRevision(11,0)>combinedRevision(10,9999));assert.throws(()=>combinedRevision(10,100000000));
});
async function fixture(t){
 const db={main:{state:state('main'),revision:1,updatedAt:1},inferno:{state:state('child'),revision:2,updatedAt:2}},writes=[];let failChild=false;
 const upstream=async(url,opts)=>{
  const key=url.startsWith('http://child')?'inferno':'main',current=db[key],path=new URL(url).pathname;
  assert.ok(opts.headers.Authorization.startsWith('Bearer '));
  if(path==='/api/warehouse-state'){
   if(opts.method==='PUT'){
    if(key==='inferno'&&failChild)return Response.json({ok:false,error:'fixture failure'},{status:503});
    const body=JSON.parse(opts.body);if(body.baseRevision!==current.revision)return Response.json({ok:false,error:'conflict'},{status:409});
    assert.ok((body.state.products||[]).every(p=>!p.id.startsWith('inferno:')));writes.push(key);current.state=body.patch?applyUnifiedPatch(current.state,body.state):body.state;current.revision++;current.updatedAt++;
   }
   return Response.json({ok:true,exists:true,...current});
  }
  if(path==='/api/orders')return Response.json({ok:true,orders:[{orderId:'123',productId:'same',market:'WB',creationDate:key==='main'?1:2}]});
  if(path==='/api/wb-prices'){assert.equal(new URL(url).searchParams.get('market'),'WB');return Response.json({ok:true,market:'WB',products:[{productId:'same',nmId:'123'}]});}
  throw Error('unexpected '+url);
 };
 const app=express();app.use(express.json());app.use(createUnifiedWarehouseRouter({mainOrigin:'http://main',infernoOrigin:'http://child',infernoSecret:'fixture-secret',fetchImpl:upstream}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.on('listening',r));t.after(()=>{server.closeAllConnections();server.close();});
 const origin='http://127.0.0.1:'+server.address().port,headers={Authorization:'Bearer '+(Date.now()+3600000)+'.fixture.signature','Content-Type':'application/json'};
 return {db,writes,fail:v=>failChild=v,read:async path=>(await fetch(origin+(path||'/warehouse-state'),{headers})).json(),save:async data=>{const r=await fetch(origin+'/warehouse-state',{method:'PUT',headers,body:JSON.stringify(data)});return{status:r.status,body:await r.json()};}};
}
test('a native WB3 edit is saved exclusively to the existing Inferno database',async t=>{
 const f=await fixture(t),before=await f.read();before.state.products[1].stock=7;
 const saved=await f.save({baseRevision:before.revision,state:before.state});assert.equal(saved.status,200);assert.equal(f.db.main.state.products[0].stock,10);assert.equal(f.db.inferno.state.products[0].stock,7);assert.deepEqual(f.writes,['inferno']);
});
test('a concurrent edit is rejected before either database is changed',async t=>{
 const f=await fixture(t),before=await f.read();before.state.products[0].stock=2;before.state.products[1].stock=3;f.db.inferno.revision++;
 assert.equal((await f.save({baseRevision:before.revision,state:before.state})).status,409);assert.deepEqual(f.writes,[]);
});
test('a partial failure stays unsaved and an identical retry completes without duplicating a write',async t=>{
 const f=await fixture(t),before=await f.read();before.state.products[0].stock=2;before.state.products[1].stock=3;const body={baseRevision:before.revision,state:before.state};f.fail(true);
 const failed=await f.save(body);assert.equal(failed.status,503);assert.equal(failed.body.partial,true);assert.deepEqual(f.writes,['main']);
 f.fail(false);assert.equal((await f.save(body)).status,200);assert.deepEqual(f.writes,['main','inferno']);
 assert.equal(f.db.main.state.products[0].stock,2);assert.equal(f.db.inferno.state.products[0].stock,3);
});
test('orders share one feed with a real WB3 market and namespaced product identities',async t=>{
 const f=await fixture(t),data=await f.read('/orders');assert.equal(data.orders.length,2);assert.equal(data.orders[0].market,'WB3');assert.equal(data.orders[0].productId,'inferno:same');assert.equal(data.orders[0].orderId,'123');
 const prices=await f.read('/wb-prices?market=WB3');assert.equal(prices.market,'WB3');assert.equal(prices.products[0].productId,'inferno:same');
});

test('a small edit uses bounded patches in both warehouse protocols',async t=>{
 const f=await fixture(t),before=await f.read(),patch={products:[{...before.state.products[1],stock:4}]};
 const result=await f.save({baseRevision:before.revision,unifiedWarehouseVersion:1,patch:true,state:patch});assert.equal(result.status,200);assert.deepEqual(f.writes,['inferno']);assert.equal(f.db.main.state.products[0].stock,10);assert.equal(f.db.inferno.state.products[0].stock,4);
});
test('patches retain untouched entities and scope deletion keys correctly',()=>{
 const main=state('main'),child=state('child');child.purchases=[{id:'p',productId:'same',qty:2}];const base=mergeWarehouses(main,child);
 const patched=applyUnifiedPatch(base,{deleted:{purchases:['inferno:p']}}),parts=splitWarehouses(patched,child,main);assert.equal(parts.inferno.products.length,1);assert.equal(parts.inferno.purchases.length,0);assert.deepEqual(warehouseDelta(child,parts.inferno).deleted.purchases,['p']);
});

test('WB3 report metadata retains its own market when prepared snapshots are federated',()=>{
 const result=scopeApiValue({market:'WB',ordersPartialMarkets:['WB'],summary:{missingMarkets:['WB']},storeStarts:JSON.stringify({WB:'2026-05-01'})});
 assert.equal(result.market,'WB3');assert.deepEqual(result.ordersPartialMarkets,['WB3']);assert.deepEqual(result.summary.missingMarkets,['WB3']);assert.equal(JSON.parse(result.storeStarts).WB3,'2026-05-01');
});
