import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWarehousePayload, stripMovementsFromState } from '../src/warehouse-movements.js';

test('movement split removes movements from persisted warehouse snapshot without mutating input', () => {
  const original = { products:[{id:'p1'}], movements:[{id:'m1',productId:'p1',qty:2}], settings:{activeView:'movement'} };
  const stripped = stripMovementsFromState(original);
  assert.deepEqual(stripped,{ products:[{id:'p1'}], settings:{activeView:'movement'} });
  assert.equal(original.movements.length,1);
});

test('warehouse payload parser keeps legacy snapshots readable', () => {
  assert.deepEqual(parseWarehousePayload('{"products":[{"id":"p1"}]}'),{products:[{id:'p1'}]});
  assert.deepEqual(parseWarehousePayload('broken'),{});
});
