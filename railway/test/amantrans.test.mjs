import test from 'node:test';
import assert from 'node:assert/strict';
import {amanIdentity,amanOrder,amanEdit,createAmanService,amanRouter} from '../src/amantrans.js';
const token=(id=7,role='RoleClient')=>'header.'+Buffer.from(JSON.stringify({id,role,exp:4000000000})).toString('base64url')+'.fixture';
const raw=(id,name='Кошелёк')=>({id,name,track_code:'SAME-TRACK',amount:1,price:3,weight:0.13,tariff_price:3.2,box_price:0.026,delivery_price:0.416,usd:455.1,created_at:'2026-10-17T08:00:00Z',status:{name:'SUB_FILIAL',name_ru:'В филиале'},customer:{id:7,phone:'not-returned'}});
function fixture(){
 let stored=null,at=1000000,source=[raw(11),raw(12,'Ошибочная запись')],mode='',calls=[];
 const service=createAmanService({now:()=>at,read:async()=>structuredClone(stored),write:async data=>{stored=structuredClone(data)},fetchImpl:async(url,options)=>{
  const u=new URL(url),body=options.body?JSON.parse(options.body):null;calls.push({url:u,options,body});
  assert.equal(u.origin,'https://api.amantrans.com.kz');assert.equal(options.redirect,'error');assert.ok(options.signal);
  if(u.pathname==='/auth/sign-in-client')return new Response(JSON.stringify({token:token()}));
  if(mode==='unauthorized')return new Response('private credentials must not be reflected',{status:401});
  if(u.pathname==='/amantrans/orders'){
   if(mode==='offline')throw Error('offline');
   if(mode==='foreign')return Response.json({content:[{...raw(99),customer:{id:8}}],totalPages:1});
   if(mode==='partial'&&u.searchParams.get('page')==='1')throw Error('offline');
   return Response.json({content:source,totalPages:mode==='partial'?2:1});
  }
  if(u.pathname==='/amantrans/orders/create'){
   if(mode==='write-timeout')throw Error('lost response');source.push({...raw(15),...body});return Response.json({id:15});
  }
  if(u.pathname==='/amantrans/orders/update'){const row=source.find(x=>x.id===body.id);assert.ok(row);Object.assign(row,body);return Response.json(row);}
  if(u.pathname==='/amantrans/order_turkey/get-status-info')return Response.json([{update_date:'2026-10-28T19:01:00Z',status_to:{name_ru:'В филиале'},moderator_phone:'not-returned'}]);
  assert.fail(u.pathname);
 }});
 return {service,calls,connect:()=>service.connect({phone:'+77000000001',password:'fixture-only'}),get stored(){return stored},get source(){return source},set mode(value){mode=value},advance:ms=>at+=ms};
}
const fields={name:'Исправленное название',track:'SAME-TRACK',priceUsd:3,amount:2};
test('only client identities and exact safe IDs can be used for carrier operations',()=>{
 assert.equal(amanIdentity(token()).accountId,'7');assert.throws(()=>amanIdentity(token(7,'RoleAdmin')));assert.throws(()=>amanIdentity('invalid'));
 assert.throws(()=>amanOrder(raw('9007199254740993')));assert.throws(()=>amanIdentity(token('9007199254740993')));
});
test('full carrier costs are separate from product price and unknown values stay unknown',()=>{
 const row=amanOrder(raw(11));assert.equal(row.priceUsd,3);assert.equal(row.weight,0.13);assert.ok(Math.abs(row.totalKzt-201.1542)<0.000001);assert.equal(row.deliveryUsd,0.416);
 const unknown=amanOrder({...raw(11),weight:null,usd:null});assert.equal(unknown.weight,null);assert.equal(unknown.totalKzt,null);assert.equal(row.customer,undefined);
});
test('client edits never accept weight, tariffs, statuses, account IDs or arbitrary fields',()=>{
 assert.equal(amanEdit(fields).amount,2);
 for(const patch of [{weight:1},{tariff_price:5},{status:'ISSUE'},{customer_id:8},{id:12}])assert.throws(()=>amanEdit({...fields,...patch}));
 for(const amount of [0,-1,1.5,NaN])assert.throws(()=>amanEdit({...fields,amount}));
 assert.throws(()=>amanEdit({...fields,priceUsd:''}));assert.throws(()=>amanEdit({...fields,track:'<img>'}));
});
test('account connection returns full duplicate-track records without exposing access secrets',async()=>{
 const f=fixture(),view=await f.connect();assert.equal(view.orders.length,2);assert.notEqual(view.orders[0].id,view.orders[1].id);assert.equal(view.orders[0].track,view.orders[1].track);
 assert.equal(view.connected,true);assert.equal(view.deleteSupported,false);assert.equal(view.phoneHint,'•••0001');
 const serialized=JSON.stringify(view);assert.doesNotMatch(serialized,/fixture-only|header\.|not-returned|77000000001/);
 assert.equal(f.calls[0].body.clientType,'client');assert.equal(f.calls[0].body.phone,'77000000001');
 const count=f.calls.length;await f.service.get();await f.service.syncIfDue();assert.equal(f.calls.length,count,'cache views never request the carrier');
});
test('the five-minute worker reuses credentials and preserves the last full snapshot on failure',async()=>{
 const f=fixture();await f.connect();f.advance(300001);f.mode='partial';await assert.rejects(f.service.syncIfDue());assert.equal(f.stored.orders.length,2);assert.ok(f.stored.lastError);
 const count=f.calls.length;await f.service.syncIfDue();assert.equal(f.calls.length,count,'failed sources respect the saved cooldown');
});
test('upstream expired login cannot return a warehouse 401 or reflect carrier error bodies',async()=>{
 const f=fixture();await f.connect();f.mode='unauthorized';await assert.rejects(f.service.sync(),error=>error.status===409&&!error.message.includes('private credentials'));
});
test('a foreign account or failed new connection never replaces a working account',async()=>{
 const f=fixture();await f.connect();const original=structuredClone(f.stored);f.mode='foreign';await assert.rejects(f.connect());assert.deepEqual(f.stored,original);
});
test('hiding an erroneous duplicate is reversible and makes no carrier write',async()=>{
 const f=fixture();await f.connect();const count=f.calls.length;let view=await f.service.hide('12',true);assert.equal(view.orders.find(x=>x.id==='12').hidden,true);assert.equal(view.orders.find(x=>x.id==='11').hidden,false);
 view=await f.service.hide('12',false);assert.equal(view.orders.find(x=>x.id==='12').hidden,false);assert.equal(f.calls.length,count);
 await assert.rejects(f.service.hide('999',true));
});
test('editing chooses an exact provider ID among duplicate tracks and rejects stale drafts',async()=>{
 const f=fixture(),view=await f.connect();const body={fields,operationId:'update-fixture-001',fingerprint:view.orders[1].fingerprint};
 await f.service.send('12',body);assert.equal(f.source[1].name,fields.name);assert.equal(f.source[0].name,'Кошелёк');
 const updates=()=>f.calls.filter(x=>x.options.method==='PUT').length;assert.equal(updates(),1);await f.service.send('12',body);assert.equal(updates(),1);
 await f.service.sync();await assert.rejects(f.service.send('12',{...body,operationId:'update-fixture-002'}),error=>error.status===409);assert.equal(updates(),1);
});
test('creation is tied to the connected account and an uncertain response is never resent',async()=>{
 const f=fixture();await f.connect();const body={fields:{...fields,shippingMethod:'Avto'},operationId:'create-fixture-001'};f.mode='write-timeout';
 await assert.rejects(f.service.send(null,body));await assert.rejects(f.service.send(null,body));
 const posts=f.calls.filter(x=>x.url.pathname==='/amantrans/orders/create');assert.equal(posts.length,1);assert.equal(posts[0].body.customer_id,7);assert.equal(posts[0].body.shipping_method,'Avto');
 assert.equal(f.stored.operations[body.operationId].state,'pending');
});
test('accepted creates are remembered across a new service instance and refreshed separately',async()=>{
 const f=fixture();await f.connect();const body={fields:{...fields,shippingMethod:'Avto'},operationId:'create-fixture-001'},result=await f.service.send(null,body);assert.equal(result.sent,true);assert.equal(result.refreshNeeded,true);
 const next=createAmanService({read:async()=>structuredClone(f.stored),write:async()=>assert.fail('receipt should be read only'),fetchImpl:async()=>assert.fail('no repeated create')});
 assert.equal((await next.send(null,body)).sent,true);await f.service.sync();assert.equal((await f.service.get()).orders.length,3);
});
test('history is queried by exact order ID and never returns moderator personal data',async()=>{
 const f=fixture();await f.connect();const out=await f.service.history('11');assert.equal(out.history[0].status,'В филиале');assert.doesNotMatch(JSON.stringify(out),/moderator|not-returned/);
 const request=f.calls.at(-1);assert.equal(request.url.searchParams.get('id'),'11');assert.equal(request.url.searchParams.get('country'),'China');await assert.rejects(f.service.history('999'));
});
test('disconnect removes stored access but retains the last read-only carrier snapshot',async()=>{
 const f=fixture();await f.connect();const view=await f.service.disconnect();assert.equal(view.connected,false);assert.equal(view.orders.length,2);assert.equal(f.stored.password,undefined);assert.equal(f.stored.token,undefined);await assert.rejects(f.service.send(null,{fields:{...fields,shippingMethod:'Avto'},operationId:'create-fixture-001'}));
});
test('all carrier routes keep owner-session and trusted-origin middleware; no remote delete exists',()=>{
 assert.equal(amanRouter.stack[0].name,'requireConfiguredSession');assert.equal(amanRouter.stack[1].name,'requireTrustedOrigin');
 const routes=amanRouter.stack.filter(x=>x.route).map(x=>x.route);assert.ok(routes.length>=8);assert.ok(routes.every(x=>!x.methods.delete));
 for(const r of routes.filter(x=>!x.methods.get))assert.equal(r.stack[0].handle.name,'requireWritesEnabled');
});

test('paying registers a purchase with the same numeric total and a durable shipment identity',async()=>{
 const f=fixture();await f.connect();const body={purchaseKey:'po-paid-fixture',fields:{name:'Первый товар',track:'NEW-TRACK',priceUsd:7480,amount:140,shippingMethod:'Avto'}};
 const first=await f.service.registerPurchase(body);assert.equal(first.createdOrderId,'15');assert.equal(first.sent,true);
 const sent=f.calls.filter(x=>x.url.pathname==='/amantrans/orders/create');assert.equal(sent.length,1);assert.equal(sent[0].body.price,7480);assert.equal(sent[0].body.amount,140);assert.equal(sent[0].body.name,'Первый товар');assert.equal(sent[0].body.customer_id,7);
 await f.service.registerPurchase(body);assert.equal(f.calls.filter(x=>x.url.pathname==='/amantrans/orders/create').length,1);
 const saved=structuredClone(f.stored),restarted=createAmanService({read:async()=>structuredClone(saved),write:async()=>{},fetchImpl:async()=>assert.fail('a linked receipt must survive restart')});
 assert.equal((await restarted.registerPurchase(body)).createdOrderId,'15');
 await assert.rejects(f.service.registerPurchase({...body,fields:{...body.fields,amount:141}}),/другими данными/);
 assert.equal(f.calls.filter(x=>x.url.pathname==='/amantrans/orders/create').length,1);
 assert.doesNotMatch(JSON.stringify(await f.service.get()),/purchaseKey|NEW-TRACK.*beforeIds|fixture-only/);
});
test('a paid purchase never chooses a duplicate track or repeats an uncertain carrier write',async()=>{
 const f=fixture();await f.connect();const body={purchaseKey:'inferno:po-paid-fixture',fields:{name:'Первый товар',track:'SAME-TRACK',priceUsd:10000,amount:2,shippingMethod:'Avto'}};
 await assert.rejects(f.service.registerPurchase(body),/Такой трек уже есть/);assert.equal(f.calls.filter(x=>x.url.pathname==='/amantrans/orders/create').length,0);
 body.fields.track='NEW-TRACK';f.mode='write-timeout';await assert.rejects(f.service.registerPurchase(body));
 await assert.rejects(f.service.registerPurchase(body),/предыдущей отправки/);assert.equal(f.calls.filter(x=>x.url.pathname==='/amantrans/orders/create').length,1);
});
