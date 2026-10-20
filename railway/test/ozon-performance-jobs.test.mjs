import test from 'node:test';
import assert from 'node:assert/strict';
import {createPerformanceJobs} from '../src/ozon-performance-jobs.js';
import {build,resumeOzonPerformanceRetries} from '../src/ozon-performance.js';
import {pool} from '../src/db.js';

function fixture() {
  const db = new Map();
  let time = 1000;
  const options = {read: async key => structuredClone(db.get(key)), write: async (key, value) => db.set(key, structuredClone(value)), now: () => time};
  return {store:db,restart: () => createPerformanceJobs(options), advance: ms => time += ms};
}

test('timeout and restart resume the same UUID instead of generating another report', async () => {
  const f = fixture();
  let submits = 0;
  const options = {ttl: 900000, submit: async () => {submits++; return 'pending-report';}, collect: async uuid => {
    assert.equal(uuid, 'pending-report');
    throw Object.assign(new Error('still running'), {code: 'REPORT_TIMEOUT'});
  }};
  await assert.rejects(f.restart().get('period-batch-a', options), /still running/);
  f.advance(300000);
  const rows = [{sku: '10001', spent: 300}];
  assert.deepEqual(await f.restart().get('period-batch-a', {...options, collect: async uuid => {
    assert.equal(uuid, 'pending-report'); return rows;
  }}), rows);
  assert.equal(submits, 1);
});

test('a later batch hitting quota retains earlier completed rows and its pending UUID', async () => {
  const f = fixture(); let submits = 0;
  const options = {ttl: 900000, submit: async () => 'report-' + ++submits, collect: async () => [{sku: '10001', spent: 300}]};
  await f.restart().get('batch-a', options);
  await assert.rejects(f.restart().get('batch-b', {...options, collect: async () => {
    throw Object.assign(new Error('quota'), {code: 'DAILY_LIMIT'});
  }}), /quota/);
  const restarted = f.restart();
  await restarted.get('batch-a', {...options, collect: async () => assert.fail('completed batch must be reused')});
  await restarted.get('batch-b', {...options, collect: async uuid => {
    assert.equal(uuid, 'report-2'); return [];
  }});
  assert.equal(submits, 2);
});

test('confirmed empty reports are cached; expired results refresh; failed jobs can be recreated', async () => {
  const f = fixture(); let submits = 0;
  const options = {ttl: 10000, submit: async () => 'report-' + ++submits, collect: async () => []};
  await f.restart().get('zero', options);
  await f.restart().get('zero', options);
  assert.equal(submits, 1);
  f.advance(11000);
  await f.restart().get('zero', options);
  assert.equal(submits, 2);
  await assert.rejects(f.restart().get('failed', {...options, collect: async () => {
    throw Object.assign(new Error('failed'), {code: 'REPORT_FAILED'});
  }}));
  await f.restart().get('failed', options);
  assert.equal(submits, 4);
});

test('concurrent consumers create only one component report', async () => {
  const f = fixture(), jobs = f.restart(); let submits = 0;
  const options = {ttl: 900000, submit: async () => {submits++; return 'one';}, collect: async () => []};
  await Promise.all([jobs.get('same', options), jobs.get('same', options)]);
  assert.equal(submits, 1);
});

test('a quota wait longer than the component TTL preserves completed batches until the combined report succeeds', async () => {
  const f=fixture();let submits=0;
  const options={ttl:6*3600000,retainUntilComplete:true,submit:async()=> 'job-'+ ++submits,collect:async()=>[{sku:'10001',spent:300}]};
  await f.restart().get('a',options);
  // Completed components written by the previous deployment have no marker.
  f.store.set('legacy',{rows:[{sku:'10002',spent:15}],at:1000});
  await assert.rejects(f.restart().get('b',{...options,collect:async()=>{throw Object.assign(Error('quota'),{code:'DAILY_LIMIT'})}}));
  f.advance(18*3600000);
  const resumed=f.restart();
  assert.equal((await resumed.get('legacy',{...options,collect:async()=>assert.fail('legacy saved batch must survive the rollout')}))[0].spent,15);
  assert.equal((await resumed.get('a',{...options,collect:async()=>assert.fail('must reuse the completed batch after quota')}))[0].spent,300);
  await resumed.get('b',{...options,collect:async uuid=>{assert.equal(uuid,'job-2');return[]}});
  assert.equal(submits,2);
  await resumed.complete(['a','b','legacy']);f.advance(7*3600000);
  await f.restart().get('a',options);assert.equal(submits,3);
});

test('successful direct SKU statistics do not generate duplicate campaign reports, including zero spend', async () => {
  const original = {fetch: globalThis.fetch, query: pool.query, timeout: globalThis.setTimeout, id: process.env.OZON_PERFORMANCE_CLIENT_ID, secret: process.env.OZON_PERFORMANCE_CLIENT_SECRET};
  const db = new Map(), paths = [];
  let directSpend = 300, promoSpend = 70;
  process.env.OZON_PERFORMANCE_CLIENT_ID = 'synthetic-client';
  process.env.OZON_PERFORMANCE_CLIENT_SECRET = 'synthetic-secret';
  pool.query = async (sql, params) => {
    if (sql.startsWith('SELECT payload')) return {rows: db.has(params[0]) ? [{payload: structuredClone(db.get(params[0]))}] : []};
    if (sql.startsWith('INSERT INTO')) db.set(params[0], JSON.parse(params[1]));
    return {rows: []};
  };
  globalThis.setTimeout = fn => {queueMicrotask(fn); return 0;};
  globalThis.fetch = async url => {
    const path = new URL(url).pathname; paths.push(path);
    let body;
    if (path === '/api/client/token') body = {access_token: 'synthetic-token', expires_in: 1800};
    else if (path === '/api/client/campaign') body = {list: [{id: '1', advObjectType: 'SKU', paymentType: 'CPC'}]};
    else if (path === '/api/client/statistics/products/sku') body = {rows: [{sku: '10001', expense: directSpend}]};
    else if (path === '/api/client/statistics/all_sku_promo/products/generate') body = {UUID: 'promo'};
    else if (path === '/api/client/statistics/promo') body = {state: 'OK', link: '/synthetic-report'};
    else if (path === '/synthetic-report') body = {rows: [{sku: '10001', expense: promoSpend}]};
    else assert.fail('Unexpected upstream request: ' + path);
    return new Response(JSON.stringify(body), {status: 200});
  };
  try {
    const day = new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);
    const first = await build(day, day);
    assert.equal(first.totalSpent, 370);
    assert.equal(first.rows.length, 1);
    directSpend = 0; promoSpend = 10;
    const yesterday = new Date(Date.parse(day + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
    const second = await build(yesterday, yesterday);
    assert.equal(second.totalSpent, 10);
    assert.equal(paths.filter(path => path === '/api/client/statistics/products/sku').length, 2);
    assert.equal(paths.includes('/api/client/statistics/json'), false);
  } finally {
    globalThis.fetch = original.fetch; globalThis.setTimeout = original.timeout; pool.query = original.query;
    for (const [key, value] of [['OZON_PERFORMANCE_CLIENT_ID', original.id], ['OZON_PERFORMANCE_CLIENT_SECRET', original.secret]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('startup restores the saved period and provider deadline without calling Ozon during cooldown',async()=>{
 const prior={query:pool.query,fetch:globalThis.fetch,info:console.info,id:process.env.OZON_PERFORMANCE_CLIENT_ID,secret:process.env.OZON_PERFORMANCE_CLIENT_SECRET};
 const retryAt=Date.now()+18*3600000,logs=[];let restored=false;
 process.env.OZON_PERFORMANCE_CLIENT_ID='restart-fixture';process.env.OZON_PERFORMANCE_CLIENT_SECRET='fixture-secret';
 pool.query=async(sql,args)=>{
  if(sql.startsWith('SELECT cache_key')){assert.match(sql,/LIMIT 8/);restored=true;return{rows:[{cache_key:args[0].slice(0,-1)+'2026-10-11:2026-10-11'}]}}
  if(sql.startsWith('SELECT payload'))return{rows:[{payload:{error:'provider quota',limited:true,retryAt}}]};
  return{rows:[]};
 };
 globalThis.fetch=async()=>assert.fail('cooldown forbids an upstream request');console.info=(label,value)=>logs.push({label,value:JSON.parse(value)});
 try{await resumeOzonPerformanceRetries();assert.equal(restored,true);assert.equal(logs.length,1);assert.equal(logs[0].value.retryAt,retryAt);assert.equal(logs[0].value.from,'2026-10-11');assert.equal(logs[0].value.limited,true)}
 finally{pool.query=prior.query;globalThis.fetch=prior.fetch;console.info=prior.info;for(const[key,value]of[['OZON_PERFORMANCE_CLIENT_ID',prior.id],['OZON_PERFORMANCE_CLIENT_SECRET',prior.secret]])if(value===undefined)delete process.env[key];else process.env[key]=value}
});
