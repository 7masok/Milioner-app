import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
const report=readFileSync(new URL('../../kaspi-report-v2.js',import.meta.url),'utf8');
const compat=readFileSync(new URL('../../kaspi-status-compat-v1.js',import.meta.url),'utf8');
const kaspiAds=readFileSync(new URL('../../kaspi-ads-v2-original.js',import.meta.url),'utf8');

test('product list shows selected-period sales, total profit and unit profit',()=>{
  const line=html.split('\n').find(row=>row.startsWith('function productCard('));
  assert.match(line,/Себестоимость/);
  assert.match(line,/Продано · \$\{esc\(period\.label\)\}/);
  assert.match(line,/Прибыль · \$\{esc\(period\.label\)\}/);
  assert.match(line,/Прибыль \/ шт\./);
  assert.match(line,/qty=periodReady\?Math\.max/);
  assert.match(line,/profitText=periodReady\?fmt/);
  assert.match(line,/unitProfitText=periodReady&&qty>0\?fmt/);
});

test('projected stock profit follows the selected Product period transparently',()=>{
  assert.match(html,/Ожидаемая прибыль с остатка/);
  assert.match(html,/onclick="openStockProfitBreakdown\(\)"/);
  assert.match(html,/function warehouseProjectedProfitRows\(profitStats\)/);
  assert.match(html,/свободный остаток × чистая прибыль на 1 проданную штуку за выбранный период/);
  assert.match(html,/продано · '\+esc\(label\)/);
  assert.match(html,/stats\.periodReady\?fmt\(warehouseProjectedProfit\(periodStats\)\):'—'/);
  assert.match(html,/rows=warehouseProjectedProfitRows\(stats\.periodStats\)/);
  assert.match(html,/выбранному периоду: Kaspi \+ WB1 \+ WB2 \+ Ozon/);
});



test('product details use combined 30-day net profit including Kaspi and WB advertising',()=>{
  assert.match(html,/async function openProduct\(pid,market='',days=30\)/);
  assert.match(html,/window\.refreshAllMarketUnitProfit/);
  assert.match(html,/Реклама Kaspi \+ WB1 \+ WB2 \+ Ozon за 30 дней/);
  assert.match(html,/Чистая прибыль за 30 дней/);
  assert.match(html,/после себестоимости, комиссий, логистики, рекламы и возвратов/);
  assert.match(html,/combined30\?Math\.max\(0,Number\(combined30\.ads\)/);
  assert.match(html,/По магазинам/);
});


test('unified Product-period profit includes Ozon and supports an explicit custom range',()=>{
  assert.match(report,/window\.refreshProductPeriodStats=function/);
  assert.match(report,/loadOzonSummary\(days,\{range\}\)/);
  assert.match(report,/loadWbModel\('WB',days,\{range\}\)/);
  assert.match(report,/add\(pid,qty,Number\(x\?\.profit\)\|\|0,'Ozon'/);
  assert.match(report,/periodCacheKey\(days,range\)/);
  assert.match(compat,/window\.summarizeOzonReport=async function\(days,range=null\)/);
  assert.match(compat,/ozonProfitModel\(payload,days,range\)/);
  assert.match(html,/Не удалось загрузить единый расчёт прибыли за выбранный период/);
  assert.match(report,/kaspi=buildModel\(kaspiSnapshot,days,range\)/);
  assert.match(report,/kaspiAdsBreakdown\(days,range\)/);
  assert.match(kaspiAds,/function breakdown\(days = reportPeriod, range = null\)/);
  assert.match(kaspiAds,/effectiveRows\(days, '', range\)/);
});
