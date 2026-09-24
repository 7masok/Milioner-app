import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizedReservation, reservationKey, stripReservationsFromState } from '../src/warehouse-reservations.js';
import { exactMarketplaceSkuIndex } from '../src/reservation-reconcile.js';

test('reservations leave the warehouse document without taking products', () => {
  const next = stripReservationsFromState({
    products: [{ id: 'a', stock: 3 }],
    reservations: [{ id: 'r1', source: 'Kaspi', externalKey: 'Kaspi:1:1', active: true }]
  });
  assert.equal(next.reservations, undefined);
  assert.equal(next.products[0].stock, 3);
});

test('a reservation is identified by market and order', () => {
  const row = normalizedReservation({ source: 'WB', externalKey: 'WB:9:1', qty: '2', active: true });
  assert.equal(reservationKey(row), 'WB|WB:9:1');
  assert.equal(row.active, true);
  assert.equal(normalizedReservation({ qty: 1 }), null);
});


test('Kaspi reservation resolver uses the canonical product SKU and aliases', () => {
  const index = exactMarketplaceSkuIndex([
    { id: 'a', kaspi: 'SKU-1', kaspiAliases: ['SKU-OLD'] },
    { id: 'b', kaspi: 'SKU-2' }
  ], 'kaspi');
  assert.equal(index.owners.get('SKU-1'), 'a');
  assert.equal(index.owners.get('SKU-OLD'), 'a');
  assert.equal(index.owners.get('SKU-2'), 'b');
  assert.equal(index.ambiguous.size, 0);
});

test('Kaspi reservation resolver refuses an ambiguous SKU instead of reserving the wrong product', () => {
  const index = exactMarketplaceSkuIndex([
    { id: 'a', kaspi: 'DUPLICATE' },
    { id: 'b', kaspiAliases: ['DUPLICATE'] }
  ], 'kaspi');
  assert.equal(index.owners.has('DUPLICATE'), false);
  assert.equal(index.ambiguous.has('DUPLICATE'), true);
});
