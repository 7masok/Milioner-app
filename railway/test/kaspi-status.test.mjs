import test from 'node:test';
import assert from 'node:assert/strict';
import { kaspiOrderIsActive } from '../src/kaspi-status.js';

test('Kaspi reserves only orders not yet assembled', () => {
  assert.equal(kaspiOrderIsActive('APPROVED_BY_BANK', 'KASPI_DELIVERY'), true);
  assert.equal(kaspiOrderIsActive('ACCEPTED_BY_MERCHANT', 'KASPI_DELIVERY_ASSEMBLED'), false);
  assert.equal(kaspiOrderIsActive('ACCEPTED_BY_MERCHANT', 'KASPI_DELIVERY_TRANSIT'), false);
  assert.equal(kaspiOrderIsActive('COMPLETED', 'KASPI_DELIVERY'), false);
  assert.equal(kaspiOrderIsActive('CANCELLED', 'KASPI_DELIVERY'), false);
});


