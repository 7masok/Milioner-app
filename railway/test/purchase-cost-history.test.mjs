import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const script = readFileSync(new URL('../../purchase-pdf-v1.js', import.meta.url), 'utf8');
const page = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const draftCosts = page.split('\n').find(line => line.startsWith('function purchaseDraftCosts('));

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
  vm.runInNewContext(draftCosts + '\n' + script, context);
  context.updatePurchaseOrderCalculator();
  assert.match(draft, /Товары · ≈ 500 ₸/);
  assert.match(draft, /Доставка · ≈ 40 ₸/);
  assert.match(draft, /Всего ≈ 540 ₸/);

  state.purchases.push(paid);
  context.openPurchaseShipment('saved');
  assert.match(shipment, /600 ₸ вместо ≈ 500 ₸ · <b>\+20%/);
  assert.match(shipment, /30 ₸ вместо ≈ 40 ₸ · <b>-25%/);
  const changes = context.window.purchaseShipmentPriceChanges([paid]);
  assert.match(changes.buy, /\(\+20%\)/);
  assert.match(changes.delivery, /\(-25%\)/);
  assert.doesNotMatch(changes.buy + changes.delivery, /₸|500|40/);
  const partial = context.window.purchaseShipmentPriceChanges([paid, {...paid, productId: 'unknown'}]);
  assert.match(partial.buy, /\(\+20% · 1 из 2 поз\.\)/);

  paid.status = 'to_forwarder';
  paid.delivery = 0;
  context.openPurchaseShipment('saved');
  assert.match(shipment, /Доставка · стоимость пока не указана/);
  assert.equal(context.window.purchaseShipmentPriceChanges([paid]).delivery, '');

  paid.workflowStageId = 'cart';
  context.openPurchaseShipment('saved');
  assert.equal(shipment, '');
  assert.equal(context.window.purchaseShipmentPriceChanges([paid]).buy, undefined);
});

test('editor updates percentages as goods and delivery are entered and skips unapplied totals', () => {
  const old = {productId: 'a', qty: 90, buyTotal: 8012, delivery: 1357, status: 'received', orderedAt: 10};
  const current = {...old, shipmentId: 'edited', orderedAt: 100};
  const rows = [{productId: 'a', qty: 90, buy: 7256}];
  let rendered = '';
  const fields = {
    editPurchaseCalc: {insertAdjacentHTML(_where, html) { rendered += html; }},
    editPurchaseItems: {dataset: {shipmentKey: 'edited'}},
    editPorDelivery: {value: '0'},
    editPorBuyTotal: {dataset: {}},
  };
  const context = {
    window: {}, state: {purchases: [old, current]},
    document: {getElementById: id => fields[id]},
    isRealPurchase: () => true,
    purchaseStatus: row => row.status,
    editPurchaseDraftRows: () => rows,
    updateEditPurchaseCalculator() { rendered = ''; },
    purchaseShipmentRows: () => [current],
    localDateStart: () => 100,
    fmt: value => Math.round(value) + ' ₸',
  };
  vm.runInNewContext(draftCosts + '\n' + script, context);
  context.updateEditPurchaseCalculator();
  assert.match(rendered, /7256 ₸ вместо ≈ 8012 ₸ · <b>-9,4%/);
  assert.match(rendered, /Доставка · ≈ 1357 ₸ · сумма доставки пока не указана/);
  assert.doesNotMatch(rendered, /-100%/);

  fields.editPorDelivery.value = '1492.7';
  rows[0].buy = 8813.2;
  context.updateEditPurchaseCalculator();
  assert.match(rendered, /8813 ₸ вместо ≈ 8012 ₸ · <b>\+10%/);
  assert.match(rendered, /1493 ₸ вместо ≈ 1357 ₸ · <b>\+10%/);

  fields.editPorBuyTotal.dataset.pendingTotal = '1';
  context.updateEditPurchaseCalculator();
  assert.match(rendered, /Товары · ≈ 8012 ₸/);
  assert.doesNotMatch(rendered, /8813 ₸/);
});
