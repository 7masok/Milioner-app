import test from 'node:test';
import assert from 'node:assert/strict';
import { kaspiAdExpenseKey, normalizedKaspiAdExpense, stripKaspiAdExpensesFromState } from '../src/warehouse-kaspi-ads.js';

test('a manual Kaspi ad import leaves the warehouse document', () => {
  const next = stripKaspiAdExpensesFromState({
    products: [{ id: 'a' }],
    kaspiAdExpenses: [{ id: 'ads-1', fileName: 'report.xlsx', amount: 1200, lines: [{ sku: '1', amount: 1200 }] }]
  });
  assert.equal(next.kaspiAdExpenses, undefined);
  assert.equal(next.products[0].id, 'a');
});

test('an imported Kaspi report keeps its id and its lines', () => {
  const row = normalizedKaspiAdExpense({ id: 'ads-1', fileName: 'report.xlsx', amount: '1200', lines: [{ amount: 10 }] });
  assert.equal(kaspiAdExpenseKey(row), 'ads-1');
  assert.equal(row.lines.length, 1);
  assert.equal(normalizedKaspiAdExpense({}), null);
});
