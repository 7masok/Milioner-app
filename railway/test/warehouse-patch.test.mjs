import test from 'node:test';
import assert from 'node:assert/strict';
import { applyWarehousePatch } from '../src/warehouse.js';
import { warehousePayloadForStorage } from '../src/warehouse-document.js';

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

test('the stored warehouse file drops lists and the old finance copy', () => {
  const stored = warehousePayloadForStorage({
    products: [{ id: 'a', name: 'Товар', stock: 1 }],
    sales: [{ id: 's1' }],
    purchases: [{ id: 'p1' }],
    reservations: [{ id: 'r1' }],
    movements: [{ id: 'm1' }],
    kaspiAdExpenses: [{ id: 'ad1' }],
    kaspiOrderFeed: [{ id: 'order' }],
    settings: {
      shop: 'main',
      personalFinanceTransactions: [{ id: 'tx', amount: 10 }],
      personalFinanceAccounts: [{ id: 'acc' }]
    },
    kaspiBaselineAt: 5
  });
  assert.deepEqual(Object.keys(stored).sort(), ['kaspiBaselineAt', 'settings']);
  assert.deepEqual(stored.settings, { shop: 'main' });
  assert.equal(stored.kaspiBaselineAt, 5);
});



test('browser warehouse patches cannot replace server-owned marketplace reservations', () => {
  const previous = {
    products: [{ id: 'a', stock: 2 }],
    reservations: [{ id: 'server-kaspi-1', source: 'Kaspi', externalKey: 'Kaspi:1:1', productId: 'a', qty: 1, active: true }]
  };
  const next = applyWarehousePatch(previous, {
    reservations: [],
    deleted: { reservations: ['Kaspi|Kaspi:1:1'] }
  });
  assert.deepEqual(next.reservations, previous.reservations);
});
