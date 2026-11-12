import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { consumeTrackedPurchaseLots, restoreTrackedPurchaseLots, trackNewPurchaseLots } from '../src/purchase-sale-lots.js';
import { purchaseSaleResult } from '../src/purchase-sale-results.js';

const source = readFileSync(new URL('../../purchase-realization-v1.js', import.meta.url), 'utf8');
const bellSource = readFileSync(new URL('../../stock-alerts-rescue-v1.js', import.meta.url), 'utf8');
const lot = (id, productId) => ({ id, productId, shipmentId: 'p1', status: 'received', qty: 2, remainingQty: 0 });
const sale = (id, purchaseId, productId, fields = {}) => ({
  id, channel: 'Ручная', productId, price: 500, fee: 50, qty: 2,
  fifoLots: [{ purchaseId, qty: 2, unitCost: 200 }], ...fields
});

function fixture(results = {}) {
  const state = { settings: {}, products: [], purchases: [lot('a', 'red'), lot('b', 'blue')], sales: [] };
  let sheet = '';
  const context = vm.createContext({
    state, window: { purchaseShipmentNumber: () => '214' }, warehouseRemoteReady: true,
    apiJson: async () => ({ results }), MILLIONER_API: 'https://example.test',
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

test('automatic FIFO starts with new purchases and does not guess when older stock is mixed in', () => {
  const old = { ...lot('old', 'red'), shipmentId: 'old-shipment', remainingQty: 1, landedUnitCost: 150 };
  const editedOld = { ...old, purchaseRealizationTracked: true };
  const fresh = { ...lot('new', 'red'), shipmentId: 'new-shipment', remainingQty: 2, landedUnitCost: 200 };
  trackNewPurchaseLots([old], [editedOld, fresh]);
  assert.equal(editedOld.purchaseRealizationTracked, undefined);
  assert.equal(fresh.purchaseRealizationTracked, true);
  assert.deepEqual(consumeTrackedPurchaseLots([editedOld, fresh], 'red', 3, 1), []);
  assert.equal(fresh.remainingQty, 2);
  const used = consumeTrackedPurchaseLots([fresh], 'red', 2, 1);
  assert.deepEqual(used, [{ purchaseId: 'new', qty: 1, unitCost: 200 }]);
  assert.equal(fresh.remainingQty, 1);
  assert.equal(restoreTrackedPurchaseLots([fresh], used).length, 1);
  assert.equal(fresh.remainingQty, 2);
});

test('delivery, verified buyout, financial charges and return are distinct', () => {
  const order = { market: 'WB', qty: 1, status: 'complete', state: 'sorted' };
  const realized = { kind: 'sale', saleQty: 1, returnQty: 0, currency: 'KZT', beforeAdsAndCost: 420 };
  const ad = { kind: 'advertising', currency: 'KZT', beforeAdsAndCost: 0, orderAdvertising: 20 };
  assert.deepEqual(purchaseSaleResult(order), { sold: 0, proceeds: null });
  assert.deepEqual(purchaseSaleResult(order, [realized, ad]), { sold: 1, proceeds: null });
  assert.deepEqual(purchaseSaleResult(order, [realized, ad], true), { sold: 1, proceeds: 400 });
  assert.deepEqual(purchaseSaleResult(order, [realized, { ...realized, kind: 'return', saleQty: 0, returnQty: 1, beforeAdsAndCost: -440 }], true), { sold: 0, proceeds: -20 });
  assert.deepEqual(purchaseSaleResult({ ...order, market: 'Kaspi', status: 'completed' }), { sold: 1, proceeds: null });
});

test('confirmed automatic buyouts close the new shipment after finance arrives', async () => {
  const results = { red: { sold: 2, proceeds: 950 }, blue: { sold: 2, proceeds: 750 } };
  const f = fixture(results);
  for (const lot of f.state.purchases) lot.purchaseRealizationTracked = true;
  f.state.sales.push(sale('red', 'a', 'red', { channel: 'WB', purchaseRealizationTracked: true }));
  f.state.sales.push(sale('blue', 'b', 'blue', { channel: 'WB2', purchaseRealizationTracked: true }));
  assert.equal(f.result().complete, false);
  await f.window.refreshPurchaseRealization();
  assert.equal(f.result().sold, 4);
  assert.equal(f.result().profit, 900);
  f.window.openStockAlerts();
  assert.match(f.sheet(), /900 ₸/);
  const blue = f.state.sales[1];
  blue.externalKey = 'WB2:42:42';
  assert.equal(f.window.restorePurchaseRealizationReturn(blue.externalKey, 'blue', 2), true);
  f.state.settings.wbReturnReceipts = { [blue.externalKey]: { action: 'Возврат WB в продажу' } };
  assert.equal(f.result().complete, false);
  assert.equal(f.result().sold, 2);
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
