import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ui = readFileSync(new URL('../../business-dashboard-v1.js', import.meta.url), 'utf8');
const report = readFileSync(new URL('../../kaspi-report-v2.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');

test('business dashboard is day-only and keeps all agreed profit layers', () => {
  for (const word of ['Сегодня','Заказы','Выкупы','Прибыль заказов','Прибыль выкупов']) assert.match(ui, new RegExp(word));
  assert.doesNotMatch(ui, /Чистая прибыль/);
  for (const word of ['Неделя','Месяц','Год']) assert.equal(ui.includes(word),false);
  assert.match(ui, /BUSINESS_PERIODS=new Set\(\['day'\]\)/);
  assert.match(ui, /BUSINESS_METRICS=new Set\(\['orders','buyouts','orderProfit','buyoutProfit'\]\)/);
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
});

test('business card shows yesterday on the right and compares only through the same time of day', () => {
  assert.match(ui, /business-value-grid/);
  assert.match(ui, /businessYesterdayValue/);
  assert.match(ui, /businessYesterdaySameTime/);
  assert.match(ui, /businessElapsedTodayMs/);
  assert.match(ui, /partialBounds=\{start:fullYesterday\.bounds\.start,end:cutoff/);
  assert.match(ui, /businessOrderGroups\(partialBounds\)/);
  assert.doesNotMatch(ui, /businessFinanceExpenses/);
  assert.match(ui, /netProfit=profit/);
  assert.match(ui, /yesterdayCompare=businessYesterdaySameTime\(yesterday\)/);
});

test('business profit no longer subtracts Finance-tab expenses', () => {
  assert.doesNotMatch(ui, /Расходы бизнеса из «Финансов»/);
  assert.doesNotMatch(ui, /двойной учёт/);
  assert.doesNotMatch(ui, /financeAnalyticsEntry\(tx\)/);
  assert.match(ui, /const netProfit=summary\?\.profit===null\|\|summary\?\.profit===undefined/);
  assert.match(ui, /meta:model\.summary\.estimated\?'≈ по данным маркетплейсов':'по данным маркетплейсов'/);
});

test('WB today business summary falls back to live buyouts instead of false zeros', () => {
  assert.match(report, /ensureWbLiveOverview\('WB',n\)/);
  assert.match(report, /ensureWbLiveOverview\('WB2',n\)/);
  assert.match(report, /businessWbLiveStats/);
  assert.match(report, /liveRevenue>0\|\|liveQty>0/);
  assert.match(report, /allMarketUnitProfit30/);
  assert.match(report, /historyProfit\/historyQty/);
  assert.match(report, /estimated:true,live:true/);
  assert.match(html, /let zeroCandidate=null/);
  assert.match(html, /hasBuyouts=.*buyoutCount/);
  assert.match(html, /zeroCandidate\|\|data/);
});

test('money formatting removes negative zero and unknown WB fields render as dash', () => {
  assert.match(ui, /Math\.abs\(raw\)>=\.005\?raw:0/);
  assert.match(ui, /function businessMaybeMoney/);
  assert.match(ui, /function businessExpenseMoney/);
  assert.match(ui, /return '—'/);
});

test('business dashboard assets are cache-busted and served', () => {
  assert.match(html, /kaspi-report-v2\.js\?v=20260923-report-unify/);
  assert.match(html, /business-dashboard-v1\.js\?v=20260922-business14/);
  assert.match(server, /'business-dashboard-v1\.js'/);
});

test('business dashboard has no breakdown button or breakdown sheet', () => {
  assert.doesNotMatch(ui, /Расшифровка/);
  assert.doesNotMatch(ui, /openBusinessDashboardDetails/);
  assert.doesNotMatch(ui, /business-foot/);
});

test('legacy store note cleanup remains active', () => {
  assert.match(ui, /function businessRemoveLegacyStoreNote\(\)/);
  assert.match(ui, /MutationObserver/);
});


test('known marketplace values remain visible when another marketplace is unknown', () => {
  assert.match(report, /knownCount=\{cost:0,fees:0,profit:0\}/);
  assert.match(report, /knownCount\[keyName\]\+\+/);
  assert.match(report, /if\(knownCount\[keyName\]===0\)total\[keyName\]=null/);
  assert.match(report, /if\(knownCount\[keyName\]<sourceCount\)partial\[keyName\]=true/);
  assert.match(report, /estimated:total\.estimated\|\|partial\.cost\|\|partial\.fees\|\|partial\.profit/);
  assert.match(report, /qty===0&&revenue===0&&ads!==0\?-Math\.abs\(ads\):null/);
});


test('legacy net profit selection migrates to buyout profit and four buttons stay 2x2', () => {
  assert.match(ui, /saved\.metric==='netProfit'\)businessMetric='buyoutProfit'/);
  assert.doesNotMatch(ui, /\['netProfit','Чистая прибыль'\]/);
  assert.doesNotMatch(ui, /business-metrics button:last-child/);
});


test('report market selection is local UI state and does not restore stale WB2 from cloud', () => {
  assert.match(report, /REPORT_MARKET_UI_KEY='milioner_report_market_v1'/);
  assert.match(report, /localStorage\.getItem\(REPORT_MARKET_UI_KEY\)/);
  assert.match(report, /return REPORT_MARKETS\.includes\(saved\)\?saved:'all'/);
  assert.match(report, /state\.settings\.reportMarket=reportMarket/);
  assert.match(report, /localStorage\.setItem\(REPORT_MARKET_UI_KEY,market\)/);
  assert.doesNotMatch(report, /reportMarket=\['all','Kaspi','WB','WB2'\]\.includes\(state\.settings\.reportMarket\)/);
  assert.doesNotMatch(report, /state\.settings\.reportMarket=market;try\{save\(\)\}/);
  assert.match(html, /kaspi-report-v2\.js\?v=20260923-report-unify/);
});
