import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { prepareWbPriceChange, nightUploadInFlight } from '../src/wb-price-workbench.js';

test('promotion actions change only the discount and cross the threshold in opposite directions', () => {
  const row = { price: 1000, discount: 5 }, pref = { planPrice: 650 };
  assert.deepEqual(prepareWbPriceChange(row, { action: 'enter' }, pref), { price: null, discount: 35, finalPrice: 650 });
  const exit = prepareWbPriceChange(row, { action: 'exit' }, pref);
  assert.equal(exit.price, null);
  assert.equal(exit.discount, 34);
  assert.ok(exit.finalPrice > 650);
  assert.throws(() => prepareWbPriceChange(row, { action: 'enter', discount: 34 }, pref), /недостаточно/);
  assert.throws(() => prepareWbPriceChange(row, { action: 'exit', discount: 35 }, pref), /остаётся/);
  assert.throws(() => prepareWbPriceChange(row, { action: 'exit' }, { planPrice: 1200 }), /Скидка/);
});

test('rounding never claims an unattainable promotion price and unknown thresholds need an explicit discount', () => {
  const row = { price: 101, discount: 0 };
  assert.ok(prepareWbPriceChange(row, { action: 'enter' }, { planPrice: 65 }).finalPrice <= 65);
  assert.ok(prepareWbPriceChange(row, { action: 'exit' }, { planPrice: 65 }).finalPrice > 65);
  assert.throws(() => prepareWbPriceChange(row, { action: 'enter' }), /Порог/);
  assert.equal(prepareWbPriceChange(row, { action: 'enter', discount: 40 }).discount, 40);
  assert.throws(() => prepareWbPriceChange(row, { action: 'enter' }, { planPrice: 0.1 }), /Скидка/);
});

test('blank fields preserve the individual ordinary price and size prices cannot be flattened', () => {
  assert.deepEqual(prepareWbPriceChange({ price: 300, discount: 20 }, { discount: 0 }), { price: null, discount: 0, finalPrice: 300 });
  assert.equal(prepareWbPriceChange({ price: 700, discount: 10 }, { price: 800 }).finalPrice, 720);
  assert.throws(() => prepareWbPriceChange({ price: 300, canEditPrice: false }, { price: 100 }), /размерам/);
  assert.equal(prepareWbPriceChange({ price: 300, canEditPrice: false, discount: 0 }, { discount: 10 }).finalPrice, 270);
  for (const input of [{ discount: 100 }, { discount: -1 }, { discount: 0.5 }, { price: -1 }, { price: 1.2 }, {}]) {
    assert.throws(() => prepareWbPriceChange({ price: 300, discount: 10 }, input));
  }
});

test('night end or target changes must retain sent uploads and unfinished snapshot checks', () => {
  assert.equal(nightUploadInFlight({ source: 'schedule', status: 'sent', desiredPrice: 5000, uploadId: 12 }), true);
  assert.equal(nightUploadInFlight({ source: 'schedule', status: 'checking', desiredPrice: 5000, lastError: '' }), true);
  assert.equal(nightUploadInFlight({ source: 'schedule', status: 'checking', lastError: 'WB обработал загрузку, ждём отражения цены' }), false);
  assert.equal(nightUploadInFlight({ source: 'schedule', status: 'pending' }), false);
  assert.equal(nightUploadInFlight({ source: 'manual', status: 'sent' }), false);
});

test('bulk queue applies only selected writable positions and preserves the transaction on SQL failure', async () => {
  const { pricesRouter } = await import('../src/prices.js');
  const { pool } = await import('../src/db.js');
  const handler = pricesRouter.stack.find(layer => layer.route?.path === '/market-prices/update/bulk').route.stack.at(-1).handle;
  const original = pool.connect, calls = [];
  let failInsert = false;
  const client = { release() {}, async query(sql, params) {
    calls.push({ sql, params });
    if (sql.includes('FROM wb_price_snapshots')) return { rows: [{ payload: { rows: [
      { remoteId: '1', price: 1000, discount: 10 },
      { remoteId: '2', price: 2000, discount: 20 },
      { remoteId: '3', price: 3000, discount: 30 }
    ] } }] };
    if (sql.includes('plan_price AS')) return { rows: [{ nmId: 1, planPrice: 650 }] };
    if (sql.includes('FROM wb_price_protection')) return { rows: params[1] === 2 ? [{ manualPriceLock: true }] : [] };
    if (sql.includes('INSERT INTO wb_price_update_queue') && failInsert) throw Object.assign(new Error('fixture database failure'), { code: 'XX001' });
    return { rows: [], rowCount: 1 };
  } };
  pool.connect = async () => client;
  const invoke = async body => {
    let status = 200, result;
    await handler({ body }, { status(value) { status = value; return this; }, json(value) { result = value; return this; } }, error => { throw error; });
    return { status, result };
  };
  try {
    const saved = await invoke({ market: 'WB', remoteIds: ['1', '2', '99'], discount: 35, action: 'enter', confirm: true });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.result.applied, ['1']);
    assert.deepEqual(saved.result.skipped.map(item => item.remoteId), ['2', '99']);
    const writes = calls.filter(call => call.sql.includes('INSERT INTO wb_price_update_queue'));
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].params.slice(0, 4), ['WB', '1', null, 35]);
    assert.ok(calls.some(call => call.sql.includes('pg_advisory_xact_lock')));
    assert.ok(calls.some(call => call.sql === 'COMMIT'));
    calls.length = 0; failInsert = true;
    const failed = await invoke({ market: 'WB2', remoteIds: ['1'], price: 1200, confirm: true });
    assert.equal(failed.status, 500);
    assert.ok(calls.some(call => call.sql === 'ROLLBACK'));
    assert.ok(!calls.some(call => call.sql === 'COMMIT'));
    calls.length = 0;
    assert.equal((await invoke({ market: 'WB', remoteIds: ['1'], discount: 10 })).status, 400);
    assert.equal(calls.length, 0);
  } finally { pool.connect = original; }
});

test('select all respects search, bulk requests capture the shop, and switching shops clears selection', async () => {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', innerHTML: '', textContent: '', classList: { contains: () => true, toggle() {} }, setAttribute() {} });
    return elements.get(id);
  };
  const posts = [];
  let sheet = '';
  const ctx = { Number, String, Date, Map, Set, JSON, Math, console, setTimeout,
    KEY: 'fixture', MILLIONER_API: 'https://fixture.invalid',
    localStorage: { getItem: () => '{}', setItem() {} },
    document: { getElementById: element, querySelectorAll: () => [], querySelector: () => null, body: { contains: () => false } },
    confirm: () => true, alert: message => { throw new Error(message); },
    showSheet: html => { sheet = html; }, closeModal() {},
    fetch: async (url, options = {}) => {
      let data;
      if (options.method === 'POST') { const body = JSON.parse(options.body); posts.push(body); data = { ok: true, applied: body.remoteIds, skipped: [] }; }
      else {
        const market = url.includes('market=WB2') ? 'WB2' : 'WB';
        data = { fetchedAt: Date.now(), rows: [
          { market, remoteId: '1', name: 'Брелок', price: 1000, discount: 10, promoPlanPrice: 650, grouped: true, groupImtId: '101', groupSize: 2 },
          { market, remoteId: '2', name: 'Нож', price: 2000, discount: 20, promoPlanPrice: 1200, grouped: true, groupImtId: '202', groupSize: 2 }
        ] };
      }
      return { ok: true, text: async () => JSON.stringify(data), json: async () => data };
    }
  };
  ctx.window = ctx;
  runInNewContext(readFileSync(new URL('../../prices-v1.js', import.meta.url), 'utf8'), ctx);
  ctx.priceSetMarket('WB'); await ctx.renderPrices();
  ctx.priceSelectAllVisible(true);
  assert.equal(element('priceSelectedCount').textContent, 'Выбрано 2');
  ctx.priceClearSelection(); ctx.priceSearch('Брелок'); ctx.priceSelectAllVisible(true);
  assert.equal(element('priceSelectedCount').textContent, 'Выбрано 1');
  ctx.openPriceWorkbench('enter'); assert.match(sheet, /Войти в акцию · 1/);
  assert.match(element('priceWorkbenchPreview').innerHTML, /35%/);
  // Switching the current shop while the form remains open must not redirect its write.
  ctx.priceSetMarket('WB2'); await ctx.renderPrices();
  assert.equal(element('priceSelectedCount').textContent, '');
  await ctx.submitPriceWorkbench();
  assert.equal(posts[0].market, 'WB');
  assert.deepEqual(posts[0].remoteIds, ['1']);
  ctx.priceSearch('');
  assert.match(element('priceGroupSelect').innerHTML, /value="101"/);
  assert.match(element('priceGroupSelect').innerHTML, /1 видно \/ 2/);
  ctx.priceSearch('Нож');
  assert.doesNotMatch(element('priceGroupSelect').innerHTML, /value="101"/);
  assert.match(element('priceGroupSelect').innerHTML, /value="202"/);
  ctx.priceSearch(''); ctx.priceSetGroup('101'); ctx.priceSearch('Нож');
  assert.equal(element('priceGroupSelect').value, '101');
  assert.match(element('priceGroupSelect').innerHTML, /нет видимых товаров/);
  assert.match(element('priceList').innerHTML, /нет товаров по текущему поиску/);
  assert.match(element('priceList').innerHTML, /Очистить поиск/);
  ctx.priceSearch(''); ctx.hidePriceRow(0);
  assert.match(element('priceList').innerHTML, /Все товары этой группы скрыты/);
  assert.match(element('priceList').innerHTML, /Показать скрытые/);
  ctx.priceSetGroup('');
  assert.doesNotMatch(element('priceGroupSelect').innerHTML, /value="101"/);
  assert.match(element('priceGroupSelect').innerHTML, /value="202"/);
  ctx.priceSetGroup('999');
  assert.match(element('priceList').innerHTML, /Группа не найдена/);
  assert.match(element('priceList').innerHTML, /Все группы/);
  assert.equal(posts.length, 1, 'group filtering must not write business data');
});
