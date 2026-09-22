import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizedReservation, reservationKey, stripReservationsFromState } from '../src/warehouse-reservations.js';

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
