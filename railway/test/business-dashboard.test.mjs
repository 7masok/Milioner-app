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

test('business day chart uses real overlapping bars and no separate yesterday cap', () => {
  assert.match(ui, /business-yesterday-bar/);
  assert.doesNotMatch(ui, /business-yesterday-cap/);
  assert.match(ui, /border-top:3px solid #9d9da3/);
  assert.match(ui, /yesterdayShorter=sameSide&&!equal&&Math\.abs\(yv\)<Math\.abs\(v\)/);
  assert.match(ui, /todayShorter=sameSide&&!equal&&Math\.abs\(v\)<Math\.abs\(yv\)/);
  assert.match(ui, /todayZ=todayShorter\|\|equal\?3:2,yesterdayZ=yesterdayShorter\?3:1/);
  assert.match(ui, /todayHeight=equal/);
  assert.match(ui, /сегодня .* вчера/);
});
test('business x-axis labels are 03 through 24 without 00', () => {
  assert.match(ui, /\[3,6,9,12,15,18,21,24\]/);
  assert.match(ui, /h===24\?100:\(\(h-\.5\)\/24\*100\)/);
  assert.match(ui, /String\(h\)\.padStart\(2,'0'\)/);
  assert.doesNotMatch(ui, /grid-column:\$\{i\+1\}/);
});

test('business card shows yesterday on the right and compares only through the same time of day', () => {
  assert.match(ui, /business-value-grid/);
  assert.match(ui, /businessYesterdayValue/);
  assert.match(ui, /businessYesterdayMeta/);
  assert.match(ui, /businessYesterdaySameTime/);
  assert.match(ui, /businessElapsedTodayMs/);
  assert.match(ui, /partialBounds=\{start:fullYesterday\.bounds\.start,end:cutoff/);
  assert.match(ui, /businessOrderGroups\(partialBounds\)/);
  assert.match(ui, /businessFinanceExpenses\(partialBounds,financeBuckets\)/);
  assert.match(ui, /yesterdayCompare=businessYesterdaySameTime\(yesterday\)/);
  assert.match(ui, /до '\+businessHourMinute/);
  assert.match(ui, /разница/);
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
  assert.match(html, /business-dashboard-v1\.js\?v=20260922-business10/);
  assert.match(server, /'business-dashboard-v1\.js'/);
});

test('business dashboard has no verbose explanatory novel below the chart', () => {
  assert.doesNotMatch(ui, /businessWarning/);
  assert.doesNotMatch(ui, /вчера в карточке — только до этого же времени/);
  assert.doesNotMatch(ui, /короткий столбик перекрывает длинный/);
  assert.match(ui, /openBusinessDashboardDetails\(\).*Расшифровка/);
});


test('legacy store note cleanup removes the long marketplace explainer', () => {
  assert.match(ui, /function businessRemoveLegacyStoreNote\(\)/);
  assert.match(ui, /часть себестоимости не определена/);
  assert.match(ui, /налоги, аренда, зарплаты/);
  assert.match(ui, /MutationObserver/);
});
