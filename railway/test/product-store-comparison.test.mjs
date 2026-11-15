import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../../product-store-comparison-v1.js', import.meta.url), 'utf8');

test('comparison orders warehouse products by source buyouts and distinguishes exact, ambiguous and linked cards', async () => {
  const products = [
    { id: 'a', name: 'Крылья', wb: 'wing' },
    { id: 'b', name: 'Кольцо', wb: 'ring' },
    { id: 'c', name: 'Опубликован', wb: 'listed', kaspi: 'lk' },
    { id: 'd', name: 'Нет источника', wb2: 'other' },
    { id: 'e', name: 'Новый товар', wb: 'new' },
  ];
  const elements = new Map(['productCompareQuery', 'productCompareStatus', 'productCompareList', 'q']
    .map(id => [id, { value: '', textContent: '', innerHTML: '', isConnected: true }]));
  const requests = [];
  const window = {
    isWarehouseCatalogProduct: () => true,
    loadComparisonProductBuyouts: async (market, days) => {
      assert.equal(market, 'WB');
      assert.equal(days, 30);
      return { complete: false, counts: new Map([['a', 8], ['b', 12]]) };
    },
  };
  const ctx = vm.createContext({
    window, esc: String, localStorage: { getItem: () => null },
    productRankSpec: () => ({ days: 30 }), productRenderStatsCache: { products },
    productInventoryRow: (_, product) => ({ available: product.id === 'b' ? 0 : 5, warehouse: 0, warehouseReserved: 0 }),
    document: { getElementById: id => elements.get(id) },
    MILLIONER_API: 'https://warehouse.example',
    AbortSignal, showSheet: markup => { ctx.sheet = markup; },
    fetch: async url => {
      requests.push(url);
      return {
        ok: true, json: async () => ({ ok: true, products: [
          { sku: 'wing', name: 'Крылья', inXml: true },
          { sku: 'different-code', name: 'Кольцо', source: 'orders' },
        ] }),
      };
    },
  });
  vm.runInContext(source, ctx);
  window.openProductStoreComparison();
  await new Promise(resolve => setImmediate(resolve));
  const list = elements.get('productCompareList').innerHTML;
  assert.deepEqual(requests, ['https://warehouse.example/api/kaspi-catalog']);
  assert.ok(list.indexOf('Крылья') < list.indexOf('Кольцо'), 'stocked product with sales should be listed first');
  assert.match(list, /Нужна привязка · Артикул wing/);
  assert.match(list, /Нужно проверить · Есть карточка с таким же названием/);
  assert.match(list, /Нужно проверить · В доступных данных карточка не найдена/);
  assert.match(list, /выкупы —/);
  assert.doesNotMatch(list, /Опубликован|Нет источника/);
  assert.match(window.productStoreComparisonLinks(products[2]), /Kaspi<\/span> · Привязан/);
});
