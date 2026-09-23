import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOzonMoney, skuSpendFromReport } from '../src/ozon-performance.js';

test('Ozon performance money uses a comma decimal', () => {
  assert.equal(parseOzonMoney('7552,97'), 7552.97);
  assert.equal(parseOzonMoney(''), 0);
});

test('Ozon performance report spend stays on the advertised SKU', () => {
  const rows = skuSpendFromReport({
    42307860: { report: { rows: [
      { sku: '4161397839', title: 'Зёрна', moneySpent: '1000,50', orders: '1' },
      { sku: '4161397839', title: 'Зёрна', moneySpent: '10,00', orders: '0' },
      { sku: '2', title: 'Манго', moneySpent: '0,00', orders: '0' }
    ] } }
  });
  assert.deepEqual(rows, [{ sku: '4161397839', title: 'Зёрна', spent: 1010.5, orders: 1 }]);
});
