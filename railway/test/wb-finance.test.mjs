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
  assert.match(source, /FINANCE_FAILURE_RETRY_MS = 65 \* 60 \* 1000/);
  assert.match(source, /LIVE_SALES_RETRY_MS = 65 \* 60 \* 1000/);
  assert.match(source, /next_allowed_at/);
});

test('browser sync avoids five-second warehouse polling and duplicate order loads', () => {
  const source = readFileSync(new URL('../../cloud-sync-v3.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /setInterval\(\(\)=>pullWarehouseFromServer\(\),5000\)/);
  assert.match(source, /visibilityState==='visible'/);
  assert.match(source, /sharedOrderCacheInFlight/);
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
  assert.match(source, /LIVE_SALES_SYNC_MS = 30 \* 60 \* 1000/);
  assert.match(source, /INSERT INTO wb_sales_live_rows/);
  assert.match(source, /ON CONFLICT\(market,sale_id\)/);
  assert.match(source, /wb_sales_live_state/);
  assert.match(source, /lastChangeDate/);
  assert.match(source, /syncLiveSales\(market, token\)/);
  assert.match(source, /Promise\.all\(\[/);
});
