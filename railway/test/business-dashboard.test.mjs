import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ui = readFileSync(new URL('../../business-dashboard-v1.js', import.meta.url), 'utf8');
const report = readFileSync(new URL('../../kaspi-report-v2.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');

test('business dashboard is day-only and keeps all agreed profit layers', () => {
  for (const word of ['Сегодня','Заказы','Выкупы','Прибыль заказов','Прибыль выкупов','Чистая прибыль']) assert.match(ui, new RegExp(word));
  for (const word of ['Неделя','Месяц','Год']) assert.equal(ui.includes(word),false);
  assert.match(ui, /BUSINESS_PERIODS=new Set\(\['day'\]\)/);
  assert.match(ui, /BUSINESS_SUPPORTED_MARKETS=new Set\(\['Kaspi','WB','WB2'\]\)/);
  assert.match(ui, /allMarketUnitProfit30/);
  assert.match(ui, /loadBusinessMarketplaceSummary/);
});

test('business day chart overlays the shorter real bar over the longer one', () => {
  assert.match(ui, /for\(let h=0;h<24;h\+\+\)/);
  assert.match(ui, /grid-template-columns:repeat\(24,minmax\(0,1fr\)\)/);
  assert.match(ui, /business-x-axis/);
  assert.match(ui, /business-y-axis/);
  assert.match(ui, /business-grid-line/);
  assert.match(ui, /i%3===0/);
  assert.match(ui, /businessChartScale/);
  assert.match(ui, /business-yesterday-bar/);
  assert.doesNotMatch(ui, /business-yesterday-mark/);
  assert.match(ui, /yesterdayShorter=sameDirection&&!equal&&Math\.abs\(yv\)<Math\.abs\(v\)/);
  assert.match(ui, /todayShorter=sameDirection&&!equal&&Math\.abs\(v\)<Math\.abs\(yv\)/);
  assert.match(ui, /yZ=yesterdayShorter\?3:1,tZ=todayShorter\|\|equal\?3:2/);
  assert.match(ui, /border-top:3px solid #9d9da3/);
  assert.match(ui, /todayHeight=equal/);
  assert.match(ui, /короткий столбик перекрывает длинный/);
});
test('business net profit subtracts only included finance expenses', () => {
  assert.match(ui, /financeAnalyticsEntry\(tx\)/);
  assert.match(ui, /financeAnalyticsEntryIncluded/);
  assert.match(ui, /financeCountsInIncomeExpense/);
  assert.match(ui, /groups\.set\(key,\{name:'Без категории',amount:0\}\)/);
  assert.match(ui, /uncategorized\+=amount;total\+=amount/);
  assert.match(ui, /netProfit=\(Number\(summary\?\.profit\)\|\|0\)-finance\.total/);
  assert.match(ui, /двойной учёт/);
  assert.match(ui, /Ozon пока не входит/);
});

test('business marketplace summary reuses canonical Kaspi and WB finance models including yesterday', () => {
  assert.match(report, /window\.loadBusinessMarketplaceSummary/);
  assert.match(report, /raw===-1\?-1/);
  assert.match(report, /loadKaspiOrders\(n/);
  assert.match(report, /loadWbModel\('WB',n\)/);
  assert.match(report, /loadWbModel\('WB2',n\)/);
  assert.match(report, /reportProfitView\(kaspi\)/);
  assert.match(ui, /businessBuildDaySnapshot\(businessDayBounds\(-1\),-1/);
  assert.match(ui, /businessYesterdayCompare/);
  assert.match(ui, /вчера /);
});

test('business dashboard asset is loaded and served', () => {
  assert.match(html, /business-dashboard-v1\.js\?v=20260922-business5/);
  assert.match(server, /'business-dashboard-v1\.js'/);
});
