import test from 'node:test';
import assert from 'node:assert/strict';
import { quietestTwoHourWindow } from '../src/wb-hourly-orders.js';

test('quietest WB window finds the lowest adjacent Almaty hours', () => {
  const hours = Array(24).fill(10);
  hours[5] = 0;
  hours[6] = 1;
  const result = quietestTwoHourWindow(hours);
  assert.deepEqual(result, { startHour: 5, endHour: 7, orders: 1, label: '05:00–07:00' });
});

test('quietest WB window can cross midnight', () => {
  const hours = Array(24).fill(10);
  hours[23] = 0;
  hours[0] = 0;
  const result = quietestTwoHourWindow(hours);
  assert.deepEqual(result, { startHour: 23, endHour: 1, orders: 0, label: '23:00–01:00' });
});
