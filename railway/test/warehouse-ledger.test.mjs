import assert from 'node:assert/strict';
import test from 'node:test';
import { stockLedgerViolation } from '../src/warehouse-ledger.js';

const now = Date.UTC(2026, 8, 2);

function movement(index, qty = 0) {
  return { id: `m${index}`, productId: 'fishing', qty, date: now - index * 1000 };
}

test('movement ledger may grow beyond 1000 rows without trimming history', () => {
  const oldMovements = Array.from({ length: 1000 }, (_, index) => movement(index));
  const inventoryMovement = { id: 'inventory-now', productId: 'fishing', qty: -3, date: now + 1 };
  const nextMovements = [inventoryMovement, ...oldMovements];
  const previous = { products: [{ id: 'fishing', stock: 3 }], movements: oldMovements };
  const next = { products: [{ id: 'fishing', stock: 0 }], movements: nextMovements };

  assert.equal(stockLedgerViolation(previous, next, now), null);
});

test('automatic 1000-row tail trimming is rejected', () => {
  const oldMovements = Array.from({ length: 1000 }, (_, index) => movement(index));
  const inventoryMovement = { id: 'inventory-now', productId: 'fishing', qty: -3, date: now + 1 };
  const nextMovements = [inventoryMovement, ...oldMovements].slice(0, 1000);
  const previous = { products: [{ id: 'fishing', stock: 3 }], movements: oldMovements };
  const next = { products: [{ id: 'fishing', stock: 0 }], movements: nextMovements };

  assert.deepEqual(stockLedgerViolation(previous, next, now), {
    reason: 'movement-history-removed', movementIds: ['m999'], removedCount: 1
  });
});

test('an arbitrary movement cannot be removed', () => {
  const oldMovements = [movement(0, 3), movement(1, -1)];
  const previous = { products: [{ id: 'fishing', stock: 3 }], movements: oldMovements };
  const next = { products: [{ id: 'fishing', stock: 3 }], movements: [oldMovements[1]] };

  assert.deepEqual(stockLedgerViolation(previous, next, now), {
    reason: 'movement-history-removed', movementIds: ['m0'], removedCount: 1
  });
});

test('stock still cannot change without a matching movement', () => {
  const previous = { products: [{ id: 'fishing', stock: 3 }], movements: [] };
  const next = { products: [{ id: 'fishing', stock: 0 }], movements: [] };

  assert.deepEqual(stockLedgerViolation(previous, next, now), {
    reason: 'stock-change-without-movement', productId: 'fishing', stockDelta: -3, loggedDelta: 0
  });
});
