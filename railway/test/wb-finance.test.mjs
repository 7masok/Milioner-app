import test from 'node:test';
import assert from 'node:assert/strict';
import { financeRowsFromPayload } from '../src/wb-finance.js';

const rows = [{ rrdId: 10 }, { rrdId: 11 }];

test('reads legacy top-level WB finance arrays', () => {
  assert.deepEqual(financeRowsFromPayload(rows), rows);
});

test('reads nested responses from the current WB finance API', () => {
  assert.deepEqual(financeRowsFromPayload({ data: { rows } }), rows);
  assert.deepEqual(financeRowsFromPayload({ result: { items: rows } }), rows);
});

test('does not invent rows for an empty WB response', () => {
  assert.deepEqual(financeRowsFromPayload({ data: [] }), []);
});
