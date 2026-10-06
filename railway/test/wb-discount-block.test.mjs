import test from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/db.js';
import { syncWbDiscountBlocks, setWbDiscountBlock } from '../src/wb-price-protection.js';
import { pricesRouter } from '../src/prices.js';

test('persistent block corrects WB discounts repeatedly, preserves price targets and waits for sent uploads', async () => {
  const original=pool.query, calls=[];
  let discount=12, enabled=true, queue=null;
  pool.query=async (sql,params)=>{
    calls.push({sql,params});
    if(sql.includes('FROM wb_price_snapshots'))return {rows:[{payload:{rows:[{remoteId:'1',price:5000,discount}]}}]};
    if(sql.includes('FROM wb_price_protection'))return {rows:[{nmId:'1',promoBlock:enabled}]};
    if(sql.includes('FROM wb_price_update_queue'))return {rows:queue?[queue]:[]};
    return {rows:[],rowCount:1};
  };
  const inserts=()=>calls.filter(c=>c.sql.includes('INSERT INTO wb_price_update_queue'));
  try {
    assert.equal((await syncWbDiscountBlocks('WB',1)).changed,1);
    assert.deepEqual(inserts()[0].params,['WB','1',1]);
    assert.match(inserts()[0].sql,/VALUES\(\$1,\$2,NULL,0/);
    calls.length=0; discount=0;
    assert.equal((await syncWbDiscountBlocks('WB',2)).changed,0);
    calls.length=0; discount=7;
    assert.equal((await syncWbDiscountBlocks('WB',3)).changed,1,'WB re-entry needs another correction');
    for(const source of ['manual','schedule','protection']){
      calls.length=0; queue={source,status:'pending',desiredPrice:175,desiredDiscount:10};
      await syncWbDiscountBlocks('WB',4);
      assert.equal(inserts().length,1);
      const update=inserts()[0].sql.split('DO UPDATE SET')[1];
      assert.doesNotMatch(update,/desired_price\s*=/,'must keep the final/night/locked price');
      assert.equal(queue.desiredPrice,175);
    }
    for(const status of ['sent','checking']){
      calls.length=0; queue={source:'manual',status,desiredDiscount:20,uploadId:12};
      assert.equal((await syncWbDiscountBlocks('WB',5)).changed,0);
      assert.equal(inserts().length,0);
      assert.equal(queue.uploadId,12);
    }
    calls.length=0; queue={source:'protection',status:'error',desiredDiscount:0};
    assert.equal((await syncWbDiscountBlocks('WB',6)).changed,0,'do not blindly retry a rejected zero');
    calls.length=0; queue=null; enabled=false;
    assert.equal((await syncWbDiscountBlocks('WB',7)).changed,0,'uncheck stops subsequent corrections');
  } finally {pool.query=original;}
});

test('block updates only its flag and locked discount, leaving night/price configuration intact', async () => {
  const calls=[],client={query:async(sql,params)=>{calls.push({sql,params});}};
  await setWbDiscountBlock('WB2',1,true,client,5);
  await setWbDiscountBlock('WB2',1,false,client,6);
  assert.deepEqual(calls.map(c=>c.params),[['WB2',1,true,5],['WB2',1,false,6]]);
  assert.match(calls[0].sql,/WHEN excluded.promo_block THEN 0/);
  assert.doesNotMatch(calls[0].sql,/locked_price\s*=|manual_price_lock\s*=|wb_price_schedules/);
});

test('bulk exit enables block even during upload; enter clears it and SQL failure rolls everything back', async () => {
  const handler=pricesRouter.stack.find(l=>l.route?.path==='/market-prices/update/bulk').route.stack.at(-1).handle;
  const original=pool.connect,calls=[];
  let inFlight=true, priceProtected=true, fail=false, queueSource='manual';
  const client={release(){},async query(sql,params){
    calls.push({sql,params});
    if(sql.includes('FROM wb_price_snapshots'))return {rows:[{payload:{rows:[{remoteId:'1',price:550,discount:10}]}}]};
    if(sql.includes('FROM wb_price_protection'))return {rows:[{promoBlock:true,manualPriceLock:priceProtected}]};
    if(sql.includes('FROM wb_price_update_queue'))return {rows:inFlight||queueSource==='schedule'?[{nmId:'1',status:inFlight?'sent':'pending',source:queueSource,desiredPrice:5000,desiredDiscount:10,uploadId:12}]:[]};
    if(sql.includes('FROM wb_price_schedules'))return {rows:[{enabled:true,startMinute:0,endMinute:1439}]};
    if(sql.includes('INSERT INTO wb_price_update_queue')&&fail)throw Object.assign(Error('database fixture'),{code:'XX001'});
    return {rows:[],rowCount:1};
  }};
  pool.connect=async()=>client;
  const invoke=async action=>{
    let status=200,result;
    await handler({body:{market:'WB',remoteIds:['1'],action,discount:action==='exit'?0:20,confirm:true}},
      {status(n){status=n;return this;},json(v){result=v;return this;}},e=>{throw e;});
    return {status,result};
  };
  try{
    let result=await invoke('exit');
    assert.deepEqual(result.result.applied,['1']);
    assert.ok(calls.some(c=>c.sql.includes('INSERT INTO wb_price_protection')&&c.params[2]===true));
    assert.ok(!calls.some(c=>c.sql.includes('INSERT INTO wb_price_update_queue')),'sent upload is retained');
    calls.length=0; inFlight=false; priceProtected=false;
    result=await invoke('enter');
    assert.deepEqual(result.result.applied,['1'],'enter can intentionally override the discount block');
    assert.ok(calls.some(c=>c.sql.includes('INSERT INTO wb_price_protection')&&c.params[2]===false));
    assert.deepEqual(calls.find(c=>c.sql.includes('INSERT INTO wb_price_update_queue')).params.slice(0,4),['WB','1',null,20]);
    calls.length=0; fail=true;
    result=await invoke('enter');
    assert.equal(result.status,500);
    assert.ok(calls.some(c=>c.sql==='ROLLBACK'));
    assert.ok(!calls.some(c=>c.sql==='COMMIT'));
    calls.length=0; fail=false; priceProtected=true;
    result=await invoke('exit');
    assert.deepEqual(result.result.applied,['1'],'discount exit works without unlocking the seller price');
    assert.deepEqual(calls.find(c=>c.sql.includes('INSERT INTO wb_price_update_queue')).params.slice(0,4),['WB','1',null,0]);
    calls.length=0; priceProtected=false; queueSource='schedule';
    result=await invoke('exit');
    assert.deepEqual(result.result.applied,['1']);
    const queued=calls.find(c=>c.sql.includes('INSERT INTO wb_price_update_queue'));
    assert.deepEqual(queued.params.slice(0,4),['WB','1',5000,0]);
    assert.equal(queued.params[5],'schedule','discount exit must retain the pending night operation');
    const schedule=calls.find(c=>c.sql.includes('UPDATE wb_price_schedules'));
    assert.equal(schedule.params[3],false,'discount exit must not suppress the night window');
  } finally {pool.connect=original;}
});
