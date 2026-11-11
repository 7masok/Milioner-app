import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const hideScript = readFileSync(new URL('../../purchase-plan-ignore-v1.js', import.meta.url), 'utf8');
const page = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');

test('hiding a filtered purchase row confirms and saves its own product ID', () => {
  const bracelet = {id: 'bracelet', name: 'Тканевый браслет'};
  const apple = {id: 'apple', name: 'Форма для льда'};
  const candy = {id: 'candy', name: 'Розовый брелок'};
  const products = [bracelet, apple, candy];
  const state = {products, settings: {}};
  const right = {
    appendChild(button) { this.button = button; },
    querySelector: selector => selector === 'button[onclick]' ? {
      getAttribute: name => name === 'onclick' ? `openRecommendedPurchase('${encodeURIComponent(apple.id)}')` : null,
    } : null,
  };
  const line = {querySelector: selector => selector === '.right' ? right : null};
  const root = {querySelectorAll: () => [line], querySelector: () => null, appendChild() {}};
  const messages = [];
  let accepted = false;
  let saves = 0;
  let rendered;
  const context = {
    state,
    document: {
      getElementById: id => id === 'purchasePlan' ? root : null,
      createElement: () => ({dataset: {}, style: {}, setAttribute() {}}),
    },
    purchaseRecommendations: () => products.map(product => ({productId: product.id, product})),
    renderPurchasePlan() { rendered = context.purchaseRecommendations(); },
    purchasePlanSelection: new Set([apple.id, candy.id]),
    prod: id => products.find(product => product.id === id),
    confirm: message => { messages.push(message); return accepted; },
    save() { saves++; },
    setTimeout() {},
    closeModal() {},
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(hideScript, context);
  const unfilteredRecommendations = context.purchaseRecommendations;
  context.purchaseRecommendations = () => {
    const filtered = unfilteredRecommendations().filter(row => row.productId !== bracelet.id);
    context.__lastPurchaseRecommendations = filtered;
    return filtered;
  };
  context.renderPurchasePlan();
  assert.deepEqual(Array.from(rendered, row => row.productId), [apple.id, candy.id]);

  const click = () => right.button.onclick({preventDefault() {}, stopPropagation() {}});
  click();
  assert.match(messages[0], /«Форма для льда»/);
  assert.deepEqual(Object.keys(state.settings.purchasePlanIgnored), []);
  assert.equal(saves, 0);

  accepted = true;
  click();
  assert.match(messages[1], /«Форма для льда»/);
  assert.deepEqual(Object.keys(state.settings.purchasePlanIgnored), [apple.id]);
  assert.equal(state.settings.purchasePlanIgnored.apple.hidden, true);
  assert.deepEqual([...context.purchasePlanSelection], [candy.id]);
  assert.deepEqual(Array.from(rendered, row => row.productId), [candy.id]);
  assert.equal(saves, 1);

  context.restorePurchasePlanProduct(apple.id);
  assert.deepEqual(Object.keys(state.settings.purchasePlanIgnored), []);
  assert.deepEqual(Array.from(rendered, row => row.productId), [apple.id, candy.id]);
  assert.equal(saves, 2);
});

test('the purchase renderer puts the encoded product ID in the Buy action', () => {
  assert.ok(page.includes("onclick=\"openRecommendedPurchase('${encodeURIComponent(key)}')\""));
});

test('only empty historical rows are excluded from purchase recommendations', () => {
  const old = {id: 'old', variantGroupId: 'group', variantLegacyLink: {market: 'WB'}, stock: 0};
  const products = [
    old,
    {...old, id: 'reserved'},
    {...old, id: 'stock', stock: 1},
    {...old, id: 'linked', wb2Aliases: ['live-code']},
    {...old, id: 'inbound'},
    {...old, id: 'sized', wbVariant: {chrtId: 4}},
    {id: 'ordinary'},
  ];
  const context = {
    state: {settings: {}},
    purchaseRecommendations: () => products.map(product => ({productId: product.id, product, inbound: product.id === 'inbound' ? 1 : 0})),
    reserved: product => product.id === 'reserved' ? 1 : 0,
    renderPurchasePlan() {},
    setTimeout() {},
  };
  context.window = context;
  vm.runInNewContext(hideScript, context);
  assert.deepEqual(Array.from(context.purchaseRecommendations(), row => row.productId),
    ['reserved', 'stock', 'linked', 'inbound', 'sized', 'ordinary']);
});

test('refresh reads the server, rerenders the plan, and labels partial failure', async () => {
  const calls = [];
  const button = {};
  const status = {};
  const controls = {
    dataset: {}, style: {},
    querySelector: selector => selector === 'button' ? button : status,
  };
  let inserted = false;
  const root = {
    querySelector(selector) {
      if (selector === '.purchase-plan') return {};
      return selector === '[data-purchase-plan-refresh-controls]' && inserted ? controls : null;
    },
    querySelectorAll: () => [],
    insertBefore() { inserted = true; },
  };
  const context = {
    state: {settings: {}},
    document: {getElementById: () => root, createElement: () => controls},
    purchaseRecommendations: () => [],
    renderPurchasePlan() { calls.push('render'); inserted = false; },
    async pullWarehouseFromServer() { calls.push('warehouse'); return true; },
    async loadSharedOrderCache(options) { calls.push('orders'); assert.equal(options.after, 55); return {}; },
    async ozonFboRefreshStatus(options) { calls.push('ozon'); assert.equal(options.force, true); return null; },
    async refreshPurchaseWb3Inventory() { calls.push('wb3'); return true; },
    selectedStoreIds: () => ['Ozon', 'WB3'],
    purchaseCoverDays: () => 55,
    reportPeriodStart: days => days,
    setTimeout() {},
  };
  context.window = context;
  vm.runInNewContext(hideScript, context);
  context.renderPurchasePlan();
  const refresh = button.onclick();
  assert.equal(button.disabled, true);
  await button.onclick();
  await refresh;
  assert.deepEqual(calls, ['render', 'warehouse', 'orders', 'ozon', 'wb3', 'render']);
  assert.equal(button.disabled, false);
  assert.match(status.textContent, /Часть данных не обновилась/);
});
