import test from 'node:test';
import assert from 'node:assert/strict';
import { kaspiOrderIsActive, kaspiOrderIsCollected } from '../src/kaspi-status.js';

test('Kaspi keeps an assembled parcel reserved until courier transmission', () => {
  assert.equal(kaspiOrderIsActive('APPROVED_BY_BANK', 'KASPI_DELIVERY'), true);
  assert.equal(kaspiOrderIsActive('ACCEPTED_BY_MERCHANT', 'KASPI_DELIVERY_ASSEMBLED'), true);
  assert.equal(kaspiOrderIsActive('ACCEPTED_BY_MERCHANT', 'KASPI_DELIVERY_TRANSIT'), false);
  assert.equal(kaspiOrderIsActive('COMPLETED', 'KASPI_DELIVERY'), false);
  assert.equal(kaspiOrderIsActive('CANCELLED', 'KASPI_DELIVERY'), false);
});

test('Kaspi sells only after transmission, not after assembly', () => {
  assert.equal(kaspiOrderIsCollected('ACCEPTED_BY_MERCHANT', 'KASPI_DELIVERY_ASSEMBLED'), false);
  assert.equal(kaspiOrderIsCollected('ACCEPTED_BY_MERCHANT', 'KASPI_DELIVERY_TRANSIT'), true);
  assert.equal(kaspiOrderIsCollected('COMPLETED', 'KASPI_DELIVERY'), true);
  assert.equal(kaspiOrderIsCollected('CANCELLED', 'KASPI_DELIVERY_TRANSIT'), false);
});


