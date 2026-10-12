import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const script = readFileSync(new URL('../../prices-v1.js', import.meta.url), 'utf8');
function fixture({ ready = true, confirmed = true, saved = true, pushed = true } = {}) {
  const elements = new Map(), alerts = [], confirmations = [], calls = { save: 0, push: 0 };
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', innerHTML: '', textContent: '', classList: { contains: () => true, toggle() {} }, setAttribute() {} });
    return elements.get(id);
  };
  const products = [{ id: 'yellow', kaspiPrice: 890 }, { id: 'red', kaspiPrice: 890 }, { id: 'knife', kaspiPrice: 1200 }];
  const rows = [
    { market: 'Kaspi', productId: 'yellow', sku: '1', name: 'Тетрис жёлтый', price: 890 },
    { market: 'Kaspi', productId: 'red', sku: '2', name: 'Тетрис красный', price: 890 },
    { market: 'Kaspi', productId: 'knife', sku: '3', name: 'Нож', price: 1200 },
    { market: 'Kaspi', sku: '4', name: 'Тетрис без привязки', price: 890 },
    { market: 'Kaspi', sku: '5', name: 'Тетрис ошибка', error: 'fixture error' }
  ];
  let sheet = '';
  const ctx = {
    KEY: 'fixture', MILLIONER_API: 'https://fixture.invalid', console, setTimeout,
    state: { products }, localStorage: { getItem: () => '{}', setItem() {} },
    document: { getElementById: element, querySelectorAll: () => [], querySelector: () => null, body: { contains: () => false } },
    showSheet: html => { sheet = html; element('priceWorkbenchPrice').value = ''; }, closeModal() {},
    requireWarehouseEditReady: () => ready,
    save() { calls.save++; return saved; }, async pushWarehouseToServer() { calls.push++; return pushed; },
    confirm: question => { confirmations.push(question); return confirmed; }, alert: text => alerts.push(text),
    async fetch(url, options = {}) {
      assert.notEqual(options.method, 'POST', 'Kaspi uses the existing warehouse save, never a WB request');
      const data = { fetchedAt: Date.now(), rows: url.includes('market=Kaspi') ? rows : [] };
      return { ok: true, text: async () => JSON.stringify(data) };
    }
  };
  ctx.window = ctx; runInNewContext(script, ctx);
  return { ctx, element, products, alerts, confirmations, calls, sheet: () => sheet };
}

test('Kaspi select all respects search and hidden rows; a confirmed batch saves once and retains unlinked selections', async () => {
  const f = fixture(), { ctx, element } = f;
  await ctx.renderPrices();
  assert.equal(element('priceBulkTools').hidden, false);
  assert.equal(element('priceBulkPrice').textContent, 'Изменить цену');
  assert.equal(element('priceBulkNight').hidden, true);
  assert.match(element('priceList').innerHTML, /price-row-select/);
  ctx.hidePriceRow(1); ctx.priceSearch('Тетрис'); ctx.priceSelectAllVisible(true);
  assert.equal(element('priceSelectedCount').textContent, 'Выбрано 2');
  assert.equal(element('priceSelectAll').checked, true);
  ctx.openPriceWorkbench('price');
  assert.match(f.sheet(), /Kaspi · 2/);
  assert.doesNotMatch(f.sheet(), /priceWorkbenchDiscount/);
  element('priceWorkbenchPrice').value = '990'; ctx.priceWorkbenchPreview();
  assert.match(element('priceWorkbenchPreview').innerHTML, /890 ₸ → 990 ₸/);
  assert.match(element('priceWorkbenchPreview').innerHTML, /Товар не привязан/);
  await ctx.submitPriceWorkbench();
  assert.deepEqual(f.products.map(p => p.kaspiPrice), [990, 890, 1200]);
  assert.deepEqual(f.calls, { save: 1, push: 1 });
  assert.equal(element('priceSelectedCount').textContent, 'Выбрано 1');
  assert.match(element('priceStatus').textContent, /XML обновлён/);
  assert.match(f.alerts[0], /Тетрис без привязки/);
  ctx.priceSelectAllVisible(false); assert.equal(element('priceSelectedCount').textContent, '');
});

test('Kaspi batch is fixed to its original selection even after switching shops', async () => {
  const f = fixture(), { ctx, element } = f;
  await ctx.renderPrices(); ctx.priceSearch('Тетрис'); ctx.priceSelectRow(0, true);
  assert.equal(element('priceSelectAll').indeterminate, true);
  ctx.openPriceWorkbench('price'); element('priceWorkbenchPrice').value = '1000';
  ctx.priceSetMarket('WB2'); await ctx.renderPrices();
  assert.equal(element('priceSelectedCount').textContent, '');
  await ctx.submitPriceWorkbench();
  assert.deepEqual(f.products.map(p => p.kaspiPrice), [1000, 890, 1200]);
  assert.equal(f.calls.push, 1);
});

for (const options of [{ ready: false }, { confirmed: false }, { saved: false }]) {
  test('Kaspi bulk write does not mutate prices when authorization/readiness/save fails: ' + JSON.stringify(options), async () => {
    const f = fixture(options); await f.ctx.renderPrices(); f.ctx.priceSelectRow(0, true);
    f.ctx.openPriceWorkbench('price'); f.element('priceWorkbenchPrice').value = '990';
    await f.ctx.submitPriceWorkbench();
    assert.equal(f.products[0].kaspiPrice, 890);
    assert.equal(f.calls.push, 0);
    assert.equal(f.element('priceSelectedCount').textContent, 'Выбрано 1');
  });
}

test('Kaspi rejects zero, fractional and malformed bulk prices without saving', async () => {
  const f = fixture(); await f.ctx.renderPrices(); f.ctx.priceSelectRow(0, true); f.ctx.openPriceWorkbench('price');
  for (const value of ['', '0', '-1', '1.5', 'bad']) {
    f.element('priceWorkbenchPrice').value = value; f.ctx.priceWorkbenchPreview(); await f.ctx.submitPriceWorkbench();
    assert.equal(f.element('priceWorkbenchApply').disabled, true);
  }
  assert.equal(f.calls.save, 0); assert.equal(f.products[0].kaspiPrice, 890);
});

test('Kaspi server rejection keeps selection and never claims confirmed success', async () => {
  const f = fixture({ pushed: false }); await f.ctx.renderPrices(); f.ctx.priceSelectRow(0, true); f.ctx.openPriceWorkbench('price');
  f.element('priceWorkbenchPrice').value = '990'; await f.ctx.submitPriceWorkbench();
  assert.equal(f.element('priceSelectedCount').textContent, 'Выбрано 1');
  assert.doesNotMatch(f.element('priceStatus').textContent, /Цены Kaspi сохранены|XML обновлён/);
  assert.match(f.alerts[0], /не подтверждено сервером/);
});
