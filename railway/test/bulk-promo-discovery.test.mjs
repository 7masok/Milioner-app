import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {pricesRouter} from '../src/prices.js';
import {pool} from '../src/db.js';
const ui=fs.readFileSync(new URL('../../prices-v1.js',import.meta.url),'utf8');
const ids=Array.from({length:235},(_,i)=>String(i+1));
test('automatic bulk accepts unknown thresholds, removes only discount blocks and leaves active uploads intact',async()=>{
 const calls=[],original=pool.connect;let fail=false;
 const client={release(){},async query(sql,params){calls.push({sql,params});
  if(sql.includes('FROM wb_price_snapshots'))return {rows:[{payload:{rows:ids.map(remoteId=>({remoteId,price:250,discount:0}))}}]};
  if(sql.includes('plan_price AS'))return {rows:ids.slice(0,4).map(nmId=>({nmId,planPrice:245}))};
  if(sql.includes('FROM wb_price_protection'))return {rows:params[1]===5?[{manualPriceLock:true}]:[]};
  if(sql.includes('FROM wb_price_update_queue'))return {rows:[{nmId:'6',status:'sent',source:'schedule',uploadId:123}]};
  if(fail&&sql.includes('INSERT INTO wb_promo_preferences'))throw Object.assign(Error('fixture failure'),{code:'XX001'});
  return {rows:[],rowCount:1};
 }};pool.connect=async()=>client;
 const handler=pricesRouter.stack.find(x=>x.route?.path==='/market-prices/update/bulk').route.stack.at(-1).handle;
 const invoke=async body=>{let result,status=200;await handler({body},{status(s){status=s;return this},json(r){result=r;return this}},e=>{throw e});return {result,status}};
 try{
  const request={market:'WB2',action:'enter',discount:null,remoteIds:ids,confirm:true};
  const blocked=await invoke(request);assert.equal(blocked.status,409);assert.equal(blocked.result.blocked[0].nmId,'5');assert.ok(!calls.some(c=>/INSERT INTO|UPDATE wb_/.test(c.sql)));calls.length=0;
  const {result,status}=await invoke({...request,overrideProtection:true,overrideRemoteIds:['5']});
  assert.equal(status,200);assert.equal(result.applied.length,235);assert.equal(result.discovery.length,235);assert.deepEqual(result.skipped.map(r=>r.remoteId),[]);assert.ok(result.applied.includes('6'));
  assert.equal(calls.filter(c=>c.sql.includes('INSERT INTO wb_promo_preferences')).length,235);
  assert.equal(calls.filter(c=>c.sql.includes('INSERT INTO wb_price_protection')).length,235);
  assert.ok(calls.filter(c=>c.sql.includes('INSERT INTO wb_price_protection')).every(c=>c.params[0]==='WB2'&&c.params[2]===false));
  assert.ok(!calls.some(c=>/^(INSERT|UPDATE|DELETE).*wb_price_update_queue/s.test(c.sql)));
  const wake=calls.find(c=>c.sql.includes('INSERT INTO wb_promo_sync_state'));assert.match(wake.sql,/next_sync_at>\$2 THEN wb_promo_sync_state.next_sync_at/);
  assert.ok(calls.some(c=>c.sql==='COMMIT'));
  calls.length=0;fail=true;
  assert.equal((await invoke({market:'WB',action:'enter',remoteIds:['1'],confirm:true})).status,500);
  assert.ok(calls.some(c=>c.sql==='ROLLBACK'));assert.ok(!calls.some(c=>c.sql==='COMMIT'));
 }finally{pool.connect=original}
});
test('preview includes protected rows for confirmation; explicit discounts still preserve in-flight checks',()=>{
 const source=ui.slice(ui.indexOf('function workbenchChanges(){'),ui.indexOf('window.priceWorkbenchPreview='));
 const rows=ids.map(remoteId=>({remoteId,price:250,discount:0,priceProtected:remoteId==='5',syncState:remoteId==='6'?'sent':'',promoPlanPrice:Number(remoteId)<=4?245:null}));
 const elements={priceWorkbenchDiscount:{value:''}};
 const ctx={priceWorkbench:{action:'enter',rows},document:{getElementById:id=>elements[id]},pNum:v=>Number(v)||0};
 vm.createContext(ctx);vm.runInContext(source,ctx);
 let changes=ctx.workbenchChanges();assert.equal(changes.filter(c=>!c.error).length,235);assert.ok(changes.every(c=>c.automaticEntry));assert.equal(changes[4].error,'');
 elements.priceWorkbenchDiscount.value='2';changes=ctx.workbenchChanges();assert.ok(changes.every(c=>!c.automaticEntry));assert.equal(changes[0].discount,2);assert.match(changes[5].error,/проверяется/);
});
test('calendar discount queue cannot overwrite a submitted upload',()=>{
 const source=fs.readFileSync(new URL('../src/wb-promotions.js',import.meta.url),'utf8');
 const queue=source.slice(source.indexOf('async function queuePromoDiscount('),source.indexOf('function requiredDiscount('));
 assert.match(queue,/WHERE wb_price_update_queue.source='promo' AND wb_price_update_queue.status NOT IN \('sent','checking'\)/);
});
