import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { wbPriceSyncAction, wbPriceRetryAfterRead } from '../src/wb-price-sync-policy.js';
import { prepareWbPriceChange } from '../src/wb-price-workbench.js';
import { nightUploadInFlight } from '../src/wb-price-workbench.js';

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
  assert.equal(wbPriceSyncAction({ lastAction: 'read' }, pending, { fetchedAt: now }, now, slot), 'write');
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

test('pending writes progress at 16-minute intervals, but failed reads and long downtime require a refresh', () => {
  const queue = [{ status: 'pending' }];
  const sixteenMinutes = 16 * 60000;
  assert.equal(wbPriceSyncAction({ lastAction: 'read' }, queue, { fetchedAt: now }, now + sixteenMinutes, slot), 'write');
  assert.equal(wbPriceSyncAction({ lastAction: 'read-error' }, queue, { fetchedAt: now }, now + sixteenMinutes, slot), 'read');
  assert.equal(wbPriceSyncAction({ lastAction: 'verify-errors' }, queue, { fetchedAt: now }, now + sixteenMinutes, slot), 'read');
  assert.equal(wbPriceSyncAction({ lastAction: 'read' }, queue, { fetchedAt: now }, now + 2 * sixteenMinutes, slot), 'read');
  assert.equal(wbPriceSyncAction({ lastAction: 'read' }, queue, null, now, slot), 'read');
});

test('night ends without overwriting a sent step or losing the original daytime baseline', async () => {
  const schedule = { nmId: '1', enabled: true, startMinute: 240, endMinute: 300,
    targetPrice: 5000, basePrice: 175, windowKey: 'fixture', phase: 'active' };
  let queued = { nmId: '1', source: 'schedule', status: 'sent', desiredPrice: 5000, uploadId: 12 };
  const writes = [], targets = [];
  const ctx = { Number, String, Math, Map,
    pool: { query: async (sql, params) => { writes.push({ sql, params }); return { rowCount: 1 }; } },
    wbPriceSchedules: async () => [{ ...schedule }],
    wbPriceSnapshot: async () => ({ rows: [{ remoteId: '1', price: 5000, canEditPrice: true }] }),
    wbPriceQueueRows: async () => queued ? [{ ...queued }] : [],
    decorateWbProtectionRows: async (market, rows) => rows,
    number: Number, nightUploadInFlight, isWbGradualReductionError: () => false,
    wbNightWindowState: () => ({ inWindow: false, windowKey: '' }),
    samePrice: (a, b) => Number(a) === Number(b),
    wbSafeReturnPrice: (current, base) => Math.max(base, Math.ceil(current / 1.9)),
    scheduleQueueBusy: () => false,
    queueSchedulePrice: async (market, id, price) => { targets.push(price); return true; }
  };
  runInNewContext(functionText('syncWbNightSchedules', 'function overlayWbQueuedRows'), ctx);
  await ctx.syncWbNightSchedules('WB', now);
  assert.equal(writes.length, 0);
  assert.equal(targets.length, 0);
  queued = { ...queued, status: 'checking', lastError: '' };
  await ctx.syncWbNightSchedules('WB', now);
  assert.equal(targets.length, 0, 'snapshot confirmation is required before another step');
  queued = null; // Actual WB read confirmed the night upload and removed it.
  await ctx.syncWbNightSchedules('WB', now);
  assert.deepEqual(targets, [2632]);
  assert.equal(schedule.basePrice, 175);
  assert.ok(writes.every(w => !w.sql.includes('base_price=')));
});

test('real sync completes gradual night return and zero discount across timed slots and restarts', async () => {
  // Persisted database and WB fixtures survive a fresh VM on every invocation.
  // This exercises the production selector, sender, upload inspection and read
  // reconciliation together, using the 60-second timer's actual slot rounding.
  let clock = now, upload = 0, snapshot = { fetchedAt: now - 3 * slot, rows: [] };
  const state = { nextAllowedAt: 0, lastAction: 'read', readOffset: 0 };
  const remote = new Map([
    ['1', { remoteId: '1', price: 5000, discount: 0 }],
    ['2', { remoteId: '2', price: 450, discount: 3 }]
  ]);
  const queue = new Map([
    ['1', { nmId: '1', desiredPrice: 175, desiredDiscount: 0, source: 'manual', status: 'pending', updatedAt: 1, sentAt: 0, uploadId: 0 }],
    ['2', { nmId: '2', desiredPrice: null, desiredDiscount: 0, source: 'manual', status: 'pending', updatedAt: 1, sentAt: 0, uploadId: 0 }]
  ]);
  const histories = new Map(), actions = [], prices = [];
  const client = { release() {}, async query(sql, params = []) {
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
    if (sql.includes('INSERT INTO wb_price_snapshots')) {
      snapshot = { ...JSON.parse(params[1]), fetchedAt: params[2] };
    } else if (sql.includes('DELETE FROM wb_price_update_queue')) {
      queue.delete(String(params[1]));
    } else if (sql.includes('UPDATE wb_price_update_queue')) {
      const row = queue.get(String(params[1]));
      if (!row) return { rowCount: 0 };
      if (sql.includes("SET status='sent'")) {
        assert.equal(row.status, 'pending');
        assert.equal(row.updatedAt, params[2]);
        Object.assign(row, { status: 'sent', sentAt: params[3], uploadId: params[4], updatedAt: params[3], lastError: '' });
      } else if (sql.includes("status='checking'")) {
        Object.assign(row, { status: 'checking', updatedAt: params[2], lastError: '' });
      } else if (sql.includes("SET status='pending'")) {
        Object.assign(row, { status: 'pending', sentAt: 0, uploadId: 0, updatedAt: params[2] });
      } else if (sql.includes('SET last_error=')) row.lastError = 'waiting';
    }
    return { rows: [], rowCount: 1 };
  } };
  const defs = functionText('inspectWbPriceUpload', 'async function sendWbPriceQueue') +
    functionText('sendWbPriceQueue', 'async function saveWbPriceRead') +
    functionText('saveWbPriceRead', 'async function syncWbPriceMarket') +
    functionText('syncWbPriceMarket', 'let wbPriceSyncTimer');
  const safeStart = api.indexOf('export function wbSafeReturnPrice');
  const safePrice = api.slice(safeStart, api.indexOf('function samePrice', safeStart)).replace('export ', '');
  const invoke = async () => {
    const ctx = { Date: { now: () => clock }, Number, String, Boolean, JSON, Math, Map,
      console: { info() {}, warn() {} }, pool: { connect: async () => client },
      WB_PRICE_SLOT_MS: slot, WB_PRICE_PAGE_LIMIT: 1000, wbPriceSyncAction, wbPriceRetryAfterRead,
      number: value => Number(value) || 0, cleanText: value => String(value ?? ''), clampDiscount: Number,
      syncWbPriceProtection: async () => {}, syncWbNightSchedules: async () => {},
      wbPriceState: async () => ({ ...state }), wbPriceSnapshot: async () => snapshot,
      wbPriceQueueRows: async () => [...queue.values()].map(row => ({ ...row })),
      wbPriceSchedules: async () => [], wbToken: async () => 'fixture',
      syncWbWarehouseStocksMaybe: async () => {}, normalizeWbPriceRows: async (market, rows) => rows,
      markWbPriceState: async (market, values) => Object.assign(state, values),
      fetchWbPricePage: async () => { actions.push('read'); return [...remote.values()].map(row => ({ ...row })); },
      fetchWbUploadDetails: async (market, token, id) => { actions.push('verify'); return histories.get(id); },
      requestWb: async (token, path, options) => {
        actions.push('write');
        assert.equal(path, '/api/v2/upload/task');
        const data = JSON.parse(options.body).data;
        for (const item of data) {
          const row = remote.get(String(item.nmID));
          if (item.price !== undefined) {
            assert.ok(item.price >= Math.ceil(row.price / 1.9), 'every reduction uses a confirmed safe step');
            prices.push(item.price); row.price = item.price;
          }
          if (item.discount !== undefined) row.discount = item.discount;
        }
        histories.set(++upload, data.map(item => ({ nmID: item.nmID, errorText: '' })));
        return { data: { id: upload } };
      }
    };
    runInNewContext(safePrice + defs, ctx);
    return ctx.syncWbPriceMarket('WB');
  };
  for (let cycle = 0; cycle < 30 && queue.size; cycle++) {
    const result = await invoke();
    assert.equal(result.ok, true);
    if (result.action === 'write') {
      assert.equal(queue.get('1').desiredPrice, 175, 'final target survives intermediate uploads');
      assert.equal(queue.get('1').status, 'sent', 'upload response is not application confirmation');
    }
    const requestCount = actions.length;
    clock += 60000;
    assert.equal((await invoke()).reason, 'slot-cooldown');
    assert.equal(actions.length, requestCount, 'restart cannot bypass persisted cooldown');
    clock += 15 * 60000;
  }
  assert.equal(queue.size, 0, 'queue empties only after actual final prices are read');
  assert.equal(remote.get('1').price, 175);
  assert.equal(remote.get('2').discount, 0);
  assert.deepEqual(prices, [2632, 1386, 730, 385, 203, 175]);
  assert.deepEqual(actions.slice(0, 4), ['read', 'write', 'verify', 'read']);
  assert.equal(actions.filter(action => action === 'write').length, 6);
});
