import test from 'node:test';
import assert from 'node:assert/strict';
import { applyWarehousePatch } from '../src/warehouse.js';

test('a patch updates one product and leaves the rest of the warehouse in place', () => {
  const previous = {
    products: [{ id: 'a', name: 'Старое', stock: 2 }, { id: 'b', name: 'Второе', stock: 5 }],
    purchases: [{ id: 'p1', qty: 3 }, { id: 'p2', qty: 1 }],
    sales: [{ id: 's1', externalKey: 'kaspi-1', qty: 1 }],
    settings: { shop: 'old' }
  };
  const next = applyWarehousePatch(previous, {
    products: [{ id: 'a', name: 'Новое', stock: 2 }],
    deleted: { purchases: ['p2'] },
    settings: { shop: 'new' }
  });
  assert.equal(next.products.find(row => row.id === 'a').name, 'Новое');
  assert.equal(next.products.find(row => row.id === 'b').stock, 5);
  assert.deepEqual(next.purchases.map(row => row.id), ['p1']);
  assert.equal(next.sales[0].externalKey, 'kaspi-1');
  assert.equal(next.settings.shop, 'new');
});
