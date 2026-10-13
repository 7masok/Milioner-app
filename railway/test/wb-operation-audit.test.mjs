import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { buildWbOperationAudit } from '../src/wb-operation-audit.js';
import { reportsRouter } from '../src/reports.js';
import { pool } from '../src/db.js';

const DAY = 86400000, START = Date.parse('2026-10-01T00:00:00+05:00');
function row(rrdId, operation, raw = {}, extra = {}) {
  return { market: 'WB', rrd_id: String(rrdId), rr_date: START, vendor_code: 'item', nm_id: '100', qty: 1, doc_type: 'Продажа',
    operation, retail_amount: 0, for_pay: 0, acquiring_fee: 0, delivery_service: 0, paid_storage: 0, paid_acceptance: 0, deduction: 0, penalty: 0, rebill_logistic_cost: 0, additional_payment: 0,
    raw_json: JSON.stringify({ sellerOperName: operation, currency: 'KZT', sku: 'barcode-a', srid: 'order-a', shkId: 'unit-a', ...raw }), ...extra };
}
const base = { market: 'WB', links: [{ market: 'WB', sku: 'barcode-a', productId: 'a' }, { market: 'WB', sku: 'barcode-b', productId: 'b' }], products: [{ id: 'a', name: 'Товар A' }, { id: 'b', name: 'Товар B' }], since: START, until: START + DAY };
const build = rows => buildWbOperationAudit({ ...base, rows });

test('an отказ and resale from WB stock has one sale, both delivery legs, and no warehouse mutations', () => {
  const rows = [row(1, 'Логистика', { deliveryService: 100 }), row(2, 'Логистика', { deliveryService: 60, returnAmount: 1 }),
    row(3, 'Продажа', { srid: 'order-b', retailAmount: 1000, forPay: 700, acquiringFee: 20, ppvzSalesCommission: 280 }),
    row(4, 'Логистика', { srid: 'order-b', deliveryService: 90, warehouseName: 'Склад WB' })];
  const before = JSON.stringify(rows), data = build(rows), t = data.totals[0];
  assert.equal(t.saleQty, 1); assert.equal(t.returnQty, 0); assert.equal(t.delivery, 250); assert.equal(t.beforeAdsAndCost, 450);
  assert.equal(t.commission, 280); assert.equal(t.acquiring, 20); assert.equal(data.orders.length, 2);
  assert.equal(data.units.length, 1); assert.deepEqual(data.units[0].srids, ['order-a', 'order-b']);
  assert.equal(JSON.stringify(rows), before); assert.equal(data.operations.some(x => 'cost' in x || 'stock' in x), false);
});
test('positive report return amounts reverse payout once; logistics remains an expense', () => {
  const data = build([row(1, 'Продажа', { retailAmount: 1000, forPay: 700 }),
    row(2, 'Возврат', { docTypeName: 'Возврат', retailAmount: 1000, forPay: 700, acquiringFee: 20 }),
    row(3, 'Логистика', { docTypeName: 'Возврат', deliveryService: 60 }),
    row(4, 'Продажа', { srid: 'order-b', retailAmount: 1200, forPay: 800 })]);
  assert.equal(data.totals[0].saleQty, 2); assert.equal(data.totals[0].returnQty, 1);
  assert.equal(data.totals[0].forPay, 800); assert.equal(data.totals[0].beforeAdsAndCost, 740);
  const negative = build([row(5, 'Возврат', { docTypeName: 'Возврат', retailAmount: -1000, forPay: -700 })]);
  assert.equal(negative.totals[0].forPay, -700);
});
test('cash WB Promotion charge and campaign spend are visible separately without double subtraction', () => {
  const data = buildWbOperationAudit({ ...base, rows: [row(1, 'Продажа', { forPay: 700 }), row(2, 'Удержание', { deduction: 50, bonusTypeName: 'WB Продвижение' })],
    adRows: [{ day: '2026-10-01', amount: 50, nmIds: ['100'], advertId: 'ad1' }] });
  assert.equal(data.totals[0].settlement, 650); assert.equal(data.totals[0].beforeAdsAndCost, 700);
  assert.equal(data.totals[0].promotionDeduction, 50); assert.equal(data.advertising[0].amount, 50);
  assert.equal(data.advertising[0].productId, 'a'); assert.equal(data.advertising[0].currency, 'UNKNOWN');
});
test('size-specific barcode wins over shared article; shared logistics cannot be guessed for one size', () => {
  const data = buildWbOperationAudit({ ...base, links: [...base.links, { sku: 'item', productId: 'parent' }, { sku: '100', productId: 'parent' }],
    rows: [row(1, 'Продажа'), row(2, 'Продажа', { sku: 'barcode-b', shkId: 'unit-b' }), row(3, 'Логистика', { sku: '', srid: '', shkId: 0, deliveryService: 40 })],
    adRows: [{ amount: 50, nmIds: ['100'] }] });
  assert.deepEqual(data.operations.map(x => x.productId), ['a', 'b', '']);
  assert.equal(data.advertising[0].productId, ''); assert.equal(data.advertising[0].reason, 'multiple_products');
  assert.equal(data.reconciliation[0].balanced, true); assert.equal(data.products.length, 3);
});
test('advertising with two known sizes stays unallocated even when only one size sold this period', () => {
  const data = buildWbOperationAudit({ ...base, products: [{ id: 'a', name: 'A', payload: { wbIdentity: { nmId: '100' } } }, { id: 'b', name: 'B', payload: { wbIdentity: { nmId: '100' } } }],
    rows: [row(1, 'Продажа')], adRows: [{ amount: 20, nmIds: ['100'] }] });
  assert.equal(data.advertising[0].productId, '');
});
test('multi-product or partially linked campaign is never spread over sales; ad-only products remain visible', () => {
  const data = buildWbOperationAudit({ ...base, links: [...base.links, { sku: '200', productId: 'b' }], rows: [row(1, 'Продажа')],
    adRows: [{ amount: 20, nmIds: ['100', '200'] }, { amount: 30, nmIds: ['100', 'unknown'] }, { amount: 40, nmIds: ['200'] }] });
  assert.deepEqual(data.advertising.map(x => x.productId), ['', '', 'b']);
  assert.equal(data.products.find(x => x.productId === 'b').rows.length, 0);
  assert.equal(data.products.find(x => x.productId === 'b').advertising.length, 1);
  assert.equal(data.totals[0].beforeAdsAndCost, 0);
});
test('only rrdId is deduplicated, later snapshot wins, order repeats retain legitimate logistics', () => {
  const data = build([row(1, 'Логистика', { deliveryService: 10 }, { updated_at: 1 }), row(1, 'Логистика', { deliveryService: 15 }, { updated_at: 2 }), row(2, 'Логистика', { deliveryService: 30 })]);
  assert.equal(data.rowCount, 2); assert.equal(data.duplicateRows, 1); assert.equal(data.totals[0].delivery, 45);
});
test('two pieces with the same barcode are not one physical unit or one order', () => {
  const data = build([row(1, 'Продажа', { srid: 'one', shkId: 'one' }), row(2, 'Продажа', { srid: 'two', shkId: 'two' }), row(3, 'Логистика', { srid: '', shkId: 0 })]);
  assert.equal(data.units.length, 2); assert.equal(data.orders.length, 3); assert.equal(data.coverage.unitRows, 2);
});
test('missing article can be recovered through an exact order/unit, but contradictory identities remain unlinked', () => {
  const data = build([row(1, 'Продажа'), row(2, 'Логистика', { sku: '', vendorCode: '', nmId: '100', deliveryService: 40 }),
    row(3, 'Логистика', { sku: '', vendorCode: '', nmId: '999', srid: 'order-a', shkId: 'unit-a' })]);
  assert.equal(data.operations[1].productId, 'a'); assert.equal(data.operations[1].linkSource, 'order');
  assert.equal(data.operations[2].productId, '');
  assert.equal(data.reconciliation[0].balanced, true);
});
test('WB1/WB2 and the report-date window stay isolated, explicit zero raw money overrides obsolete parsed data', () => {
  const data = build([row(1, 'Продажа', { forPay: '0', deliveryService: '0' }, { for_pay: 100, delivery_service: 20 }),
    row(2, 'Продажа', { forPay: 99 }, { market: 'WB2' }), row(3, 'Продажа', { forPay: 99 }, { rr_date: START + DAY }), row(4, 'Продажа', { forPay: 99 }, { rr_date: START - 1 })]);
  assert.equal(data.rowCount, 1); assert.equal(data.totals[0].forPay, 0); assert.equal(data.totals[0].delivery, 0);
  assert.equal(data.totals[0].calculationDelta, -80);
});

test('finance lowercased seller article links to its stored product and physical units in the same cabinet', () => {
  const data = buildWbOperationAudit({ market: 'WB2', since: START, until: START+DAY,
    links: [{market:'WB2',sku:'Крылья ангела',productId:'wings'},{market:'WB',sku:'Крылья ангела',productId:'other'}],
    products: [{id:'wings',name:'Крылья ангела',payload:{wb2Identity:{nmId:'1034505393'}}}],
    rows: [row(1,'Продажа',{vendorCode:' крылья ангела ',nmId:'1034505393',sku:'2051307526180',shkId:'56878140264',forPay:700},{market:'WB2'}),
      row(2,'Логистика',{vendorCode:'КРЫЛЬЯ АНГЕЛА',nmId:'1034505393',sku:'2051307526180',shkId:'56878140264',deliveryService:50},{market:'WB2'})] });
  assert.equal(data.products.length,1); assert.equal(data.products[0].productId,'wings');
  assert.ok(data.operations.every(x=>x.productId==='wings'));assert.equal(data.units.length,1);
  assert.equal(data.units[0].rows.length,2);assert.equal(data.totals[0].beforeAdsAndCost,650);
});

test('case-insensitive seller article collisions never guess a product', () => {
  const data = buildWbOperationAudit({...base,links:[{sku:'Item',productId:'a'},{sku:'ITEM',productId:'b'}],
    rows:[row(1,'Продажа',{vendorCode:'item',sku:''})]});
  assert.equal(data.operations[0].productId,'');assert.equal(data.operations[0].linkSource,'ambiguous');
});

test('article casing does not collapse sizes and exact barcodes keep priority', () => {
  const data=buildWbOperationAudit({...base,links:[...base.links,{sku:'ITEM',productId:'parent'}],
    products:[...base.products,{id:'a',payload:{wbIdentity:{nmId:'100'}}},{id:'b',payload:{wbIdentity:{nmId:'100'}}}],
    rows:[row(1,'Продажа',{vendorCode:'item'}),row(2,'Логистика',{vendorCode:'item',sku:'',shkId:0,srid:''})]});
  assert.equal(data.operations[0].productId,'a');assert.equal(data.operations[1].productId,'');
});
test('currency buckets, negative logistics corrections and malformed money are not silently flattened', () => {
  const data = build([row(1, 'Продажа', { currency: 'KZT', forPay: 700 }), row(2, 'Логистика', { currency: 'KZT', deliveryService: -10 }), row(3, 'Продажа', { currency: 'RUB', forPay: 100 }), row(4, 'Продажа', { currency: '', forPay: 40 })]);
  assert.deepEqual(data.totals.map(x => [x.currency, x.beforeAdsAndCost]), [['KZT', 710], ['RUB', 100], ['UNKNOWN', 40]]);
  assert.ok(data.reconciliation.every(x => x.balanced));
  assert.throws(() => build([row(5, 'Продажа', { forPay: 'broken' })]), /Некорректная сумма WB/);
  assert.throws(() => buildWbOperationAudit({ ...base, adRows: [{ amount: 'broken' }] }), /Некорректный расход рекламы/);
});
test('return operation still reverses payout when legacy data lacks document type', () => {
  const data = build([row(1, 'Возврат', { forPay: 700 }, { doc_type: '' })]);
  assert.equal(data.totals[0].forPay, -700); assert.equal(data.totals[0].returnQty, 1);
});

const handler = reportsRouter.stack.find(x => x.route?.path === '/wb-operation-audit').route.stack[0].handle;
async function invoke(query, respond) {
  const old = pool.query, calls = []; pool.query = async (sql, args) => { calls.push({ sql, args }); return { rows: respond(sql, args) }; };
  let status = 200, result;
  try { await handler({ query }, { status(code) { status = code; return this; }, json(data) { result = data; } }, error => { throw error; }); }
  finally { pool.query = old; }
  return { status, result, calls };
}
test('audit endpoint uses bounded parameterized cache reads, preserves custom Almaty dates and never writes/calls WB', async () => {
  const result = await invoke({ market: 'WB1', days: '0', from: String(START), to: String(START + DAY) }, sql => sql.startsWith('SELECT *') ? [row(1, 'Продажа')] : sql.includes('warehouse_products') ? base.products : sql.includes('product_links') ? base.links : []);
  assert.equal(result.status, 200); assert.equal(result.result.market, 'WB'); assert.equal(result.result.range.since, START);
  assert.deepEqual(result.calls[0].args, ['WB', START, START + DAY]);
  assert.ok(result.calls.every(x => /^SELECT /.test(x.sql)));
  assert.deepEqual(result.calls.find(x => x.sql.includes('wb_ad_costs')).args, ['WB', ['2026-10-01']]);
});
test('invalid cabinet/range and oversized result never masquerade as successful empty data', async () => {
  assert.equal((await invoke({ market: 'Kaspi' }, () => { throw Error('must not query'); })).status, 400);
  assert.equal((await invoke({ market: 'WB', days: '0', from: '1', to: '0' }, () => { throw Error('must not query'); })).status, 400);
  const result = await invoke({ market: 'WB', days: 1 }, sql => sql.startsWith('SELECT *') ? Array(50001).fill({}) : []);
  assert.equal(result.status, 422); assert.equal(result.result.ok, false);
});

const ui = readFileSync(new URL('../../wb-operation-audit-v1.js', import.meta.url), 'utf8');
function uiFixture() {
  let markup = '';
  const elements = new Map(), listeners = new Map(), el = { dataset: {}, querySelector(selector) { const attribute=selector.match(/^\[([^=]+)\]$/)?.[1];if(attribute&&!markup.includes(attribute))return null;if (!elements.has(selector)) elements.set(selector, { innerHTML: '', hidden: true, value: '' }); return elements.get(selector); }, querySelectorAll() { return []; }, addEventListener(name, fn) { listeners.set(name, fn); }, contains() { return true; } };
  let current = null;
  const context = { console, Intl, Date, Math, reportCustomBounds: () => ({ start: START, end: START + DAY }), MILLIONER_API: '', apiJson: async () => ({ ok: true, ...build([row(1, 'Продажа', { forPay: 700 })]) }), openStoreDetail: () => {}, alert: () => {},
    document: { getElementById: () => current, createElement: () => ({}), head: { appendChild() {} } }, showSheet(html) { markup=html;elements.clear();current = el; el.dataset.request = html.match(/data-request="([^"]+)"/)[1]; }, window: {} };
  vm.runInNewContext(ui.replace(/\}\)\(\);\s*$/, 'window.fixture={operationHtml,draw,mount,get active(){return active}};})();'), context);
  return { context, el, elements, listeners, get markup(){return markup}, close() { current = null; } };
}
test('audit UI escapes marketplace text, respects currencies and never labels an unverified result as net profit', () => {
  const { context } = uiFixture(), r = build([row(1, '<img src=x onerror=attack>', { currency: 'RUB', forPay: 10, srid: '<unsafe>' })]).operations[0];
  const html = context.window.fixture.operationHtml(r);
  assert.ok(html.includes('&lt;img')); assert.ok(!html.includes('<img')); assert.ok(html.includes('&lt;unsafe&gt;')); assert.ok(html.includes(' ₽'));
  assert.ok(html.includes('до рекламы и себестоимости')); assert.ok(!html.includes('Чистая прибыль'));
});
test('closing/navigating away while audit loads cannot overwrite another sheet', async () => {
  const f = uiFixture();let resolve; f.context.apiJson = () => new Promise(r => { resolve = r; });
  f.context.window.openWbOperationAudit('WB', 7); const summary = f.el.querySelector('[data-audit-summary]'); f.close(); resolve({ ok: true, ...build([row(1, 'Продажа')]) });
  await new Promise(r => setImmediate(r));
  assert.equal(summary.innerHTML, '');
});
test('audit UI paginates read-only products, preserves unknown/ad-only rows and opens order detail', async () => {
  const f = uiFixture(), many = Array.from({ length: 25 }, (_, i) => row(i + 1, 'Продажа', { vendorCode: 'v' + i, nmId: 'n' + i, sku: 'b' + i }));
  f.context.apiJson = async () => ({ ok: true, ...build(many) }); f.context.window.openWbOperationAudit('WB', 7); await new Promise(r => setImmediate(r));
  const ctx = f.context.window.fixture.active;
  assert.equal((f.elements.get('[data-audit-body]').innerHTML.match(/wb-audit-product/g) || []).length, 20);
  assert.ok(f.elements.get('[data-audit-pager]').innerHTML.includes('1 / 2'));
  ctx.page = 2; f.context.window.fixture.draw(ctx); assert.equal((f.elements.get('[data-audit-body]').innerHTML.match(/wb-audit-product/g) || []).length, 5);
  ctx.mode = 'orders'; ctx.q = 'n0'; ctx.page = 1; f.context.window.fixture.draw(ctx);
  assert.ok(f.elements.get('[data-audit-body]').innerHTML.includes('Заказ order-a'));
  assert.ok(!/\b(save|pushWarehouseToServer|persistWarehouse|reconcileMarketplaceSales)\s*\(/.test(ui));
});
test('both report paths expose product entry without a separate audit button, before owner startup', () => {
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const report = readFileSync(new URL('../../kaspi-report-v2.js', import.meta.url), 'utf8');
  const tag = '<script src="./wb-operation-audit-v1.js?v=20261013-cost-fees"></script>';
  assert.ok(html.includes(tag)); assert.ok(html.indexOf(tag) < html.lastIndexOf('initOwnerAuth()'));
  assert.ok(html.includes('async function openWbFinanceReport(market,days){return openStoreDetail(market,days)}'));
  assert.ok(report.includes('wbReportProductAuditAction(market,days,'));
  assert.ok(!html.includes('wbOperationAuditButton'));
  assert.ok(!report.includes('wbOperationAuditButton'));
  assert.ok(server.includes("'wb-operation-audit-v1.js'"));
  assert.ok(server.indexOf("app.use('/api', requireAppSession)") < server.indexOf("app.use('/api', reportsRouter)"));
});

test('clicking a report product opens its units immediately and excludes other products', async () => {
  const f = uiFixture();
  f.context.apiJson = async () => ({ ok: true, ...build([row(1, 'Продажа'), row(2, 'Продажа', { sku: 'barcode-b', shkId: 'unit-b', srid: 'order-b' })]) });
  f.context.window.openWbProductOperations('WB', 30, { productId: 'a', name: 'Товар A' });
  await new Promise(r => setImmediate(r));
  const ctx = f.context.window.fixture.active;
  assert.equal(ctx.product, 'p:a'); assert.equal(ctx.mode, 'units'); assert.equal(ctx.days, 30);
  assert.equal(f.el.querySelector('[data-audit-product]'), null);
  assert.ok(f.markup.includes('<h3>Товар A</h3>'));
  const body = f.elements.get('[data-audit-body]').innerHTML;
  assert.ok(body.includes('unit-a')); assert.ok(!body.includes('unit-b'));
});

test('changing audit periods keeps the product and returns to the original report period', async () => {
  const f = uiFixture(); let back;
  f.context.openWbOperationAudit = f.context.window.openWbOperationAudit;
  f.context.openStoreDetail = (market, days) => { back = { market, days }; };
  f.context.window.openWbProductOperations('WB', -1, { productId: 'a', name: 'Товар A' });
  await new Promise(r => setImmediate(r));
  const click = dataset => f.listeners.get('click')({ target: { closest: () => ({ dataset }) } });
  click({ auditDays: '7' }); await new Promise(r => setImmediate(r));
  const ctx = f.context.window.fixture.active;
  assert.equal(ctx.days, 7); assert.equal(ctx.product, 'p:a'); assert.equal(ctx.mode, 'units');
  click({ auditAction: 'back' }); assert.deepEqual(back, { market: 'WB', days: -1 });
});

test('custom report dates are passed through and an absent product never opens all products', async () => {
  const f = uiFixture(); let query;
  f.context.apiJson = async url => { query = url; return { ok: true, ...build([row(1, 'Продажа')]) }; };
  f.context.window.openWbProductOperations('WB', 0, { productId: 'absent', name: 'Нет продаж' });
  await new Promise(r => setImmediate(r));
  assert.ok(query.includes('&from=' + START + '&to=' + (START + DAY)));
  assert.equal(f.context.window.fixture.active.product, 'p:absent');
  assert.equal(f.el.querySelector('[data-audit-product]'), null);
  assert.ok(f.markup.includes('Нет продаж'));
  assert.ok(!f.elements.get('[data-audit-body]').innerHTML.includes('unit-a'));
});

test('unlinked products use precise marketplace identity and ambiguous selection stays empty', async () => {
  const f = uiFixture();
  const data = build([row(1, 'Продажа'), row(2, 'Продажа', { sku: 'barcode-b', shkId: 'unit-b' })]);
  f.context.apiJson = async () => ({ ok: true, ...data });
  f.context.window.openWbProductOperations('WB', 7, { barcode: 'barcode-b', name: 'B' });
  await new Promise(r => setImmediate(r));
  assert.equal(f.context.window.fixture.active.product, 'p:b');
  f.context.window.openWbProductOperations('WB', 7, { vendorCode: 'item', nmId: '100', name: 'Общая карточка' });
  await new Promise(r => setImmediate(r));
  assert.equal(f.context.window.fixture.active.product, '__selected_missing__');
  assert.ok(!f.elements.get('[data-audit-body]').innerHTML.includes('unit-a'));
  assert.ok(!f.elements.get('[data-audit-body]').innerHTML.includes('unit-b'));
});

test('report click actions safely quote identities and are available to keyboard users only for WB', () => {
  const f = uiFixture(), item = { productId: 'id\";attack()', name: '<img src=x>' };
  const action = f.context.window.wbReportProductAuditAction('WB2', 30, item);
  let selected;
  vm.runInNewContext(action, { openWbProductOperations: (...args) => { selected = args; } });
  assert.equal(selected[0], 'WB2'); assert.equal(selected[1], 30); assert.equal(selected[2].productId, item.productId);
  const attrs = f.context.window.wbReportProductAuditAttrs('WB2', 30, item);
  assert.ok(attrs.includes('role="button" tabindex="0"'));
  assert.ok(attrs.includes('onkeydown=')); assert.ok(attrs.includes('Enter')); assert.ok(!attrs.includes('<img'));
  assert.equal(f.context.window.wbReportProductAuditAction('Kaspi', 30, item), '');
});

test('report product card carries the audit action to mouse and keyboard handlers', () => {
  const report = readFileSync(new URL('../../kaspi-report-v2.js', import.meta.url), 'utf8');
  const functions = ['paintWbSheet', 'paintStoreSheet'].map(name => report.split('\n').find(x => x.startsWith('function ' + name + '('))).join('\n');
  const f = uiFixture(); let html;
  const c = { ...f.context, wbReportProductAuditAction: f.context.window.wbReportProductAuditAction,
    esc: x => String(x ?? '').replaceAll('"', '&quot;').replaceAll('<', '&lt;'), fmt: x => String(x),
    wbLiveProductId: (_market, item) => item.productId, wbRealizedFifoCost: () => 100,
    productNameById: () => 'Товар A', wbFinanceAvailabilityNote: () => '', storeTitle: () => 'WB 2', detailPeriodHtml: () => '', showSheet: value => { html = value; } };
  vm.runInNewContext(functions, c);
  c.paintWbSheet({ financeAvailable: true, complete: true, products: [{ productId: 'a', vendorCode: 'item', nmId: '100', qty: 1, retailAmount: 1000, netBeforeCost: 700 }],
    revenue: 1000, adjustment: 0, expenses: 300, cost: 100, ads: 0, profit: 600 }, 'WB2', 30);
  assert.ok(html.includes('openWbProductOperations'));
  assert.ok(html.includes('onclick=')); assert.ok(html.includes('onkeydown='));
  assert.ok(!html.includes('>Операции WB<'));
});

test('product details omit store totals, reconciliation, product selectors and unnecessary controls', async () => {
  const f = uiFixture();
  f.context.apiJson = async () => ({ ok: true, ...build([row(1, 'Продажа', { forPay: 700 }), row(2, 'Продажа', { sku: 'barcode-b', forPay: 900000 })]) });
  f.context.window.openWbProductOperations('WB', 30, { productId: 'a', name: 'Товар A' });
  await new Promise(r => setImmediate(r));
  for(const selector of ['[data-audit-summary]','[data-audit-product]','[data-audit-filter]','[data-audit-search]'])assert.equal(f.el.querySelector(selector),null);
  assert.ok(!f.markup.includes('Сверка и привязки'));
  assert.ok(!f.markup.includes('data-audit-mode="products"'));
  assert.ok(!f.markup.includes('data-audit-action="refresh"'));
  for(const mode of ['orders','units','ads'])assert.ok(f.markup.includes('data-audit-mode="'+mode+'"'));
  assert.equal(f.elements.get('[data-audit-pager]').innerHTML,'');
  assert.ok(!f.elements.get('[data-audit-body]').innerHTML.includes('900'));
});

test('report product click shows units built from lowercase finance articles instead of an empty result', async () => {
  const data=buildWbOperationAudit({...base,links:[{sku:'Крылья ангела',productId:'wings'}],
    products:[{id:'wings',name:'Крылья ангела',payload:{wbIdentity:{nmId:'100'}}}],
    rows:[row(1,'Продажа',{vendorCode:'крылья ангела',sku:'wings-barcode',shkId:'56878140264'})]});
  const f=uiFixture();f.context.apiJson=async()=>({ok:true,...data});
  f.context.window.openWbProductOperations('WB',30,{productId:'wings',name:'Крылья ангела'});
  await new Promise(r=>setImmediate(r));
  const body=f.elements.get('[data-audit-body]').innerHTML;
  assert.ok(body.includes('56878140264'));assert.ok(!body.includes('Нет загруженных операций'));
  assert.equal(f.context.window.fixture.active.product,'p:wings');
});

test('product-only missing-unit count and advertising totals exclude other products', async () => {
  const f=uiFixture();
  const data=buildWbOperationAudit({...base,links:[...base.links,{sku:'200',productId:'b'}],rows:[
    row(1,'Продажа'),row(2,'Логистика',{shkId:0}),row(3,'Продажа',{sku:'barcode-b',nmId:'200',shkId:0,srid:'b'}),row(4,'Логистика',{sku:'barcode-b',nmId:'200',shkId:0,srid:'b'})
  ],adRows:[{amount:50,nmIds:['100']},{amount:900000,nmIds:['200']}]});
  f.context.apiJson=async()=>({ok:true,...data});
  f.context.window.openWbProductOperations('WB',30,{productId:'a',name:'A'});await new Promise(r=>setImmediate(r));
  assert.ok(f.elements.get('[data-audit-body]').innerHTML.includes('Без ШК: 1 оп.'));
  f.listeners.get('click')({target:{closest:()=>({dataset:{auditMode:'ads'}})}});
  const html=f.elements.get('[data-audit-body]').innerHTML;
  assert.ok(html.includes('Реклама товара'));assert.ok(!html.includes('Вся реклама'));assert.ok(!html.includes('900'));
});

test('product-only period changes stay compact and cannot reset to the entire product catalog', async () => {
  const f=uiFixture();f.context.openWbOperationAudit=f.context.window.openWbOperationAudit;
  f.context.window.openWbProductOperations('WB',30,{productId:'a',name:'A'});await new Promise(r=>setImmediate(r));
  const click=dataset=>f.listeners.get('click')({target:{closest:()=>({dataset})}});
  click({auditDays:'7'});await new Promise(r=>setImmediate(r));
  const ctx=f.context.window.fixture.active;assert.equal(ctx.productOnly,true);assert.equal(ctx.product,'p:a');
  assert.equal(f.el.querySelector('[data-audit-summary]'),null);
  click({auditMode:'products'});assert.equal(ctx.mode,'units');
  click({auditAction:'product',key:'p:b'});assert.equal(ctx.product,'p:a');
});


test('screenshot fees retain seller price, WB discount, VAT and actual KZT delivery without extra deductions', () => {
  const data=build([row(1,'Продажа',{retailPriceWithDisc:'1852.67',retailAmount:'1482.14',forPay:'1396.56',ppvzSalesCommission:'68.67',vw:'68.6724137931034483',vwNds:'10.99',acquiringFee:'5.92',commissionPercent:24.3,spp:20}),row(2,'Логистика',{deliveryService:'164.35',bonusTypeName:'К клиенту при продаже'})]);
  const r=data.operations[0];assert.equal(r.commissionVat,10.99);assert.equal(r.sellerUnitPrice,1852.67);assert.equal(r.commissionPercent,24.3);assert.equal(r.wbDiscountPercent,20);
  assert.ok(Math.abs(data.totals[0].beforeAdsAndCost-1232.21)<1e-8);
  const html=uiFixture().context.window.fixture.operationHtml(r);
  for(const label of ['Цена продавца / шт.','кВВ: 24,3%','Скидка WB: 20%','НДС WB','10,99','Удержано из цены продавца','456,11'])assert.ok(html.includes(label),label);
  assert.ok(uiFixture().context.window.fixture.operationHtml(data.operations[1]).includes('К клиенту при продаже'));
  const returned=build([row(3,'Возврат',{ppvz_vw_nds:'10.99',ppvz_vw:'68.67'})]).operations[0];assert.equal(returned.commissionVat,-10.99);assert.equal(returned.wbReward,-68.67);
});
test('saved cost requires one matching cabinet/product/order and never consumes warehouse stock', () => {
  const input={...base,rows:[row(1,'Продажа',{forPay:700}),row(2,'Логистика',{deliveryService:90})],saleCosts:[{market:'WB',srid:'order-a',productId:'a',qty:1,cost:160},{market:'WB2',srid:'order-a',productId:'a',qty:1,cost:999},{market:'WB',srid:'order-a',productId:'b',qty:1,cost:999}]};
  const original=JSON.stringify(input),data=buildWbOperationAudit(input);assert.equal(data.operations[0].costKzt,160);assert.equal(data.operations[0].costSource,'saved_order');assert.equal(data.operations[0].costEstimated,false);
  assert.equal(data.operations[1].costKzt,undefined);assert.equal(JSON.stringify(input),original);
});
test('unmatched FBO sale estimates weighted accepted landed cost; excludes transit and relocations', () => {
  const data=buildWbOperationAudit({...base,rows:[row(1,'Продажа',{forPay:700})],purchaseRows:[
    {productId:'a',qty:2,status:'received',unitCost:100,delivery:20},
    {product_id:'a',qty:1,status:'at_warehouse',payload:{landedUnitCost:200,delivery:999}},
    {productId:'a',qty:100,status:'to_me',landedUnitCost:1},
    {productId:'a',qty:100,status:'received',landedUnitCost:1,relocation:true}]});
  const r=data.operations[0];assert.equal(r.costKzt,140);assert.equal(r.costSource,'purchase_average');assert.equal(r.costEstimated,true);assert.equal(r.afterCostBeforeAds,560);
});
test('ambiguous, short and incomplete saved costs use an explicit estimate, never the first record', () => {
  for(const saleCosts of [[{productId:'a',srid:'order-a',qty:1,cost:50},{productId:'a',srid:'order-a',qty:1,cost:60}], [{productId:'a',srid:'order-a',qty:0,cost:50}], [{productId:'a',srid:'order-a',qty:1,cost:50,stockShortage:1}], [{productId:'a',srid:'order-a',qty:1,cost:null}]]){
    const r=buildWbOperationAudit({...base,products:[{id:'a',payload:{cost:100}}],rows:[row(1,'Продажа')],saleCosts}).operations[0];assert.equal(r.costKzt,100);assert.equal(r.costSource,'product_cost');assert.equal(r.costEstimated,true);
  }
});
test('cost returns reverse only once; unknown values and foreign currencies never create a fake margin', () => {
  const data=buildWbOperationAudit({...base,rows:[row(1,'Продажа',{forPay:700}),row(2,'Возврат',{forPay:700}),row(3,'Продажа',{currency:'RUB',forPay:700}),row(4,'Продажа',{currency:'',forPay:700})],saleCosts:[{productId:'a',srid:'order-a',qty:1,cost:160}]});
  assert.deepEqual(data.operations.map(x=>x.costKzt),[160,-160,160,160]);assert.equal(data.operations[2].afterCostBeforeAds,null);assert.equal(data.operations[3].afterCostBeforeAds,null);
  const missing=build([row(5,'Продажа',{forPay:700})]).operations[0];assert.equal(missing.costKzt,null);assert.equal(missing.afterCostBeforeAds,null);
  const f=uiFixture();assert.ok(f.context.window.fixture.operationHtml(missing).includes('<b>—</b>'));assert.ok(!f.context.window.fixture.operationHtml(missing).includes('После себестоимости'));
  const foreign=f.context.window.fixture.operationHtml(data.operations[2]);assert.ok(foreign.includes('160 ₸'));assert.ok(!foreign.includes('После себестоимости'));assert.ok(!foreign.includes('540'));
});
test('opened physical unit shows cost once for its buyout and margin including both logistics legs', async () => {
  const f=uiFixture(),data=buildWbOperationAudit({...base,rows:[row(1,'Логистика',{deliveryService:100}),row(2,'Продажа',{srid:'second',forPay:700}),row(3,'Логистика',{srid:'second',deliveryService:90})],saleCosts:[{productId:'a',srid:'second',qty:1,cost:160}]});
  f.context.apiJson=async()=>({ok:true,...data});f.context.window.openWbProductOperations('WB',1,{productId:'a',name:'A'});await new Promise(r=>setImmediate(r));
  const body=f.el.querySelector('[data-audit-body]').innerHTML;assert.ok(body.includes('Себестоимость заказа'));assert.ok(body.includes('350 ₸'));assert.ok(!body.includes('Чистая прибыль'));assert.ok(!f.markup.includes('data-audit-summary'));
});
test('cost cache reads join exact saved external key and UID, scoped to cabinet and report window', async () => {
  const out=await invoke({market:'WB',days:'0',from:String(START),to:String(START+DAY)},sql=>sql.startsWith('SELECT *')?[row(1,'Продажа',{forPay:700})]:sql.includes('FROM warehouse_sales')?[{market:'WB',srid:'order-a',productId:'a',qty:1,cost:160}]:sql.includes('warehouse_products')?base.products:sql.includes('product_links')?base.links:[]);
  assert.equal(out.result.operations[0].costKzt,160);const call=out.calls.find(x=>x.sql.includes('FROM warehouse_sales'));assert.deepEqual(call.args,['WB',START,START+DAY]);assert.ok(call.sql.includes('s.external_key=o.market'));assert.ok(call.sql.includes("->'order'->>'orderUid'"));assert.ok(out.calls.every(x=>/^SELECT /.test(x.sql)));
});
