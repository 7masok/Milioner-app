import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { financeRowsFromPayload, promotionCostDay, promotionCostRowsFromPayload } from '../src/wb-finance.js';

const rows = [{ rrdId: 10 }, { rrdId: 11 }];

test('reads legacy top-level WB finance arrays', () => {
  assert.deepEqual(financeRowsFromPayload(rows), rows);
});

test('reads nested responses from the current WB finance API', () => {
  assert.deepEqual(financeRowsFromPayload({ data: { rows } }), rows);
  assert.deepEqual(financeRowsFromPayload({ result: { items: rows } }), rows);
});

test('does not invent rows for an empty WB response', () => {
  assert.deepEqual(financeRowsFromPayload({ data: [] }), []);
});

test('reads WB promotion costs and preserves the WB calendar day', () => {
  const rows = [{ advertId: 44, updTime: '2026-09-02T23:50:00+03:00', updSum: 500 }];
  assert.deepEqual(promotionCostRowsFromPayload(rows), rows);
  assert.equal(promotionCostDay(rows[0]), '2026-09-02');
  assert.equal(promotionCostDay({ updTime: null }), '');
});

test('WB synchronization uses the current Finance API and paginates by rrdId', () => {
  const source = readFileSync(new URL('../src/wb-sync.js', import.meta.url), 'utf8');
  assert.match(source, /finance-api\.wildberries\.ru/);
  assert.match(source, /\/api\/finance\/v1\/sales-reports\/detailed/);
  assert.match(source, /method:\s*'POST'/);
  assert.match(source, /rrdId/);
  assert.match(source, /rrDate/);
  assert.match(source, /paidStorage/);
  assert.match(source, /paidAcceptance/);
  assert.match(source, /sellerOperName/);
  assert.match(source, /deliveryService/);
  assert.doesNotMatch(source, /reportDetailByPeriod/);
  assert.match(source, /\/adv\/v1\/upd/);
  assert.match(source, /INSERT INTO wb_ad_costs/);
  assert.match(source, /previousRun\.finance_ok/);
  assert.match(source, /previousRun\.promotion_ok/);
  assert.match(source, /FINANCE_FAILURE_RETRY_MS/);
  assert.match(source, /failure-cooldown/);
});

test('browser sync avoids five-second warehouse polling and duplicate order loads', () => {
  const source = readFileSync(new URL('../../cloud-sync-v3.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /setInterval\(\(\)=>pullWarehouseFromServer\(\),5000\)/);
  assert.match(source, /visibilityState==='visible'/);
  assert.match(source, /sharedOrderCacheInFlight/);
});

test('WB report period switching is UI-only and the legacy finance renderer stays authoritative', () => {
  const page = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  const handler = page.match(/function setReportPeriod\(days\)\{([^}]*)\}/);
  assert.ok(handler, 'report period handler must exist');
  assert.doesNotMatch(handler[1], /\bsave\s*\(/, 'period taps must not PUT the warehouse snapshot');
  assert.doesNotMatch(handler[1], /saveLocalOnly\s*\(/, 'period taps must not serialize the whole warehouse locally');
  assert.match(handler[1], /rememberReportPeriodUiPreference/);
  assert.match(handler[1], /renderReports\(\)/);

  const renderer = readFileSync(new URL('../../kaspi-report-v2.js', import.meta.url), 'utf8');
  assert.match(renderer, /\[data-report-period\]/);
  assert.match(renderer, /dataset\.reportPeriod/);
  const marketHandler = renderer.match(/window\.setReportMarket=function\(market\)\{([^}]*)\}/);
  assert.ok(marketHandler, 'report market handler must exist');
  assert.doesNotMatch(marketHandler[1], /\bsave\s*\(/, 'report market tabs must not PUT the warehouse snapshot');
  assert.match(marketHandler[1], /milioner_report_market_ui_v1/);

  const compat = readFileSync(new URL('../../purchase-arrival-sort-v1.js', import.meta.url), 'utf8');
  assert.doesNotMatch(compat, /wbRenderFresh|wb-dashboard-buyouts|window\.renderReports|window\.setReportPeriod/);

  const reports = readFileSync(new URL('../src/reports.js', import.meta.url), 'utf8');
  assert.match(reports, /wb_finance_rows WHERE market=\$1 AND rr_date >= \$2 AND rr_date < \$3/);
  assert.match(reports, /WHERE f\.market=\$1 AND f\.rr_date >= \$2 AND f\.rr_date < \$3/);
  assert.doesNotMatch(reports, /CASE WHEN trim\(f?\.?doc_type\).*sale_date/);
});

test('WB product report keeps multi-product advertising unallocated', () => {
  const source = readFileSync(new URL('../src/reports.js', import.meta.url), 'utf8');
  assert.match(source, /ids\.length !== 1/);
  assert.match(source, /unmatchedAdvertising/);
  assert.match(source, /wbExpenses/);
  const ui = readFileSync(new URL('../../kaspi-report-v2.js', import.meta.url), 'utf8');
  assert.match(ui, /Себестоимость<\/th><th>Расходы WB<\/th><th>Реклама<\/th><th>Прибыль/);
  assert.match(ui, /не распределена по товарам наугад/);
});
