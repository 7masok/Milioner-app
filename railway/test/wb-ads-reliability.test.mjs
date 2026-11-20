import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { PGlite } from '@electric-sql/pglite';
import { withGrowthAnalyticsPage } from '../src/growth-analytics-page.js';
import {createWbAdGroups} from '../src/wb-ad-groups.js';
import {createWbQueryHistory} from '../src/wb-query-history.js';
import {stockBlock} from '../src/wb-ad-inventory.js';

const source = readFileSync(new URL('../src/wb-ads.js', import.meta.url), 'utf8');
function harness(configured = []) {
  const calls = [], queries = [];
  const context = vm.createContext({
    console: { info() {}, warn() {}, error() {} },
    Date, Intl, URL, AbortController, setTimeout, clearTimeout, setInterval,
    express: { Router: () => ({ get() {}, put() {}, post() {}, use() {} }) },
    pool: { query: async (sql, args) => { queries.push({ sql, args }); return { rows: configured }; } },
    stockBlock, createWbQueryHistory, createWbAdGroups, config: {}, credentialFor: async () => 'test-token', requireTrustedOrigin() {}, requireWritesEnabled() {}, asyncRoute: fn => fn,
  });
  vm.runInContext(source.replace(/^import .*;\r?\n/gm, '').replace(/export /g, '') + '\nglobalThis.api = { enforce, fetchCampaigns, setStoredCampaignStatus, localDate, requestInterval, campaignName, campaignApiName, campaignPeriodMetrics, experimentStartBlock, saveBulkAdsLimits };', context);
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
  assert.ok(h.queries.some(q => q.args?.some(arg => String(arg).includes('no budget'))));
});

test('a scheduled campaign already paused by WB stays paused after exhausting today’s limit', async () => {
  const h = harness([limit(1, { scheduleEnabled: true, startTime: '00:00' })]);
  await h.api.enforce('WB', { day: h.api.localDate(), campaigns: [campaign(1, 11, 500)] });
  assert.deepEqual(h.calls, []);
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
    if (url.includes('/api/advert/v2/adverts')) return { adverts: [{ id: 1, status: 9, name: 'One' }, { id: 2, status: 9, name: 'Two' }] };
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

test('campaign list and start actions have independent WB rate-limit lanes', () => {
  const h=harness();
  assert.equal(h.api.requestInterval('https://advert-api.wildberries.ru/api/advert/v2/adverts').key,'campaign-list');
  assert.equal(h.api.requestInterval('https://advert-api.wildberries.ru/adv/v0/start?id=1').key,'/adv/v0/start');
  assert.equal(h.api.requestInterval('https://advert-api.wildberries.ru/adv/v0/pause?id=1').key,'/adv/v0/pause');
});

test('scheduler permits due starts from the stored snapshot before refresh', () => {
  assert.match(source,/await enforce\(marketName, previous, \{ allowSchedule: true, allowStarts: true \}\);/);
});

test('product title never replaces a campaign name omitted by WB', () => {
  const h=harness();
  const cards=new Map([[77,{title:'Крылья',vendorCode:'wings'}]]);
  const value=h.api.campaignName({id:1,nmId:77},null,cards);
  assert.equal(value.title,'Кампания 1');
});

test('current WB campaign endpoint supplies the exact campaign name', async () => {
  const h=harness();
  h.context.mockRequest=async url=>url.includes('/api/advert/v2/adverts')?{adverts:[{id:1,status:9,name:'Крылья'}]}:{cards:[]};
  const result=await h.api.fetchCampaigns('WB',null);
  assert.equal(result.campaigns[0].name,'Крылья');
});

test('explicit WB campaign settings name wins over a generic row name', () => {
  const h=harness();
  assert.equal(h.api.campaignApiName({name:'Скелет',settings:{name:'Крылья'}}),'Крылья');
});

test('campaign statistics keep daily rows for the last 30 days while today stays separate', async () => {
  const h = harness();
  const today = h.api.localDate();
  const previous = new Date(Date.parse(today + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
  h.context.mockRequest = async url => {
    h.calls.push(url);
    if (url.includes('/api/advert/v2/adverts')) return { adverts: [{ id: 1, status: 9, name: 'One' }] };
    if (url.includes('/fullstats')) return [{
      advertId: 1,
      stats: [
        { date: previous, sum: 100, orders: 1, sum_price: 500, views: 10, clicks: 2, atbs: 1 },
        { date: today, sum: 200, orders: 2, sum_price: 1000, views: 20, clicks: 4, atbs: 2 },
      ],
    }];
    return { cards: [] };
  };
  const result = await h.api.fetchCampaigns('WB', { day: today, campaigns: [] });
  const row = result.campaigns[0];
  assert.equal(row.todaySpend, 200);
  assert.equal(row.orders, 2);
  assert.equal(row.periodMetrics.length, 30);
  assert.deepEqual(
    Array.from(row.periodMetrics.slice(-2), x => ({ date: x.date, spend: x.spend, orders: x.orders })),
    [{ date: previous, spend: 100, orders: 1 }, { date: today, spend: 200, orders: 2 }],
  );
  const statsUrl = h.calls.find(url => url.includes('/fullstats'));
  assert.ok(statsUrl.includes('beginDate=' + result.historyFrom + '&endDate=' + result.historyTo));
});

test('experiment starts require known stock, current data, one unchanged article and bounded daily rules',async()=>{
 const h=harness([limit(1)]);h.context.testSnap={updatedAt:Date.now(),day:h.api.localDate(),campaigns:[{...campaign(1,11,0),nmIds:[777],statsStale:false}]};
 vm.runInContext('storedSnapshot=async()=>testSnap;',h.context);
 assert.equal(await h.api.experimentStartBlock('WB',1,'777'),'');
 assert.match(await h.api.experimentStartBlock('WB',1,'999'),/Состав кампании/);
 h.context.testSnap.updatedAt=Date.now()-21*60000;assert.match(await h.api.experimentStartBlock('WB',1,'777'),/свежие/);
 h.context.testSnap.updatedAt=Date.now();h.context.testSnap.campaigns[0].statsStale=true;assert.match(await h.api.experimentStartBlock('WB',1,'777'),/свежие/);
 h.context.testSnap.campaigns[0].status=4;assert.equal(await h.api.experimentStartBlock('WB',1,'777'),'');
 const manual=harness([limit(1,{manualPaused:true})]);manual.context.testSnap=h.context.testSnap;vm.runInContext('storedSnapshot=async()=>testSnap;',manual.context);assert.match(await manual.api.experimentStartBlock('WB',1,'777'),/Ручная пауза/);
 const scheduled=harness([limit(1,{scheduleEnabled:true})]);scheduled.context.testSnap=h.context.testSnap;vm.runInContext('storedSnapshot=async()=>testSnap;',scheduled.context);assert.match(await scheduled.api.experimentStartBlock('WB',1,'777'),/ежедневный запуск/);
});

test('bulk advertising settings update selected campaigns atomically with independent fields', async () => {
  const db=new PGlite();
  try {
    for (const file of ['005_wb_ad_limits.sql','010_wb_ads_snapshots.sql','012_wb_ads_auto_resume.sql',
      '013_wb_ads_start_schedule.sql','014_wb_ads_manual_pause.sql','016_wb_ads_stock_protection.sql']) {
      await db.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
    }
    await db.query("INSERT INTO wb_ads_snapshots (market,payload) VALUES ('WB',$1),('WB2',$2)",[
      {campaigns:[campaign(1),campaign(2),campaign(3,7)]},{campaigns:[campaign(1)]},
    ]);
    await db.exec(`INSERT INTO wb_ad_limits
      (market,campaign_id,daily_limit,enabled,schedule_enabled,start_time,manual_paused,stock_paused,low_stock_mode,updated_at)
      VALUES ('WB',1,300,true,true,'07:00',true,true,'pause',0),('WB2',1,900,true,false,'10:00',false,false,'warn',0)`);
    const h=harness();
    h.context.pool.query=(...args)=>db.query(...args);
    const read=async (market,id)=>(await db.query('SELECT * FROM wb_ad_limits WHERE market=$1 AND campaign_id=$2',[market,id])).rows[0];
    await assert.rejects(h.api.saveBulkAdsLimits('WB',{campaignIds:[1,3],dailyLimit:450}),{status:409});
    assert.equal((await read('WB',1)).daily_limit,'300');
    await assert.rejects(h.api.saveBulkAdsLimits('WB',{campaignIds:[1],startTime:'25:00'}),{status:400});
    const saved=await h.api.saveBulkAdsLimits('WB',{campaignIds:[2,1,1],dailyLimit:600});
    assert.equal(saved.updated,2);
    let row=await read('WB',1);
    assert.equal(row.daily_limit,'600');
    assert.equal(row.start_time,'07:00');
    assert.equal(row.manual_paused,true);
    assert.equal(row.stock_paused,true);
    assert.equal(row.low_stock_mode,'pause');
    assert.equal((await read('WB',2)).schedule_enabled,false);
    await h.api.saveBulkAdsLimits('WB',{campaignIds:[2,1],startTime:'08:30'});
    row=await read('WB',2);
    assert.equal(row.daily_limit,'600');
    assert.equal(row.schedule_enabled,true);
    assert.equal(row.start_time,'08:30');
    assert.equal((await read('WB2',1)).daily_limit,'900');
    await h.api.saveBulkAdsLimits('WB',{campaignIds:[1],dailyLimit:0});
    row=await read('WB',1);
    assert.equal(row.enabled,false);
    assert.equal(row.schedule_enabled,true);
    assert.equal(row.manual_paused,true);
  } finally {await db.close();}
});

test('bulk settings module adds a toolbar button and sends only edited fields', async () => {
  const module=readFileSync(new URL('../../wb-ads-bulk-v1.js',import.meta.url),'utf8');
  const html=withGrowthAnalyticsPage('<head></head><script>initOwnerAuth();</script>');
  const script=html.match(/<script data-source="wb-ads-bulk-v1\.js">\n([\s\S]+?)<\/script>/);
  assert.equal(script?.[1],module);
  assert.ok(script.index<html.indexOf('<script>initOwnerAuth();</script>'));
  const calls=[];
  let sheet='',closed=0;
  const filters={children:[],scrollLeft:7,prepend(node){this.children.unshift(node);}};
  const context=vm.createContext({
    document:{head:{append(){}},getElementById:()=>filters,createElement:()=>({addEventListener(){}})},
    adsMarket:'WB2',adsDashboardData:{campaigns:[{id:21,name:'Кампания'}]},
    drawAdsDashboard(){filters.children=[];},esc:String,wbAdsMoneyText:String,
    showSheet(value){sheet=value;},closeModal(){closed++;},queueAdsRender(){},
    adsApi:async (url, options)=>calls.push([url,JSON.parse(options.body)]),
    FormData:class{constructor(form){this.fields=form.fields;}get(key){return this.fields[key];}getAll(key){return this.fields[key];}},
  });
  context.window=context;
  vm.runInContext(module,context);
  context.drawAdsDashboard();
  assert.deepEqual(filters.children.map(x=>x.textContent),['Лимит и время']);
  context.openWbAdsBulkSettings();
  assert.match(sheet,/Лимит и время · WB2/);
  assert.match(sheet,/name="campaign" value="21"/);
  const status={},button={};
  const form={dataset:{market:'WB2'},isConnected:true,fields:{campaign:['21'],dailyLimit:'',startTime:'08:30'},querySelector:key=>key==='[data-bulk-error]'?status:button};
  await context.saveWbAdsBulkSettings(form);
  assert.deepEqual(calls,[['/api/promotion/limits-bulk/WB2',{campaignIds:[21],startTime:'08:30'}]]);
  assert.equal(closed,1);
  context.adsMarket='Kaspi';
  context.drawAdsDashboard();
  assert.deepEqual(filters.children,[]);
});
