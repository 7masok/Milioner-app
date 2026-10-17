import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { initialFinanceHistory, syncFinanceHistoryPage, financeHistoryStatus, financePageRows, WB_FINANCE_SLOT_MS } from '../src/wb-finance-history.js';
const NOW = Date.parse('2026-10-17T08:00:00Z');
function fixture() {
  const states = new Map(), rows = new Map(), calls = [];
  const client = { async query(sql, args) {
    if(sql.startsWith('SELECT')) return { rows: states.has(args[0]) ? [{ state: structuredClone(states.get(args[0])) }] : [] };
    states.set(args[0], JSON.parse(args[1])); return { rows: [] };
  }};
  const run = (market, now, page, extra={}) => syncFinanceHistoryPage({ client, market, now,
    fetchPage: async body => { calls.push({market,body}); assert.ok(states.get(market).nextAllowedAt>now); return typeof page==='function'?page(body):page; },
    saveRows: async (page,options) => { calls.push({market,options}); for(const row of page)rows.set(`${market}:${row.rrdId}`,row); }, ...extra });
  return {states,rows,calls,run};
}
test('year includes exactly 365 calendar days, including leap year and Moscow midnight',()=>{
  const s=initialFinanceHistory(Date.parse('2024-03-01T22:00:00Z'));
  assert.equal(s.archive.dateTo,'2024-03-02');
  assert.equal((Date.parse(s.archive.dateTo)-Date.parse(s.archive.dateFrom))/86400000+1,365);
});
test('recognizes empty arrays and 204 but rejects malformed successes',()=>{
  for(const payload of [[],{data:[]},{result:{items:[]}},{__noContent:true}])assert.deepEqual(financePageRows(payload),[]);
  for(const payload of [{},null,{message:'bad'},{data:'oops'}])assert.throws(()=>financePageRows(payload));
});
test('archive resumes with saved cursor, interleaves recent refresh, and completes only on empty page',async()=>{
  const f=fixture();
  let r=await f.run('WB',NOW,[{rrdId:5}]);
  assert.equal(r.history.status,'loading');assert.equal(r.history.rows,1);
  assert.equal(f.calls[1].options.prune,false);
  r=await f.run('WB',NOW+1000,()=>assert.fail('cooldown must not request'));
  assert.equal(r.skipped,true);
  await f.run('WB',NOW+WB_FINANCE_SLOT_MS,[{rrdId:6}]);
  assert.equal(f.calls[2].body.dateFrom,'2026-09-02');
  assert.equal(f.calls[3].options.prune,true);
  r=await f.run('WB',NOW+2*WB_FINANCE_SLOT_MS,body=>{assert.equal(body.rrdId,5);return []});
  assert.equal(r.history.status,'complete');assert.equal(r.history.rows,1);assert.equal(f.rows.size,2);
  await f.run('WB',NOW+3*WB_FINANCE_SLOT_MS,[]);
  assert.equal(f.states.get('WB').archive.complete,true);
});
test('429 persists deadline and leaves cursor intact across retries; other cabinet independent',async()=>{
  const f=fixture(),retryAt=NOW+4*WB_FINANCE_SLOT_MS;
  await assert.rejects(f.run('WB',NOW,()=>{throw Object.assign(new Error('rate limited'),{retryAt})}));
  assert.equal(f.states.get('WB').archive.cursor,0);
  assert.equal(financeHistoryStatus(f.states.get('WB')).status,'retry');
  await f.run('WB',NOW+WB_FINANCE_SLOT_MS,()=>assert.fail());
  assert.equal(f.calls.length,1);
  await f.run('WB2',NOW,[{rrdId:1}]);assert.equal(f.rows.size,1);
  await f.run('WB',retryAt,[]); // recent gets a turn even after archive error
  assert.equal(f.states.get('WB').nextKind,'archive');
});
test('failed saving and repeated/non-numeric cursor never mark archive complete',async()=>{
  const f=fixture();
  await assert.rejects(f.run('WB',NOW,[{rrdId:5}],{saveRows:async()=>{throw new Error('db unavailable')}}));
  assert.equal(f.states.get('WB').archive.cursor,0);
  await f.run('WB',NOW+WB_FINANCE_SLOT_MS,[]);
  await f.run('WB',NOW+2*WB_FINANCE_SLOT_MS,[{rrdId:5}]);
  await f.run('WB',NOW+3*WB_FINANCE_SLOT_MS,[]);
  await assert.rejects(f.run('WB',NOW+4*WB_FINANCE_SLOT_MS,[{rrdId:5}]),/did not advance/);
  assert.equal(f.states.get('WB').archive.rows,1);
  assert.equal(f.states.get('WB').archive.complete,false);
  await assert.rejects(f.run('WB2',NOW,[{rrdId:'broken'}]),/invalid row/);
});
test('first deployment respects most recent old finance request',async()=>{
  const f=fixture();const r=await f.run('WB',NOW,()=>assert.fail(),{previousRequestAt:NOW-1000});
  assert.equal(r.skipped,true);assert.equal(f.states.get('WB').nextAllowedAt,NOW-1000+WB_FINANCE_SLOT_MS);
});
test('report status distinguishes pending, partial, retry and completed financial scope',()=>{
  const source=readFileSync(new URL('../../business-dashboard-v1.js',import.meta.url),'utf8');
  const fn=source.slice(source.indexOf('function businessFinanceHistoryText('),source.indexOf('async function businessLoadFinanceHistory('));
  const c={};vm.runInNewContext(fn,c);
  assert.match(c.businessFinanceHistoryText([{market:'WB',status:'pending'}]),/ожидают/);
  assert.match(c.businessFinanceHistoryText([{market:'WB',status:'loading',rows:5}]),/5 строк/);
  assert.match(c.businessFinanceHistoryText([{market:'WB2',status:'retry'}]),/повтор/);
  const done=c.businessFinanceHistoryText([{market:'WB',status:'complete',dateFrom:'2025-10-18',dateTo:'2026-10-17'}]);
  assert.match(done,/финансовые отчёты/);assert.match(done,/2025-10-18/);
  assert.doesNotMatch(done,/все магазины|заказы/);
});

test('multi-page recent window retains bounds and never prunes an individual page',async()=>{
  const f=fixture();
  await f.run('WB',NOW,[]); // archive empty and complete
  const page=Array.from({length:100000},(_,i)=>({rrdId:i+1}));
  await f.run('WB',NOW+WB_FINANCE_SLOT_MS,page);
  const bounds=structuredClone(f.states.get('WB').recent);
  assert.equal(bounds.cursor,100000);
  assert.equal(f.calls.at(-1).options.prune,false);
  await f.run('WB',NOW+2*WB_FINANCE_SLOT_MS,body=>{
    assert.equal(body.dateFrom,bounds.dateFrom);assert.equal(body.dateTo,bounds.dateTo);
    assert.equal(body.rrdId,100000);return [{rrdId:100001}];
  });
  assert.equal(f.calls.at(-1).options.prune,false);
  assert.equal(f.states.get('WB').recent,null);
  assert.equal(f.rows.size,100001);
});
