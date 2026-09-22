import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizedSale, saleKey, stripSalesFromState } from '../src/warehouse-sales.js';

test('sales leave the warehouse document without taking purchases with them', () => {
  const next = stripSalesFromState({
    purchases: [{ id: 'p1' }],
    sales: [{ id: 's1', externalKey: 'Kaspi:1:1' }]
  });
  assert.equal(next.sales, undefined);
  assert.equal(next.purchases[0].id, 'p1');
});

test('a marketplace sale is identified by its external key', () => {
  const sale = normalizedSale({ externalKey: 'WB:10:1', qty: '2', channel: 'WB' });
  assert.equal(sale.id, 'WB:10:1');
  assert.equal(saleKey(sale), 'WB:10:1');
  assert.equal(normalizedSale({ qty: 1 }), null);
});
