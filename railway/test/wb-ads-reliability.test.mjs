import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import {stockBlock} from '../src/wb-ad-inventory.js';

const source = readFileSync(new URL('../src/wb-ads.js', import.meta.url), 'utf8');
function harness(configured = []) {
  const calls = [], queries = [];
  const context = vm.createContext({
    console: { info() {}, warn() {}, error() {} },
    Date, Intl, URL, AbortController, setTimeout, clearTimeout, setInterval,
    express: { Router: () => ({ get() {}, put() {}, post() {} }) },
    pool: { query: async (sql, args) => { queries.push({ sql, args }); return { rows: configured }; } },
    stockBlock, config: {}, credentialFor: async () => 'test-token', asyncRoute: fn => fn,
  });
  vm.runInContext(source.replace(/^import .*;\r?\n/gm, '').replace(/export /g, '') + '\nglobalThis.api = { enforce, fetchCampaigns, setStoredCampaignStatus, localDate };', context);
  context.mockRequest = async url => { calls.push(url); return {}; };
  vm.runInContext('request = (...args) => mockRequest(...args); setStoredCampaignStatus = async () => {}; inventoryFor = async (m, rows) => new Map(rows.map(r => [Number(r.id), {known:true, allEmpty:false, allRisky:false}]));', context);
  return { context, api: context.api, calls, queries };
}
const limit = (id, extra = {}) => ({ campaignId: id, dailyLimit: 450, enabled: true, ...extra });
const campaign = (id, status = 9, spend = 500) => ({ id, status, todaySpend: spend, maxTodaySpend: spend });

test('over-limit pause precedes a failing scheduled start and later starts still run', async () => {
  const h = harness([limit(1, { scheduleEnabled: true, startTime: '00:00' }), limit(2), limit(3, { scheduleEnabled: true, startTime: '00:00' })]);
  h.context.mockRequest = async url => { h.calls.push(url); if (url.endsWith('id=1')) throw new Error('no budget'); return {}; };
  await h.api.enforce('WB', { day: h.api.localDate(), campaigns: [campaign(1, 11, 0), campaign(2), campaign(3, 11, 0)] });
  assert.match(h.calls[0], /pause\?id=2$/);
  assert.ok(h.calls.some(url => /start\?id=3$/.test(url)));
  assert.ok(h.queries.some(q => q.args?.includes('no budget')));
});

test('yesterday totals never pause active campaigns', async () => {
  const h = harness([limit(1)]);
  await h.api.enforce('WB', { day: '2000-01-01', campaigns: [campaign(1)] }, { allowStarts: false });
  assert.equal(h.calls.length, 0);
});

test('manual pause remains excluded from automatic starts', async () => {
  const h = harness([limit(1, { manualPaused: true, scheduleEnabled: true, startTime: '00:00' })]);
  await h.api.enforce('WB', { day: h.api.localDate(), campaigns: [campaign(1, 11, 0)] });
  assert.equal(h.calls.length, 0);
});

test('stale refresh permits known over-limit stops but prevents starts', async () => {
  const h = harness([limit(1), limit(2, { autoPaused: true, autoPausedDay: '2000-01-01' })]);
  await h.api.enforce('WB', { day: h.api.localDate(), campaigns: [campaign(1), campaign(2, 11, 0)] }, { allowStarts: false });
  assert.equal(h.calls.length, 1);
  assert.match(h.calls[0], /pause\?id=1$/);
});

test('partial statistics retain valid spend and expose failure and freshness', async () => {
  const h = harness();
  const failure = Object.assign(new Error('429'), { retryAt: Date.now() + 60000 });
  h.context.mockRequest = async url => {
    h.calls.push(url);
    if (url.includes('/api/advert/v2/adverts')) return { adverts: [{ id: 1, status: 9, settings: { name: 'One' } }, { id: 2, status: 9, settings: { name: 'Two' } }] };
    if (url.includes('/fullstats')) throw failure;
    return { cards: [] };
  };
  const result = await h.api.fetchCampaigns('WB', { day: h.api.localDate(), campaigns: [{ ...campaign(1), statsUpdatedAt: 123, nameSource: 'missing' }] });
  assert.equal(result.statsError, failure);
  assert.equal(result.campaigns.length, 2);
  assert.equal(result.campaigns[0].todaySpend, 500);
  assert.equal(result.campaigns[0].statsStale, true);
  assert.equal(result.campaigns[0].statsUpdatedAt, 123);
  assert.match(h.calls[0], /statuses=4,9,11$/);
});

test('status-only writes do not clear refresh errors or advance stats timestamp', async () => {
  const h = harness();
  await h.api.setStoredCampaignStatus('WB', 1, 11);
  assert.equal(h.queries.length, 1);
  assert.match(h.queries[0].sql, /UPDATE wb_ads_snapshots SET payload=jsonb_set/);
  assert.doesNotMatch(h.queries[0].sql, /updated_at=|last_error=|next_attempt_at=/);
});

test('zero stock pauses even without a saved limit rule', async () => {
  const h=harness();
  vm.runInContext('inventoryFor = async () => new Map([[1,{known:true,allEmpty:true,allRisky:true}]]);',h.context);
  await h.api.enforce('WB',{day:h.api.localDate(),campaigns:[campaign(1,9,0)]},{allowStarts:false});
  assert.equal(h.calls.length,1);assert.match(h.calls[0],/pause\?id=1$/);
  assert.ok(h.queries.some(q=>q.sql.includes('stock_paused=TRUE')));
});

test('stock guard blocks scheduled start when inventory is unknown or empty', async () => {
  for(const stock of [{known:false},{known:true,allEmpty:true}]) {
    const h=harness([limit(1,{scheduleEnabled:true,startTime:'00:00'})]);
    h.context.stock=stock;vm.runInContext('inventoryFor = async () => new Map([[1,stock]]);',h.context);
    await h.api.enforce('WB',{day:h.api.localDate(),campaigns:[campaign(1,11,0)]});
    assert.equal(h.calls.length,0);
  }
});

test('stock pause remains paused after replenishment until manual resume', async () => {
  const h=harness([limit(1,{stockPaused:true,scheduleEnabled:true,startTime:'00:00'})]);
  await h.api.enforce('WB',{day:h.api.localDate(),campaigns:[campaign(1,11,0)]});assert.equal(h.calls.length,0);
});

test('pending manual pause retries even without an enabled daily limit', async () => {
  const h=harness([limit(1,{manualPaused:true,enabled:false})]);
  await h.api.enforce('WB',{day:h.api.localDate(),campaigns:[campaign(1,9,0)]});assert.match(h.calls[0],/pause\?id=1$/);
});
