import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  normalizeOzonClusterAnalytics,
  estimateOzonLeadTimes,
  buildOzonReplenishmentRows,
  mergeAnalyticsCycleRows
} from '../src/ozon-replenishment.js';

const backend=readFileSync(new URL('../src/ozon-fbo.js',import.meta.url),'utf8');
const ui=readFileSync(new URL('../../ozon-fbo-v1.js',import.meta.url),'utf8');
const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
const passport=readFileSync(new URL('../../docs/SITE-PASSPORT.md',import.meta.url),'utf8');
const agents=readFileSync(new URL('../../AGENTS.md',import.meta.url),'utf8');

function item(overrides={}){
  return {
    sku:'1001',offer_id:'SKU-1',name:'Товар 1',cluster_id:'10',cluster_name:'Алматы',
    warehouse_id:'501',warehouse_name:'Склад 501',
    ads_cluster:2,idc_cluster:3,days_without_sales_cluster:0,turnover_grade_cluster:'ACTUAL',
    available_stock_count:5,transit_stock_count:2,requested_stock_count:1,valid_stock_count:0,
    ...overrides
  };
}
function completed(days,warehouse='501',start='2026-09-01T00:00:00Z'){
  const from=Date.parse(start);
  return {
    state:'COMPLETED',
    created_date:new Date(from).toISOString(),
    state_updated_date:new Date(from+days*86_400_000).toISOString(),
    supplies:[{storage_warehouse:{warehouse_id:warehouse}}]
  };
}

test('Ozon cluster normalization sums warehouses but counts cluster sales once',()=>{
  const rows=normalizeOzonClusterAnalytics([
    item(),
    item({warehouse_id:'502',warehouse_name:'Склад 502',available_stock_count:4,transit_stock_count:1,requested_stock_count:0,valid_stock_count:3})
  ]);
  assert.equal(rows.length,1);
  assert.equal(rows[0].available,9);
  assert.equal(rows[0].transit,3);
  assert.equal(rows[0].requested,1);
  assert.equal(rows[0].valid,3);
  assert.equal(rows[0].incomingKnown,7);
  assert.equal(rows[0].adsCluster,2);
});

test('duplicate analytics rows for the same warehouse do not multiply stock',()=>{
  const rows=normalizeOzonClusterAnalytics([item(),item()]);
  assert.equal(rows[0].available,5);
  assert.equal(rows[0].transit,2);
  assert.equal(rows[0].requested,1);
});

test('different Ozon clusters remain separate recommendations',()=>{
  const rows=normalizeOzonClusterAnalytics([item(),item({cluster_id:'11',cluster_name:'Астана',warehouse_id:'601'})]);
  assert.equal(rows.length,2);
  assert.deepEqual(rows.map(row=>row.clusterId),['10','11']);
});

test('cluster analytics preserves IDC, days without sales and turnover grade',()=>{
  const row=normalizeOzonClusterAnalytics([item({idc_cluster:6.5,days_without_sales_cluster:4,turnover_grade_cluster:'DEFICIT'})])[0];
  assert.equal(row.idcCluster,6.5);
  assert.equal(row.daysWithoutSalesCluster,4);
  assert.equal(row.turnoverGradeCluster,'DEFICIT');
});

test('lead time uses median completed supply history per warehouse',()=>{
  const lead=estimateOzonLeadTimes([completed(3),completed(5),completed(9,'777')]);
  assert.equal(lead.byWarehouse['501'].leadDays,4);
  assert.equal(lead.byWarehouse['501'].samples,2);
});

test('global lead time requires at least three completed history samples',()=>{
  const noGlobal=estimateOzonLeadTimes([completed(2,'1'),completed(4,'2')]);
  assert.equal(noGlobal.global,null);
  const global=estimateOzonLeadTimes([completed(2,'1'),completed(4,'2'),completed(6,'3')]);
  assert.equal(global.global.leadDays,4);
  assert.equal(global.global.samples,3);
});

test('lead time ignores unfinished and implausibly long supply history',()=>{
  const bad={...completed(3),state:'IN_TRANSIT'};
  const tooLong=completed(60);
  assert.deepEqual(estimateOzonLeadTimes([bad,tooLong]),{global:null,byWarehouse:{}});
});

test('without reliable lead history recommendation shows shortage but no invented send date',()=>{
  const rows=buildOzonReplenishmentRows([item({available_stock_count:5,transit_stock_count:0,requested_stock_count:0,valid_stock_count:0})],[],{targetDays:14,now:0});
  assert.equal(rows[0].targetQty,28);
  assert.equal(rows[0].shortageNow,23);
  assert.equal(rows[0].exact,false);
  assert.equal(rows[0].sendQty,null);
  assert.equal(rows[0].sendAt,null);
});

test('no cluster sales means no automatic shipment quantity',()=>{
  const row=buildOzonReplenishmentRows([item({ads_cluster:0})],[completed(3),completed(3)],{targetDays:14})[0];
  assert.equal(row.exact,false);
  assert.equal(row.sendQty,null);
  assert.match(row.reason,/Нет среднесуточных продаж/);
});

test('Ozon IDC is preferred for current cluster days-left display',()=>{
  const row=buildOzonReplenishmentRows([item({available_stock_count:20,ads_cluster:2,idc_cluster:4})],[],{targetDays:14})[0];
  assert.equal(row.daysLeft,4);
  assert.equal(row.daysWithIncoming,11.5);
});

test('history-backed recommendation accounts for known incoming supply and 14-day target',()=>{
  const now=Date.UTC(2026,8,28);
  const history=[completed(3),completed(3,'501','2026-09-10T00:00:00Z')];
  const row=buildOzonReplenishmentRows([
    item({available_stock_count:10,transit_stock_count:2,requested_stock_count:1,valid_stock_count:1,ads_cluster:2})
  ],history,{targetDays:14,now})[0];
  assert.equal(row.incomingKnown,4);
  assert.equal(row.daysWithIncoming,7);
  assert.equal(row.leadDays,3);
  assert.equal(row.exact,true);
  assert.equal(row.sendQty,28);
  assert.equal(row.sendAt,now+4*86_400_000);
});

test('known transit/requested/valid stock reduces immediate 14-day shortage',()=>{
  const without=buildOzonReplenishmentRows([item({available_stock_count:4,transit_stock_count:0,requested_stock_count:0,valid_stock_count:0})],[],{targetDays:14})[0];
  const withIncoming=buildOzonReplenishmentRows([item({available_stock_count:4,transit_stock_count:3,requested_stock_count:2,valid_stock_count:1})],[],{targetDays:14})[0];
  assert.equal(without.shortageNow,24);
  assert.equal(withIncoming.shortageNow,18);
});

test('analytics cycle merge replaces duplicate warehouse row instead of duplicating it',()=>{
  const old=[item({available_stock_count:5})];
  const fresh=[item({available_stock_count:7})];
  const merged=mergeAnalyticsCycleRows(old,fresh);
  assert.equal(merged.length,1);
  assert.equal(merged[0].available_stock_count,7);
});

test('Ozon backend requests at most 100 SKUs per analytics cycle step and persists cursor',()=>{
  assert.match(backend,/const ANALYTICS_CHUNK_SIZE=100/);
  assert.match(backend,/skus\.slice\(cursor,cursor\+ANALYTICS_CHUNK_SIZE\)/);
  assert.match(backend,/requestAnalyticsStocksChunk\(credentials,chunk\)/);
  assert.match(backend,/workingRows/);
  assert.match(backend,/cursor:cycleComplete\?0:nextCursor/);
});

test('Ozon 429 handling retains last analytics rows and stores a retry deadline',()=>{
  assert.match(backend,/response\.status===429/);
  assert.match(backend,/retry-after/);
  assert.match(backend,/item-retry-after/);
  assert.match(backend,/const rows=Array\.isArray\(prev\.rows\)\?prev\.rows:\[\]/);
  assert.match(backend,/nextAllowedAt:retryAt/);
  assert.match(backend,/stale:true/);
});

test('Reports Ozon renders compact cluster replenishment even when finance rows are empty',()=>{
  assert.match(ui,/Пополнение FBO · 14 дней/);
  assert.match(ui,/Остаток/);
  assert.match(ui,/Дней/);
  assert.match(ui,/В пути/);
  assert.match(ui,/Отправить/);
  assert.match(ui,/Дата/);
  assert.match(ui,/box\.innerHTML=replenishment\+'<div class="empty">/);
  assert.match(html,/\.ozon-replenishment-metrics/);
  assert.match(html,/ozon-fbo-v1\.js\?v=20260928-cluster-replenishment/);
});

test('cluster replenishment documentation forbids invented exact timing without history',()=>{
  assert.match(passport,/14 дней/);
  assert.match(passport,/ads_cluster/);
  assert.match(passport,/точн/i);
  assert.match(agents,/\/v1\/analytics\/stocks/);
});
