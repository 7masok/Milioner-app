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

test('WB synchronization uses current Finance API, daily rows and prunes stale snapshot rows', () => {
  const source = readFileSync(new URL('../src/wb-sync.js', import.meta.url), 'utf8');
  assert.match(source, /finance-api\.wildberries\.ru/);
  assert.match(source, /\/api\/finance\/v1\/sales-reports\/detailed/);
  assert.match(source, /method:\s*'POST'/);
  assert.match(source, /period:\s*'daily'/);
  assert.match(source, /rrdId/);
  assert.match(source, /deliveryService/);
  assert.match(source, /paidStorage/);
  assert.match(source, /paidAcceptance/);
  assert.match(source, /sellerOperName/);
  assert.match(source, /DELETE FROM wb_finance_rows WHERE market=\$1/);
  assert.match(source, /jsonb_array_elements/);
  assert.doesNotMatch(source, /reportDetailByPeriod/);
  assert.match(source, /\/adv\/v1\/upd/);
  assert.match(source, /reuseFinance/);
  assert.match(source, /reusePromotion/);
  assert.match(source, /x-ratelimit-retry/i);
  assert.match(source, /retry_at/);
  assert.match(source, /FINANCE_SYNC_MS = 2 \* 60 \* 60 \* 1000/);
  assert.match(source, /FINANCE_FAILURE_RETRY_MS = 65 \* 60 \* 1000/);
  assert.match(source, /LIVE_SALES_RETRY_MS = 65 \* 60 \* 1000/);
  assert.match(source, /next_allowed_at/);
});

test('WB refreshes old active statuses beyond the 14-day order lookback', () => {
  const source = readFileSync(new URL('../src/wb-sync.js', import.meta.url), 'utf8');
  assert.match(source, /const LOOKBACK_DAYS = 14/);
  assert.match(source, /STALE_STATUS_REFRESH_MS = 60 \* 60 \* 1000/);
  assert.match(source, /async function refreshStoredWbStatuses\(market, token, now = Date\.now\(\)\)/);
  assert.match(source, /creation_date < \$2 AND updated_at < \$3/);
  assert.match(source, /upper\(state\)=ANY\(\$4::text\[\]\)/);
  assert.match(source, /WB stale order statuses/);
  assert.match(source, /UPDATE marketplace_order_lines SET status=\$3,state=\$4,updated_at=\$5 WHERE market=\$1 AND order_id=\$2/);
  assert.match(source, /staleStatusRefresh = await refreshStoredWbStatuses\(market, token, now\)/);
  assert.match(source, /if \(staleStatusRefresh\.changed > 0\)/);
  assert.match(source, /reconcileWbReservations\(market, now\)/);
  assert.match(source, /reconcileMarketplaceSales\(market\)/);
});

test('browser sync avoids five-second warehouse polling and duplicate order loads', () => {
  const source = readFileSync(new URL('../../cloud-sync-v3.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /setInterval\(\(\)=>pullWarehouseFromServer\(\),5000\)/);
  assert.match(source, /visibilityState==='visible'/);
  assert.match(source, /sharedOrderCacheInFlight/);
});

test('WB stock-profit denominator uses gross sales while returns stay in profit', () => {
  const source = readFileSync(new URL('../src/reports.js', import.meta.url), 'utf8');
  assert.match(source, /AS "saleQty"/);
  assert.match(source, /AS "returnQty"/);
  assert.match(source, /ABS\(f\.qty\)/);
  const ui = readFileSync(new URL('../../kaspi-report-v2.js', import.meta.url), 'utf8');
  assert.match(ui, /saleQty=Math\.max\(0,Number\(x\.saleQty\?\?netQty\)/);
  assert.match(ui, /add\(v\.pid,saleQty/);
  assert.match(ui, /productAds=Math\.max\(0,Number\(x\.advertising\)/);
  assert.match(ui, /ads:x\.ads/);
  assert.match(ui, /sources:x\.sources/);
  assert.match(ui, /const productPeriodStatsCache=new Map\(\),productPeriodStatsJobs=new Map\(\)/);
  assert.match(ui, /window\.refreshAllMarketUnitProfit=function\(\)\{return window\.refreshProductPeriodStats/);
});

test('WB advertising recovers deterministic links but keeps true multi-product spend unallocated', () => {
  const source = readFileSync(new URL('../src/reports.js', import.meta.url), 'utf8');
  assert.match(source, /async function resolveWbAdvertising\(selected, adRows = \[\]\)/);
  assert.match(source, /source: 'vendorCode'/);
  assert.match(source, /source: 'barcode'/);
  assert.match(source, /!missing\.length && productIds\.length === 1/);
  assert.match(source, /row\.nmIds\.length > 1/);
  assert.match(source, /reason = 'multiple_products'/);
  assert.match(source, /Одна рекламная сумма относится к нескольким разным товарам/);
  assert.match(source, /reportsRouter\.get\('\/wb-ad-link-audit'/);
  assert.match(source, /autoRecoveredAdvertising/);
  assert.match(source, /unmatchedAdvertising: attribution\.unmatched/);
  assert.match(source, /wbExpenses/);
  const ui = readFileSync(new URL('../../kaspi-report-v2.js', import.meta.url), 'utf8');
  assert.match(ui, /Себестоимость<\/th><th>Расходы WB<\/th><th>Реклама<\/th><th>Прибыль/);
  assert.match(ui, /не распределена по товарам наугад/);
});


test('WB report excludes WB Promotion deduction because advertising is counted separately', () => {
  const source = readFileSync(new URL('../src/reports.js', import.meta.url), 'utf8');
  assert.match(source, /wb продвижение/);
  assert.match(source, /promotionDeduction/);
  assert.match(source, /THEN 0 ELSE deduction END/);
  const ui = readFileSync(new URL('../../kaspi-report-v2.js', import.meta.url), 'utf8');
  assert.match(ui, /Удержания \(без рекламы\)/);
  assert.match(ui, /promotionDeduction/);
});


test('WB live sales cache is populated from the operational sales and returns API', () => {
  const source = readFileSync(new URL('../src/wb-sync.js', import.meta.url), 'utf8');
  assert.match(source, /statistics-api\.wildberries\.ru/);
  assert.match(source, /\/api\/v1\/supplier\/sales/);
  assert.match(source, /LIVE_SALES_SYNC_MS = 6 \* 60 \* 60 \* 1000 \+ 35 \* 60 \* 1000/);
  assert.match(source, /INSERT INTO wb_sales_live_rows/);
  assert.match(source, /ON CONFLICT\(market,sale_id\)/);
  assert.match(source, /wb_sales_live_state/);
  assert.match(source, /lastChangeDate/);
  assert.match(source, /liveSalesDisabled:\s*true/);
  assert.doesNotMatch(source, /const \[finance, liveSales\] = await Promise\.all/);
  assert.match(source, /void run\(false\)/);
});
