import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ui = readFileSync(new URL('../../business-dashboard-v1.js', import.meta.url), 'utf8');
const report = readFileSync(new URL('../../kaspi-report-v2.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');

test('business dashboard exposes day week month year and profit layers', () => {
  for (const word of ['День','Неделя','Месяц','Год','Заказы','Выкупы','Прибыль заказов','Прибыль выкупов','Чистая прибыль']) assert.match(ui, new RegExp(word));
  assert.match(ui, /BUSINESS_SUPPORTED_MARKETS=new Set\(\['Kaspi','WB','WB2'\]\)/);
  assert.match(ui, /allMarketUnitProfit30/);
  assert.match(ui, /loadBusinessMarketplaceSummary/);
});

test('business net profit subtracts only included finance expenses', () => {
  assert.match(ui, /financeAnalyticsEntry\(tx\)/);
  assert.match(ui, /financeAnalyticsEntryIncluded/);
  assert.match(ui, /financeCountsInIncomeExpense/);
  assert.match(ui, /netProfit=\(Number\(summary\?\.profit\)\|\|0\)-finance\.total/);
  assert.match(ui, /двойной учёт/);
  assert.match(ui, /Ozon пока не входит/);
});

test('business marketplace summary reuses canonical Kaspi and WB finance models', () => {
  assert.match(report, /window\.loadBusinessMarketplaceSummary/);
  assert.match(report, /loadKaspiOrders\(n/);
  assert.match(report, /loadWbModel\('WB',n\)/);
  assert.match(report, /loadWbModel\('WB2',n\)/);
  assert.match(report, /reportProfitView\(kaspi\)/);
});

test('business dashboard asset is loaded and served', () => {
  assert.match(html, /business-dashboard-v1\.js\?v=20260922-business1/);
  assert.match(server, /'business-dashboard-v1\.js'/);
});
