import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { wbPriceSyncAction, wbPriceRetryAfterRead } from '../src/wb-price-sync-policy.js';
import { prepareWbPriceChange } from '../src/wb-price-workbench.js';

const slot = 905000, now = 10 * slot;
const api = readFileSync(new URL('../src/prices.js', import.meta.url), 'utf8');
const functionText = (name, next) => api.slice(api.indexOf('async function ' + name), api.indexOf(next, api.indexOf('async function ' + name)));

test('missing upload history cannot starve actual reads or new pending discounts', async () => {
  const queue = [{ nmId: '1', status: 'sent', uploadId: 12 }, { nmId: '2', status: 'pending', desiredDiscount: 0 }];
  assert.equal(wbPriceSyncAction({ lastAction: 'verify-upload' }, queue, { fetchedAt: now }, now, slot), 'read');
  const actions = [], client = { query: async () => ({ rows: [{ locked: true }] }), release() {} };
  const ctx = { Date: { now: () => now }, Number, String, Boolean, console,
    pool: { connect: async () => client },
    syncWbPriceProtection: async () => {}, syncWbNightSchedules: async () => {},
    wbPriceState: async () => ({ lastAction: 'verify-upload', nextAllowedAt: 0 }),
    wbToken: async () => 'fixture', syncWbWarehouseStocksMaybe: async () => {},
    wbPriceQueueRows: async () => queue, wbPriceSnapshot: async () => ({ fetchedAt: now - 3 * slot }),
    wbPriceSyncAction, WB_PRICE_SLOT_MS: slot,
    fetchWbPricePage: async () => { actions.push('read'); return []; },
    saveWbPriceRead: async () => ({ complete: true, rows: 0 }),
    inspectWbPriceUpload: async () => { throw Error('must read after verify'); },
    cleanText: String, markWbPriceState: async () => {}
  };
  runInNewContext(functionText('syncWbPriceMarket', 'let wbPriceSyncTimer'), ctx);
  await ctx.syncWbPriceMarket('WB');
  assert.deepEqual(actions, ['read']);
});

test('reads finish pagination, confirm checking operations and refresh before a reduction', () => {
  const pending = [{ status: 'pending' }];
  assert.equal(wbPriceSyncAction({ readOffset: 1000 }, pending, { fetchedAt: now }, now, slot), 'read');
  assert.equal(wbPriceSyncAction({}, [{ status: 'checking' }, ...pending], { fetchedAt: now }, now, slot), 'read');
  assert.equal(wbPriceSyncAction({}, pending, { fetchedAt: now - 2 * slot }, now, slot), 'read');
  assert.equal(wbPriceSyncAction({}, pending, { fetchedAt: now }, now, slot), 'write');
  assert.equal(wbPriceRetryAfterRead({ status: 'sent', sentAt: now - slot }, now, slot), false);
  assert.equal(wbPriceRetryAfterRead({ status: 'sent', sentAt: now - 3 * slot }, now, slot), true);
});

test('real sender lowers 5000 gradually and keeps the final manual target at 175', async () => {
  const queue = [{ nmId: '1', desiredPrice: 175, desiredDiscount: 0, updatedAt: 1 }];
  const calls = [], writes = [], client = { query: async (sql, params) => { writes.push({ sql, params }); return { rowCount: 1 }; }, release() {} };
  const ctx = { Number, String, JSON, Math,
    pool: { connect: async () => client },
    wbPriceSnapshot: async () => ({ rows: [{ remoteId: '1', price: 5000 }] }),
    wbSafeReturnPrice: (current, target) => Math.max(Number(target), Math.ceil(Number(current) / 1.9)),
    requestWb: async (token, path, options) => { calls.push(JSON.parse(options.body)); return { data: { id: 12 } }; },
    number: Number, WB_PRICE_SLOT_MS: slot, markWbPriceState: async () => {}
  };
  runInNewContext(functionText('sendWbPriceQueue', 'async function saveWbPriceRead'), ctx);
  await ctx.sendWbPriceQueue('WB', 'fixture', queue, now);
  assert.equal(calls[0].data[0].price, 2632);
  assert.equal(calls[0].data[0].discount, 0);
  assert.equal(queue[0].desiredPrice, 175);
  assert.ok(writes.some(w => w.sql.includes("status='sent'")));
});

test('fresh actual read confirms matching missing uploads and retries old unmet targets', async () => {
  const queue = [
    { nmId: '1', source: 'manual', status: 'sent', desiredPrice: 450, desiredDiscount: null, sentAt: now - 3 * slot },
    { nmId: '2', source: 'manual', status: 'checking', desiredPrice: 175, desiredDiscount: 0, sentAt: now - 3 * slot }
  ];
  const writes = [], client = { query: async (sql, params) => { writes.push({ sql, params }); return { rows: [] }; }, release() {} };
  const ctx = { Number, String, JSON, Math, Map,
    pool: { connect: async () => client }, WB_PRICE_SLOT_MS: slot, WB_PRICE_PAGE_LIMIT: 1000,
    wbPriceQueueRows: async () => queue, wbPriceSchedules: async () => [],
    normalizeWbPriceRows: async (market, rows) => rows, number: Number, clampDiscount: Number,
    wbPriceRetryAfterRead, markWbPriceState: async () => {}
  };
  runInNewContext(functionText('saveWbPriceRead', 'async function syncWbPriceMarket'), ctx);
  await ctx.saveWbPriceRead('WB', {}, [{ remoteId: '1', price: 450, discount: 3 }, { remoteId: '2', price: 2632, discount: 0 }], now);
  assert.ok(writes.some(w => w.sql.includes('DELETE FROM') && w.params[1] === '1'));
  assert.ok(writes.some(w => w.sql.includes("status='pending'") && w.params[1] === '2'));
});

test('exit without a discount removes it, even when the promotion threshold is unknown', () => {
  assert.equal(prepareWbPriceChange({ price: 450, discount: 3 }, { action: 'exit' }).discount, 0);
  assert.equal(prepareWbPriceChange({ price: 450, discount: 3 }, { action: 'exit' }, { planPrice: 436.5 }).discount, 0);
  assert.equal(prepareWbPriceChange({ price: 450, discount: 3 }, { action: 'exit', discount: 1 }, { planPrice: 436.5 }).discount, 1);
});
