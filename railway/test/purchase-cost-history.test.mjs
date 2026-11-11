import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const script = readFileSync(new URL('../../purchase-pdf-v1.js', import.meta.url), 'utf8');

test('draft uses weighted history for current quantities and saved shipment compares both costs', () => {
  const historical = [
    {productId: 'a', qty: 10, buyTotal: 100, delivery: 20, status: 'received', orderedAt: 10},
    {productId: 'a', qty: 30, buyTotal: 900, delivery: 60, status: 'received', orderedAt: 20},
    {productId: 'a', qty: 1, buyTotal: 1000, delivery: 100, status: 'received', orderedAt: 90, opening: true},
    {productId: 'a', qty: 1, buyTotal: 1000, delivery: 100, status: 'received', orderedAt: 110},
  ];
  const paid = {productId: 'a', qty: 20, buyTotal: 600, delivery: 30, status: 'at_warehouse', orderedAt: 100, shipmentId: 'saved'};
  const state = {purchases: historical.slice()};
  let draft = '';
  let shipment = '';
  const box = {insertAdjacentHTML(_where, html) { draft += html; }};
  const pdf = {insertAdjacentHTML(_where, html) { shipment += html; }};
  const sheet = {querySelector: () => pdf};
  const context = {
    window: {}, state,
    document: {getElementById: id => ({purchaseOrderCalc: box, sheet})[id]},
    isRealPurchase: row => !row.opening && !row.inventoryAdjustment,
    purchaseStatus: row => row.status,
    purchaseDraftRows: () => [{productId: 'a', qty: 20}],
    updatePurchaseOrderCalculator() { draft = ''; },
    localDateStart: () => 100,
    purchaseShipmentRows: () => [paid],
    purchaseWorkflow: () => [{id: 'cart', name: 'Корзина'}],
    purchaseWorkflowStage: row => row.workflowStageId,
    openPurchaseShipment() { shipment = ''; },
    fmt: value => `${value} ₸`,
  };
  vm.runInNewContext(script, context);
  context.updatePurchaseOrderCalculator();
  assert.match(draft, /Товары · ≈ 500 ₸/);
  assert.match(draft, /Доставка · ≈ 40 ₸/);
  assert.match(draft, /Всего ≈ 540 ₸/);

  state.purchases.push(paid);
  context.openPurchaseShipment('saved');
  assert.match(shipment, /600 ₸ вместо ≈ 500 ₸ · <b>\+20%/);
  assert.match(shipment, /30 ₸ вместо ≈ 40 ₸ · <b>-25%/);

  paid.status = 'to_forwarder';
  paid.delivery = 0;
  context.openPurchaseShipment('saved');
  assert.match(shipment, /Доставка · стоимость пока не указана/);

  paid.workflowStageId = 'cart';
  context.openPurchaseShipment('saved');
  assert.equal(shipment, '');
});
