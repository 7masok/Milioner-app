import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ui = readFileSync(new URL('../../kaspi-report-v2.js', import.meta.url), 'utf8');
const api = readFileSync(new URL('../src/reports.js', import.meta.url), 'utf8');
const note = ui.slice(ui.indexOf('function wbFinanceAvailabilityNote('), ui.indexOf('function wbLiveCostCoverageNote('));
const c = { esc: text => text.replaceAll('<', '&lt;') };
vm.runInNewContext(note, c);
const now = Date.parse('2026-10-13T01:40:00+05:00');
const latest = Date.parse('2026-10-11T00:00:00Z');
const retry = Date.parse('2026-10-13T10:34:00+05:00');

test('pending screenshot profit explains the finance date, 429 and Almaty retry time', () => {
  const html = c.wbFinanceAvailabilityNote({ financeAvailable: false, history: { lastOperationAt: String(latest) },
    sync: { financeOk: 0, error: 'WB Finance report HTTP 429: rate limit exceeded', retryAt: String(retry) } },
  { awaitingFinance: true, costComplete: false, costUnknownUnits: 3 }, now);
  assert.match(html, /Последняя дата в загруженной детализации: 11\.10/);
  assert.match(html, /WB ограничил загрузку финансового отчёта/);
  assert.match(html, /13\.10.*10:34.*по Алматы/);
  assert.match(html, /неизвестна себестоимость 3 шт/);
  assert.doesNotMatch(html, /прибыль.*[0-9]+ ₸/);
});

test('successful load with a lagging financial period still explains pending profit', () => {
  const html = c.wbFinanceAvailabilityNote({ financeAvailable: false, history: { lastOperationAt: latest }, sync: { financeOk: 1 } },
    { awaitingFinance: true, costComplete: true }, now);
  assert.match(html, /ожидает финансовые расходы WB/);
  assert.match(html, /11\.10/);
  assert.doesNotMatch(html, /ограничил|не удалась|Следующая попытка|неизвестна себестоимость/);
});

test('advertising-only failure does not claim a finance rate limit or retry', () => {
  const html = c.wbFinanceAvailabilityNote({ financeAvailable: true, sync: { financeOk: 1, promotionOk: 0,
    error: 'WB Promotion costs HTTP 429', retryAt: retry } }, { awaitingFinance: true }, now);
  assert.match(html, /ожидает/);
  assert.doesNotMatch(html, /ограничил|не удалась|Следующая попытка/);
});

test('expired retry is not promised as the next attempt, and unsafe raw errors are not displayed', () => {
  const html = c.wbFinanceAvailabilityNote({ financeAvailable: false, sync: { financeOk: 0, retryAt: now - 1,
    error: '<script>private error</script>' } }, { awaitingFinance: true }, now);
  assert.match(html, /не удалась/);
  assert.doesNotMatch(html, /Следующая попытка|private error|<script>/);
});

test('known financial profit has no pending banner; auth failures explain the required access', () => {
  assert.equal(c.wbFinanceAvailabilityNote({ financeAvailable: true }, { awaitingFinance: false }, now), '');
  assert.match(c.wbFinanceAvailabilityNote({ financeAvailable: false, sync: { financeOk: 0,
    error: 'WB Finance report HTTP 403' } }, { awaitingFinance: true }, now), /доступ API-ключа WB/);
});

test('summary endpoint reads finance history and retry metadata without calling WB or writing data', async () => {
  const start = api.indexOf("reportsRouter.get('/wb-finance-summary'");
  const source = api.slice(start, api.indexOf('\nfunction wbAdNmIds', start));
  let handler, payload;
  const queries = [];
  const context = {
    reportsRouter: { get: (_path, fn) => { handler = fn; } }, asyncRoute: fn => fn,
    market: x => x, requestPeriodBounds: () => ({ since: now - 86400000, until: now }), dateKey: () => '2026-10-12',
    pool: { async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes('MAX(rr_date)')) return { rows: [{ lastOperationAt: String(latest) }] };
      if (sql.includes('retry_at')) return { rows: [{ financeOk: 0, retryAt: String(retry) }] };
      if (sql.includes('lastSuccessAt')) return { rows: [{ lastSuccessAt: String(now - 3600000) }] };
      return { rows: [{ financeRowCount: '0', acquiring: '0', delivery: '0', storage: '0', acceptance: '0', deduction: '0',
        penalty: '0', rebill: '0', forPay: '0', additionalPayment: '0', accountAdvertising: '0' }] };
    } }
  };
  vm.runInNewContext(source, context);
  await handler({ query: { market: 'WB2', days: '-1' } }, { json: data => { payload = data; } });
  assert.equal(payload.history.lastOperationAt, String(latest));
  assert.equal(payload.sync.retryAt, String(retry));
  assert.equal(payload.financeAvailable, false);
  assert.equal(queries.length, 5);
  assert.ok(queries.every(x => /^SELECT/.test(x.sql)));
  assert.ok(queries.every(x => x.params[0] === 'WB2'));
});
