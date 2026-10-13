import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ui = readFileSync(new URL('../../kaspi-report-v2.js', import.meta.url), 'utf8');
const server = readFileSync(new URL('../src/reports.js', import.meta.url), 'utf8');
const routeStart = server.indexOf("reportsRouter.get('/wb-finance-products'");
const route = server.slice(routeStart, server.indexOf("reportsRouter.get('/wb-ad-link-audit'", routeStart));
const line = name => ui.split('\n').find(x => x.startsWith('function ' + name + '('));

test('finance article matching is case/edge-space insensitive, cabinet-specific and refuses ambiguous products', () => {
  assert.match(route, /lower\(btrim\(pl\.sku\)\)=lower\(btrim\(f\.vendor_code\)\)/);
  assert.match(route, /pl\.market=f\.market/);
  assert.match(route, /HAVING COUNT\(DISTINCT pl\.product_id\)=1/);
  const join = route.slice(route.indexOf('LEFT JOIN LATERAL'), route.indexOf(') l ON TRUE'));
  assert.doesNotMatch(join, /LIMIT 1|products\.name|warehouse_products\.name/);
});

async function endpoint(financeRows, adAmount = 173188) {
  let handler, response;
  const byProduct = new Map([['wings', adAmount]]);
  const c = { reportsRouter: { get: (_path, fn) => { handler = fn; } }, asyncRoute: fn => fn,
    market: value => value, requestPeriodBounds: () => ({ since: 0, until: 86400000 }), dateKey: () => '2026-10-12',
    pool: { async query(sql) { return { rows: sql.includes('FROM wb_finance_rows') ? financeRows : [] }; } },
    resolveWbAdvertising: async () => ({ byProduct, total: adAmount + 50, unmatched: 50, autoRecovered: adAmount,
      rows: [{ productId: 'wings', productName: 'Крылья ангела', nmIds: ['1034505393'] }] }) };
  vm.runInNewContext(route, c);
  await handler({ query: { market: 'WB2', days: '30' } }, { json: value => { response = value; } });
  return response;
}

test('linked advertisement is attached and subtracted once across finance article variants', async () => {
  const result = await endpoint([
    { productId: 'wings', vendorCode: 'крылья ангела', retailAmount: 100000, forPay: 80000 },
    { productId: 'wings', vendorCode: 'крылья ангела ', retailAmount: 50000, forPay: 40000 }
  ]);
  assert.equal(result.products.length, 2);
  assert.equal(result.products.reduce((sum, row) => sum + row.advertising, 0), 173188);
  assert.equal(result.products.reduce((sum, row) => sum + row.netBeforeCost, 0), 120000 - 173188);
  assert.equal(result.unmatchedAdvertising, 50);
  assert.equal(result.advertising, 173238);
});

test('an advertised product without sales remains a separate negative-profit row', async () => {
  const result = await endpoint([{ productId: 'other', qty: 1, retailAmount: 1000, forPay: 800 }], 300);
  const advertised = result.products.find(row => row.productId === 'wings');
  assert.equal(advertised.qty, 0);
  assert.equal(advertised.retailAmount, 0);
  assert.equal(advertised.advertising, 300);
  assert.equal(advertised.netBeforeCost, -300);
});

function paint(model) {
  let painted;
  const c = { fmt: x => String(x), wbLiveProductId: (_market, row) => row.productId,
    wbRealizedFifoCost: (_pid, _market, _days, qty) => qty * 100,
    productNameById: (_pid, fallback) => fallback, wbFinanceAvailabilityNote: () => '',
    paintStoreSheet: (_market, _days, view) => { painted = view; } };
  vm.runInNewContext(line('paintWbSheet'), c);
  c.paintWbSheet({ complete: true, financeAvailable: true, revenue: 1000, expenses: 200, cost: 100,
    ads: 300, profit: 400, adjustment: 0, unmatchedAdvertising: 0, ...model }, 'WB2', 30);
  return painted;
}

test('product cards display campaign expense and profit after advertising', () => {
  const view = paint({ products: [{ productId: 'wings', qty: 2, retailAmount: 1000,
    wbExpenses: 200, advertising: 300, netBeforeCost: 500, title: 'Крылья ангела' }] });
  assert.equal(view.products[0].ads, '300');
  assert.equal(view.products[0].profit, '300');
});

test('zero-sale advertised products stay visible while empty zero-expense rows stay hidden', () => {
  const view = paint({ products: [{ productId: 'wings', qty: 0, retailAmount: 0, advertising: 300,
    netBeforeCost: -300, title: 'Крылья ангела' }, { productId: 'empty', qty: 0, retailAmount: 0, advertising: 0 }] });
  assert.equal(view.products.length, 1);
  assert.equal(view.products[0].ads, '300');
  assert.equal(view.products[0].profit, '-300');
});

test('unallocated advertisement is not incorrectly described as always belonging to multiple products', () => {
  const view = paint({ products: [], unmatchedAdvertising: 150 });
  assert.match(view.note, /без однозначной привязки/);
  assert.doesNotMatch(view.note, /относится к кампаниям с несколькими товарами/);
});
