import assert from 'node:assert/strict';
import test from 'node:test';
import { wbOrderIsActive, wbOrderIsCollected } from '../src/wb-status.js';
import { readFileSync } from 'node:fs';

const syncSource = readFileSync(new URL('../src/wb-sync.js', import.meta.url), 'utf8');

test('new WB orders stay reserved while waiting', () => {
  assert.equal(wbOrderIsActive('new', 'waiting'), true);
  assert.equal(wbOrderIsCollected('new', 'waiting'), false);
});

test('assembled but not handed WB orders stay reserved', () => {
  assert.equal(wbOrderIsActive('complete', 'waiting'), true);
  assert.equal(wbOrderIsCollected('complete', 'waiting'), false);
});

test('WB order leaves reserve only after marketplace acceptance', () => {
  assert.equal(wbOrderIsActive('complete', 'sorted'), false);
  assert.equal(wbOrderIsCollected('complete', 'sorted'), true);
});

test('cancelled WB orders are neither reserved nor sold', () => {
  assert.equal(wbOrderIsActive('cancel', 'waiting'), false);
  assert.equal(wbOrderIsCollected('cancel', 'waiting'), false);
});

test('order synchronization immediately publishes recalculated WB stock', () => {
  assert.match(syncSource, /stockSync = await syncWbStockMarket\(market, \{ write: true \}\)/);
});
