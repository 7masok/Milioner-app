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

test('WB synchronization uses official paginated finance and promotion cost methods', () => {
  const source = readFileSync(new URL('../src/wb-sync.js', import.meta.url), 'utf8');
  assert.match(source, /statistics-api\.wildberries\.ru/);
  assert.match(source, /reportDetailByPeriod/);
  assert.match(source, /rrdid/);
  assert.match(source, /\/adv\/v1\/upd/);
  assert.match(source, /INSERT INTO wb_ad_costs/);
  assert.match(source, /previousRun\.finance_ok/);
  assert.match(source, /previousRun\.promotion_ok/);
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
