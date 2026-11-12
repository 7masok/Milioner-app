import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../../purchase-realization-v1.js', import.meta.url), 'utf8');
const bellSource = readFileSync(new URL('../../stock-alerts-rescue-v1.js', import.meta.url), 'utf8');
const lot = (id, productId) => ({ id, productId, shipmentId: 'p1', status: 'received', qty: 2, remainingQty: 0 });
const sale = (id, purchaseId, productId, fields = {}) => ({
  id, channel: 'Ручная', productId, price: 500, fee: 50, qty: 2,
  fifoLots: [{ purchaseId, qty: 2, unitCost: 200 }], ...fields
});

function fixture() {
  const state = { settings: {}, products: [], purchases: [lot('a', 'red'), lot('b', 'blue')], sales: [] };
  let sheet = '';
  const context = vm.createContext({
    state, window: { purchaseShipmentNumber: () => '214' }, warehouseRemoteReady: true,
    fmt: n => n + ' ₸', setTimeout() {},
    document: { readyState: 'loading', addEventListener() {}, getElementById: () => ({}), querySelector: () => null },
    localStorage: { getItem: () => null, setItem() {} }, showSheet: html => { sheet = html; }
  });
  vm.runInContext(source, context);
  vm.runInContext(bellSource, context);
  return { state, window: context.window, result: () => context.window.purchaseRealizationSummary().get('p1'), sheet: () => sheet };
}

test('confirmed sales are combined by exact lot across all items of a shipment and trigger one notification', () => {
  const f = fixture();
  const red = sale('r', 'a', 'red');
  f.state.sales.push(red, { ...red });
  assert.equal(f.result().sold, 2);
  assert.equal(f.result().profit, null);
  f.window.openStockAlerts();
  assert.doesNotMatch(f.sheet(), /полностью продана/);

  f.state.sales.push(sale('b', 'b', 'blue', { price: 400, fee: 25 }));
  const before = JSON.stringify(f.state);
  const result = f.result();
  assert.equal(result.complete, true);
  assert.equal(result.cost, 800);
  assert.equal(result.profit, 850);
  assert.equal(JSON.stringify(f.state), before);
  f.window.openStockAlerts();
  assert.match(f.sheet(), /Поставка № 214 полностью продана/);
  assert.match(f.sheet(), /850 ₸/);
  assert.equal(Object.keys(f.state.settings.warehouseReleaseAlertAcknowledged).length, 1);

  f.state.sales[2].returned = true;
  assert.equal(f.result().sold, 2);
  assert.equal(f.result().complete, false);
  f.window.openStockAlerts();
  assert.doesNotMatch(f.sheet(), /полностью продана/);
});

test('zero stock, FBO transfers, marketplace sales without settlement, and unknown expenses cannot close a shipment', () => {
  const f = fixture();
  f.state.movements = [{ type: 'FBO Ozon', qty: -2, fifoLots: [{ purchaseId: 'a', qty: 2 }] }];
  f.state.sales.push(sale('wb', 'a', 'red', { channel: 'WB' }), sale('b', 'b', 'blue', { fee: null }));
  assert.equal(f.result().sold, 2);
  assert.equal(f.result().complete, false);
  assert.equal(f.result().profit, null);
  f.window.openStockAlerts();
  assert.doesNotMatch(f.sheet(), /полностью продана/);
});
