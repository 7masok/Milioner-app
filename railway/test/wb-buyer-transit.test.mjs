import assert from 'node:assert/strict';
import test from 'node:test';
import { confirmClosedWbTransit } from '../src/orders.js';

test('only exact same-account WB terminal evidence removes a delivery from the forecast', async () => {
  const rows = [
    { market: 'WB2', creationDate: 100, state: 'READY_FOR_PICKUP', transitRaw: JSON.stringify({ order: { rid: 'a', orderUid: 'cart' } }) },
    { market: 'WB2', creationDate: 100, state: 'SORTED', transitRaw: { order: { rid: 'b', orderUid: 'cart' } } },
    { market: 'WB', creationDate: 100, state: 'READY_FOR_PICKUP', transitRaw: { order: { rid: 'a' } } },
    { market: 'WB2', creationDate: 300, state: 'SENT_TO_CARRIER', transitRaw: { order: { rid: 'old' } } },
    { market: 'WB2', creationDate: 100, state: 'SENT_TO_CARRIER', transitRaw: { order: { orderUid: 'cart' } } },
  ];
  const calls = [];
  await confirmClosedWbTransit(rows, {
    async query(_, values) {
      calls.push(values);
      return { rows: values[0] === 'WB2' ? [{ srid: 'a', saleDate: 200 }, { srid: 'old', saleDate: 200 }] : [] };
    },
  });
  assert.deepEqual(calls, [['WB2', ['a', 'b', 'old']], ['WB', ['a']]]);
  assert.deepEqual(rows.map(row => row.buyerTransitClosed === true), [true, false, false, false, false]);
  assert.ok(rows.every(row => !('transitRaw' in row)));
});
