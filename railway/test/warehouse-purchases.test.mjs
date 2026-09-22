import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizedPurchase, stripPurchasesFromState } from '../src/warehouse-purchases.js';

test('purchases are removed from the warehouse document without touching other lists', () => {
  const next = stripPurchasesFromState({
    products: [{ id: 'a' }],
    purchases: [{ id: 'p1' }],
    sales: [{ id: 's1' }]
  });
  assert.equal(next.purchases, undefined);
  assert.equal(next.products[0].id, 'a');
  assert.equal(next.sales[0].id, 's1');
});

test('a purchase without an id cannot be stored on its own', () => {
  assert.equal(normalizedPurchase({ productId: 'a', qty: 1 }), null);
  assert.equal(normalizedPurchase({ id: ' p1 ', qty: '2', status: 'received' }).id, 'p1');
});
