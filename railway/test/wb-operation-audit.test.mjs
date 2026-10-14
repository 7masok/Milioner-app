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
  vm.runInNewContext(ui.replace(/\}\)\(\);\s*$/, 'window.fixture={operationHtml,historyHtml,unitSummaryHtml,periodMetricsHtml,draw,mount,get active(){return active}};})();'), context);
  return { context, el, elements, listeners, get markup(){return markup}, close() { current = null; } };
}
test('audit UI escapes marketplace text, respects currencies and never labels an unverified result as net profit', () => {
  const { context } = uiFixture(), r = build([row(1, '<img src=x onerror=attack>', { currency: 'RUB', forPay: 10, srid: '<unsafe>' })]).operations[0];
  const html = context.window.fixture.operationHtml(r);
  assert.ok(html.includes('&lt;img')); assert.ok(!html.includes('<img')); assert.ok(html.includes('&lt;unsafe&gt;')); assert.ok(html.includes(' ₽'));
  assert.ok(!html.includes('Прибыль')); assert.ok(!html.includes('Результат WB до рекламы и себестоимости'));
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
  const tag = '<script src="./wb-operation-audit-v1.js?v=20261014-period-sales"></script>';
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
    row(1,'Продажа'),row(2,'Продажа',{shkId:0}),row(3,'Продажа',{sku:'barcode-b',nmId:'200',shkId:0,srid:'b'}),row(4,'Логистика',{sku:'barcode-b',nmId:'200',shkId:0,srid:'b'}),row(5,'Логистика',{shkId:0})
  ],adRows:[{amount:50,nmIds:['100']},{amount:900000,nmIds:['200']}]});
  f.context.apiJson=async()=>({ok:true,...data});
  f.context.window.openWbProductOperations('WB',30,{productId:'a',name:'A'});await new Promise(r=>setImmediate(r));
  assert.ok(f.elements.get('[data-audit-body]').innerHTML.includes('Продажи без ШК: 1 оп.'));
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
  const f=uiFixture();assert.ok(f.context.window.fixture.unitSummaryHtml([missing]).includes('>—</b>'));assert.ok(!f.context.window.fixture.operationHtml(missing).includes('Прибыль'));
  const foreign=f.context.window.fixture.unitSummaryHtml([data.operations[2]]);assert.ok(foreign.includes('160 ₸'));assert.ok(!foreign.includes('После себестоимости'));assert.ok(!foreign.includes('540'));
});
test('opened physical unit shows cost once for its buyout and margin including both logistics legs', async () => {
  const f=uiFixture(),data=buildWbOperationAudit({...base,rows:[row(1,'Логистика',{deliveryService:100}),row(2,'Продажа',{srid:'second',forPay:700}),row(3,'Логистика',{srid:'second',deliveryService:90})],saleCosts:[{productId:'a',srid:'second',qty:1,cost:160}]});
  f.context.apiJson=async url=>url.includes('/wb-unit-history')?{ok:true,scope:'unit-history',market:'WB',shkId:'unit-a',nmId:'100',operations:data.operations,range:data.range}:{ok:true,...data};f.context.window.openWbProductOperations('WB',1,{productId:'a',name:'A'});await new Promise(r=>setImmediate(r));
  const opened=expandUnit(f,data.units[0]);await new Promise(r=>setImmediate(r));const body=opened.body.innerHTML;assert.ok(body.includes('Себестоимость заказа'));assert.ok(body.includes('350 ₸'));assert.ok(!body.includes('Чистая прибыль'));assert.ok(!f.markup.includes('data-audit-summary'));
});
test('cost cache reads join exact saved external key and UID, scoped to cabinet and report window', async () => {
  const out=await invoke({market:'WB',days:'0',from:String(START),to:String(START+DAY)},sql=>sql.startsWith('SELECT *')?[row(1,'Продажа',{forPay:700})]:sql.includes('FROM warehouse_sales')?[{market:'WB',srid:'order-a',productId:'a',qty:1,cost:160}]:sql.includes('warehouse_products')?base.products:sql.includes('product_links')?base.links:[]);
  assert.equal(out.result.operations[0].costKzt,160);const call=out.calls.find(x=>x.sql.includes('FROM warehouse_sales'));assert.deepEqual(call.args,['WB',START,START+DAY]);assert.ok(call.sql.includes('s.external_key=o.market'));assert.ok(call.sql.includes("->'order'->>'orderUid'"));assert.ok(out.calls.every(x=>/^SELECT /.test(x.sql)));
});


function expandUnit(f,group){
 const body={innerHTML:''},details={open:true,dataset:{unitKey:group.key},querySelector:()=>body};
 f.listeners.get('toggle')({target:details});return {body,details};
}
async function invokeHistory(query,respond){
 const handler=reportsRouter.stack.find(x=>x.route?.path==='/wb-unit-history').route.stack[0].handle;
 const old=pool.query,calls=[];pool.query=async(sql,args)=>{calls.push({sql,args});return {rows:respond(sql,args)}};let status=200,result;
 try{await handler({query},{status(code){status=code;return this},json(x){result=x}},error=>{throw error})}finally{pool.query=old}
 return {status,result,calls};
}
test('unit history reads older refusal deliveries and resale by exact cabinet/sticker; daily totals remain scoped',async()=>{
 const old=START-20*DAY,rows=[row(1,'Логистика',{shkId:'57928048938',deliveryService:166.12},{rr_date:old}),row(2,'Логистика',{shkId:'57928048938',deliveryService:267.51},{rr_date:old}),row(3,'Продажа',{shkId:'57928048938',forPay:1395.4,retailPriceWithDisc:1850}),row(4,'Логистика',{shkId:'57928048938',deliveryService:120.34})];
 const out=await invokeHistory({market:'WB',shkId:'57928048938',nmId:'100',productId:'a'},sql=>sql.startsWith('SELECT *')?rows:sql.includes('warehouse_products')?base.products:sql.includes('product_links')?base.links:[]);
 assert.equal(out.status,200);assert.equal(out.result.scope,'unit-history');assert.equal(out.result.operations.length,4);assert.ok(Math.abs(out.result.operations.reduce((a,r)=>a+r.delivery,0)-553.97)<1e-8);
 const daily=build(rows);assert.equal(daily.rowCount,2);assert.equal(daily.totals[0].delivery,120.34);assert.equal(daily.totals[0].sellerRevenue,1850);
 assert.deepEqual(out.calls[0].args,['WB','57928048938']);assert.doesNotMatch(out.calls[0].sql,/rr_date >=|LIMIT 50001/);assert.ok(out.calls.every(x=>/^SELECT /.test(x.sql)));
});
test('history refuses malformed and ambiguous identities and oversized data rather than merging or truncating',async()=>{
 assert.equal((await invokeHistory({market:'Kaspi',shkId:'1',nmId:'100'},()=>{throw Error('query forbidden')})).status,400);
 assert.equal((await invokeHistory({market:'WB',shkId:'1 OR 1=1',nmId:'100'},()=>{throw Error('query forbidden')})).status,400);
 assert.equal((await invokeHistory({market:'WB',shkId:'1',nmId:'100'},sql=>sql.startsWith('SELECT *')?Array(5001).fill({}):[])).status,422);
 const data=[row(1,'Продажа',{shkId:'1',sku:'unknown',vendorCode:'first'}),row(2,'Продажа',{shkId:'1',sku:'unknown2',vendorCode:'second'})];
 assert.equal((await invokeHistory({market:'WB',shkId:'1',nmId:'100'},sql=>sql.startsWith('SELECT *')?data:[])).status,409);
});
test('history keeps nm/product collisions separate and recovers missing nm expenses only for one known sticker',async()=>{
 const rows=[row(1,'Продажа',{shkId:'1'}),row(2,'Логистика',{shkId:'1',sku:'',nmId:'',vendorCode:'',deliveryService:12},{nm_id:'',vendor_code:''}),row(3,'Продажа',{shkId:'1',sku:'barcode-b',nmId:'200'})];
 const out=await invokeHistory({market:'WB',shkId:'1',nmId:'100',productId:'a'},sql=>sql.startsWith('SELECT *')?rows:sql.includes('warehouse_products')?base.products:sql.includes('product_links')?base.links:[]);
 assert.equal(out.result.operations.length,1);assert.equal(out.result.operations[0].productId,'a');
 const one=await invokeHistory({market:'WB',shkId:'1',nmId:'100',productId:'a'},sql=>sql.startsWith('SELECT *')?rows.slice(0,2):sql.includes('warehouse_products')?base.products:sql.includes('product_links')?base.links:[]);
 assert.equal(one.result.operations.length,2);assert.equal(one.result.operations[1].nmId,'100');
});
test('expanding a sticker lazily loads full history, caches it, and preserves selected-date revenue',async()=>{
 const f=uiFixture(),period=build([row(3,'Продажа',{forPay:700,retailPriceWithDisc:1000}),row(4,'Логистика',{deliveryService:120})]),full=buildWbOperationAudit({...base,allDates:true,rows:[row(1,'Логистика',{deliveryService:166},{rr_date:START-20*DAY}),row(2,'Логистика',{deliveryService:267},{rr_date:START-20*DAY}),row(3,'Продажа',{forPay:700}),row(4,'Логистика',{deliveryService:120})]});
 const calls=[];f.context.apiJson=async url=>{calls.push(url);return url.includes('/wb-unit-history')?{ok:true,scope:'unit-history',market:'WB',shkId:'unit-a',nmId:'100',operations:full.operations,range:full.range}:{ok:true,...period}};
 f.context.window.openWbProductOperations('WB',1,{productId:'a'});await new Promise(r=>setImmediate(r));assert.equal(calls.length,1);
 const html=f.el.querySelector('[data-audit-body]').innerHTML;assert.ok(html.includes('Выручка за период'));assert.ok(html.includes('1 000 ₸'));const snapshot=JSON.stringify(f.context.window.fixture.active.data);
 const opened=expandUnit(f,period.units[0]);await new Promise(r=>setImmediate(r));assert.ok(opened.body.innerHTML.includes('553 ₸'));assert.ok(opened.body.innerHTML.includes('Загруженные операции ШК'));assert.equal(calls.length,2);assert.ok(!calls[1].includes('days='));assert.equal(JSON.stringify(f.context.window.fixture.active.data),snapshot);
 expandUnit(f,period.units[0]);await new Promise(r=>setImmediate(r));assert.equal(calls.length,2);
});
test('closed sheets cannot receive delayed sticker history and wrong stickers are rejected with retry',async()=>{
 const f=uiFixture(),data=build([row(1,'Продажа')]);let resolve;
 f.context.apiJson=async url=>url.includes('/wb-unit-history')?new Promise(r=>{resolve=r}):{ok:true,...data};f.context.window.openWbProductOperations('WB',1,{productId:'a'});await new Promise(r=>setImmediate(r));const opened=expandUnit(f,data.units[0]),loading=opened.body.innerHTML;f.close();resolve({ok:true,scope:'unit-history',market:'WB',shkId:'unit-a',nmId:'100',operations:data.operations,range:data.range});await new Promise(r=>setImmediate(r));assert.equal(opened.body.innerHTML,loading);
 const g=uiFixture();g.context.apiJson=async url=>url.includes('/wb-unit-history')?{ok:true,scope:'unit-history',market:'WB',shkId:'other',nmId:'100',operations:[],range:data.range}:{ok:true,...data};g.context.window.openWbProductOperations('WB',1,{productId:'a'});await new Promise(r=>setImmediate(r));const error=expandUnit(g,data.units[0]);await new Promise(r=>setImmediate(r));assert.ok(error.body.innerHTML.includes('Повторить'));assert.ok(error.body.innerHTML.includes('другому товару или ШК'));
});


test('user screenshot has one clear 957.33 profit before ads, negative expenses, no intermediate sale profit',()=>{
 const data=buildWbOperationAudit({...base,rows:[row(1,'Продажа',{retailPriceWithDisc:1857.26,retailAmount:1395.6,forPay:1297.02,acquiringFee:68.08,ppvzSalesCommission:26.29,vw:-24.84,vwNds:-3.98}),row(2,'Логистика',{deliveryService:164.76,bonusTypeName:'К клиенту при продаже'})],purchaseRows:[{productId:'a',qty:1,status:'received',landedUnitCost:174.92531647326632}]});
 const f=uiFixture(),full=f.context.window.fixture.historyHtml({...data,operations:data.operations}),visible=full.split('<details class="wb-audit-timeline">')[0];
 assert.ok(visible.includes('Прибыль после рекламы'));assert.ok(visible.includes('≈ 957,33 ₸'));assert.ok(visible.includes('+ 1 857,26 ₸'));assert.ok(visible.includes('Комиссия WB · с НДС'));assert.ok(visible.includes('-492,16 ₸'));assert.ok(visible.includes('Эквайринг'));assert.ok(visible.includes('-68,08 ₸'));assert.ok(visible.includes('-164,76 ₸'));assert.ok(visible.includes('-174,93 ₸'));
 assert.equal((visible.match(/Комиссия WB/g)||[]).length,1);assert.equal((visible.match(/Эквайринг/g)||[]).length,1);assert.ok(!visible.includes('1 297,02'));assert.ok(!visible.includes('26,29'));assert.ok(!visible.includes('Вознаграждение'));
 const expected=1857.26-492.16-68.08-164.76-data.operations[0].costKzt;
 assert.ok(Math.abs(expected-(data.operations.reduce((s,r)=>s+r.beforeAdsAndCost,0)-data.operations[0].costKzt))<1e-8);assert.equal(expected.toFixed(2),'957.33');
 assert.equal((visible.match(/Логистика/g)||[]).length,1);assert.equal((full.match(/Прибыль после рекламы/g)||[]).length,1);assert.ok(!full.includes('1 122,09'));assert.ok(!full.includes('1 132,26'));assert.ok(!visible.includes('Хранение и приёмка'));assert.ok(!visible.includes('Поля WB'));assert.ok(!full.match(/<details[^>]*\sopen[ >]/));
});
test('compact unit waterfall separates every nonzero fee and compensation without double counting payout',()=>{
 const data=buildWbOperationAudit({...base,rows:[row(1,'Продажа',{retailPriceWithDisc:2000,forPay:1400,acquiringFee:40}),row(2,'Логистика',{deliveryService:100,rebillLogisticCost:25,paidStorage:5,paidAcceptance:7,penalty:11,deduction:13,additionalPayment:17}),row(3,'Компенсация',{forPay:19})],saleCosts:[{productId:'a',srid:'order-a',qty:1,cost:200}]});
 const html=uiFixture().context.window.fixture.unitSummaryHtml(data.operations);
 for(const [label,value] of [['Комиссия WB · с НДС','-560'],['Эквайринг','-40'],['Логистика · весь путь','-100'],['Перевыставленная логистика','-25'],['Хранение','-5'],['Приёмка','-7'],['Штрафы','-11'],['Удержания','-13'],['Доплаты','+ 17'],['Прочие выплаты WB','+ 19']]){
  const match=html.match(new RegExp('<span class="grow muted">'+label+'</span><b>([^<]+)</b>'));assert.ok(match,label);assert.equal(match[1],value+' ₸');assert.equal(html.split(label).length-1,1);
 }
 const expected=2000-560-40-100-25-5-7-11-13+17+19-200;
 assert.equal(expected,1075);assert.equal(data.operations.reduce((s,r)=>s+r.beforeAdsAndCost-(r.costKzt||0),0),expected);assert.ok(html.includes('1 075 ₸'));assert.ok(!html.includes('После комиссии WB'));assert.ok(!html.includes('1 400 ₸'));
});
test('sale returns restore commission and acquiring separately, retaining zero omission and negative fee corrections',()=>{
 const data=buildWbOperationAudit({...base,rows:[row(1,'Возврат',{retailPriceWithDisc:1000,forPay:700,acquiringFee:30}),row(2,'Логистика',{deliveryService:100})],saleCosts:[{productId:'a',srid:'order-a',qty:1,cost:100}]});
 const html=uiFixture().context.window.fixture.unitSummaryHtml(data.operations);
 assert.ok(html.includes('-1 000 ₸'));assert.ok(html.includes('Комиссия WB · с НДС</span><b>+ 270 ₸'));assert.ok(html.includes('Эквайринг</span><b>+ 30 ₸'));assert.ok(html.includes('-700 ₸'));assert.ok(!html.includes('Хранение'));assert.ok(!html.includes('Приёмка'));assert.ok(!html.includes('Штрафы'));assert.ok(!html.includes('Удержания'));
 const corrected=buildWbOperationAudit({...base,rows:[row(3,'Продажа',{retailPriceWithDisc:1000,forPay:1020,acquiringFee:-5})],saleCosts:[{productId:'a',srid:'order-a',qty:1,cost:100}]});
 const summary=uiFixture().context.window.fixture.unitSummaryHtml(corrected.operations);assert.ok(summary.includes('Комиссия WB · с НДС</span><b>+ 15 ₸'));assert.ok(summary.includes('Эквайринг</span><b>+ 5 ₸'));assert.ok(summary.includes('920 ₸'));
});
test('history distinguishes spending from actual transport refund; does not force every movement negative',()=>{
 const data=buildWbOperationAudit({...base,rows:[row(1,'Продажа',{forPay:500}),row(2,'Логистика',{deliveryService:100}),row(3,'Логистика',{deliveryService:-20,bonusTypeName:'Сторно доставки'})],saleCosts:[{productId:'a',srid:'order-a',qty:1,cost:100}]});
 const f=uiFixture(),summary=f.context.window.fixture.unitSummaryHtml(data.operations),refund=f.context.window.fixture.operationHtml(data.operations[2]);
 assert.ok(summary.includes('320 ₸'));assert.ok(summary.includes('-80 ₸'));assert.ok(refund.includes('+ 20 ₸'));assert.ok(refund.includes('Возврат / доплата'));assert.ok(!refund.includes('Прибыль'));assert.ok(refund.includes('<details class="wb-audit-fields">'));
});
test('unknown cost and foreign currency keep the prominent profit unknown, before-sale fees do not claim a realized profit',()=>{
 const f=uiFixture(),missing=build([row(1,'Продажа',{forPay:700})]).operations;
 const unknown=f.context.window.fixture.unitSummaryHtml(missing);assert.ok(unknown.includes('Прибыль после рекламы'));assert.ok(unknown.includes('>—</b>'));assert.ok(unknown.includes('Не хватает себестоимости'));
 const delivery=build([row(2,'Логистика',{deliveryService:120})]).operations;
 const pending=f.context.window.fixture.unitSummaryHtml(delivery);assert.ok(pending.includes('Результат до продажи'));assert.ok(pending.includes('-120 ₸'));assert.ok(!pending.includes('Прибыль после рекламы'));
});
test('unattributed advertising keeps unit profit unknown without mutating source data',()=>{
 const data=buildWbOperationAudit({...base,rows:[row(1,'Продажа',{forPay:500})],saleCosts:[{productId:'a',srid:'order-a',qty:1,cost:100}],adRows:[{nmIds:['100'],amount:200,currency:'KZT'}]});
 const before=JSON.stringify(data),html=uiFixture().context.window.fixture.historyHtml(data);assert.equal(JSON.stringify(data),before);assert.ok(html.includes('>—</b>'));assert.ok(html.includes('Не хватает связи с заказом'));assert.ok(!html.includes('Реклама учитывается по товару'));assert.ok(!html.includes('Чистая прибыль'));
});

test('period metrics stay scoped and tomorrow sale cannot admit an expense-only sticker today',async()=>{
 const rows=[row(1,'Логистика',{shkId:'58490824571',rebillLogisticCost:7.19}),row(2,'Продажа',{shkId:'58490824571',retailPriceWithDisc:1687.05,forPay:1089.48},{rr_date:START+DAY}),row(3,'Логистика',{shkId:'58490824571',deliveryService:162.68,rebillLogisticCost:10.73},{rr_date:START+DAY})],options={...base,rows,purchaseRows:[{productId:'a',qty:1,status:'received',landedUnitCost:174.92531647326632}]};
 const period=buildWbOperationAudit(options),full=buildWbOperationAudit({...options,allDates:true}),f=uiFixture();
 f.context.apiJson=async url=>url.includes('/wb-unit-history')?{ok:true,scope:'unit-history',market:'WB',shkId:'58490824571',nmId:'100',productId:'a',operations:full.operations,range:full.range}:{ok:true,...period};
 f.context.window.openWbProductOperations('WB',1,{productId:'a'});await new Promise(r=>setImmediate(r));
 const summary=f.context.window.fixture.periodMetricsHtml(period.operations);
 assert.ok(summary.includes('wb-audit-period'));assert.ok(summary.includes('Выручка за период</span><b>0 ₸'));assert.ok(summary.includes('Прибыль за период · после рекламы'));assert.ok(summary.includes('-7,19 ₸'));assert.ok(!summary.includes('733,95'));
 const body=f.el.querySelector('[data-audit-body]').innerHTML;
 assert.ok(body.includes('Нет продаж товара за выбранный период'));assert.ok(!body.includes('data-unit-key'));assert.ok(!body.includes('58490824571'));
 const history=f.context.window.fixture.historyHtml(full);assert.ok(history.includes('Прибыль после рекламы · весь путь'));assert.ok(history.includes('733,95 ₸'));
});
test('period sticker list keeps sales and their expenses, hides expense/return/ad-only stickers, preserves other views',async()=>{
 const rows=[row(1,'Продажа',{shkId:'sold',srid:'sold-order',retailPriceWithDisc:1000,forPay:700}),
  row(2,'Логистика',{shkId:'sold',srid:'sold-order',deliveryService:120}),
  row(3,'Логистика',{shkId:'expense-only',srid:'expense-order',deliveryService:90}),
  row(4,'Возврат',{shkId:'return-only',srid:'return-order',retailPriceWithDisc:1000,forPay:700}),
  row(5,'Продажа',{shkId:'sold-and-returned',srid:'returned-order',retailPriceWithDisc:1000,forPay:700}),
  row(6,'Возврат',{shkId:'sold-and-returned',srid:'returned-order',retailPriceWithDisc:1000,forPay:700}),
  row(7,'Продажа',{shkId:'other-product',srid:'other-order',sku:'barcode-b',retailPriceWithDisc:1000,forPay:700})];
 const data=buildWbOperationAudit({...base,rows,saleCosts:[{productId:'a',srid:'sold-order',qty:1,cost:200}]});
 // An allocated ad alone is another operation, never proof of a sale.
 data.operations.push({...data.operations[0],rrdId:'ad-only',kind:'advertising',shkId:'ad-only',saleQty:0,sellerRevenue:0,forPay:0,beforeAdsAndCost:0,orderAdvertising:20});
 data.units.push({key:'ad-only',shkId:'ad-only',rows:['ad-only']});
 const before=JSON.stringify(data),f=uiFixture();f.context.apiJson=async()=>({ok:true,...data});
 f.context.window.openWbProductOperations('WB',1,{productId:'a'});await new Promise(r=>setImmediate(r));
 const ctx=f.context.window.fixture.active,body=f.el.querySelector('[data-audit-body]').innerHTML;
 assert.ok(body.includes('ШК sold ·'));assert.ok(body.includes('2 оп. за период'));assert.ok(body.includes('380 ₸'));
 assert.ok(body.includes('ШК sold-and-returned'));assert.ok(body.includes('Выручка за период</span><b>0 ₸'));
 for(const hidden of ['expense-only','return-only','ad-only','other-product'])assert.ok(!body.includes('ШК '+hidden));
 assert.equal((body.match(/data-unit-key=/g)||[]).length,2);assert.equal(JSON.stringify(data),before);
 ctx.mode='orders';f.context.window.fixture.draw(ctx);
 const orders=f.el.querySelector('[data-audit-body]').innerHTML;assert.ok(orders.includes('expense-order'));assert.ok(orders.includes('return-order'));
 assert.equal(JSON.stringify(data),before);
});
test('sticker sale filter precedes pagination and recomputes on custom period changes using WB event dates',async()=>{
 const rows=Array.from({length:25},(_,i)=>row(i+1,'Логистика',{shkId:'fee-'+i,srid:'fee-'+i,deliveryService:12}));
 rows.push(...Array.from({length:21},(_,i)=>row(i+101,'Продажа',{shkId:'sale-'+i,srid:'sale-'+i,retailPriceWithDisc:1000})));
 // Posting day is outside the period; the actual sale event is inside it.
 rows.push(row(200,'Продажа',{shkId:'event-sale',srid:'event-sale',saleDt:'2026-10-01T12:00:00',retailPriceWithDisc:1000},{rr_date:START+3*DAY,sale_date:Date.parse('2026-10-01T12:00:00+03:00')}));
 // Posting day is inside the period; the sale event is outside it.
 rows.push(row(201,'Продажа',{shkId:'old-sale',srid:'old-sale',saleDt:'2026-09-30T12:00:00',retailPriceWithDisc:1000},{sale_date:Date.parse('2026-09-30T12:00:00+03:00')}));
 const data=build(rows),f=uiFixture();f.context.apiJson=async()=>({ok:true,...data});
 f.context.window.openWbProductOperations('WB',0,{productId:'a'});await new Promise(r=>setImmediate(r));
 let ctx=f.context.window.fixture.active,body=f.el.querySelector('[data-audit-body]').innerHTML;
 assert.equal((body.match(/data-unit-key=/g)||[]).length,20);assert.ok(!body.includes('ШК fee-'));assert.ok(!body.includes('old-sale'));
 assert.ok(f.el.querySelector('[data-audit-pager]').innerHTML.includes('22 поз. · 1 / 2'));
 ctx.page=2;f.context.window.fixture.draw(ctx);body=f.el.querySelector('[data-audit-body]').innerHTML;
 assert.equal((body.match(/data-unit-key=/g)||[]).length,2);assert.ok(body.includes('event-sale'));
 const next=buildWbOperationAudit({...base,rows:[row(300,'Логистика',{shkId:'event-sale',deliveryService:10},{rr_date:START+DAY})],since:START+DAY,until:START+2*DAY});
 f.context.apiJson=async()=>({ok:true,...next});f.context.openWbOperationAudit=f.context.window.openWbOperationAudit;
 f.el.querySelector('[data-audit-from]').value='2026-10-02';f.el.querySelector('[data-audit-to]').value='2026-10-02';
 f.listeners.get('click')({target:{closest:()=>({dataset:{auditAction:'range'}})}});await new Promise(r=>setImmediate(r));
 ctx=f.context.window.fixture.active;assert.equal(ctx.product,'p:a');assert.equal(ctx.page,1);
 assert.ok(f.el.querySelector('[data-audit-body]').innerHTML.includes('Нет продаж товара за выбранный период'));
 assert.equal(f.el.querySelector('[data-audit-pager]').innerHTML,'');
});
test('period profit uses known cost once, preserves unknown/foreign amounts and never allocates product ads',()=>{
 const f=uiFixture(),known=buildWbOperationAudit({...base,rows:[row(1,'Продажа',{retailPriceWithDisc:1000,forPay:700}),row(2,'Логистика',{deliveryService:100})],saleCosts:[{productId:'a',srid:'order-a',qty:1,cost:200}],adRows:[{nmIds:['100'],currency:'KZT',amount:99}]});
 const snapshot=JSON.stringify(known),html=f.context.window.fixture.periodMetricsHtml(known.operations);assert.ok(html.includes('1 000 ₸'));assert.ok(html.includes('>—</b>'));assert.ok(!html.includes('301 ₸'));assert.equal(JSON.stringify(known),snapshot);
 const missing=f.context.window.fixture.periodMetricsHtml(build([row(3,'Продажа',{retailPriceWithDisc:1000,forPay:700})]).operations);assert.ok(missing.includes('>—</b>'));assert.ok(!missing.includes('700 ₸'));
 const foreign=f.context.window.fixture.periodMetricsHtml(buildWbOperationAudit({...base,rows:[row(4,'Продажа',{currency:'RUB',forPay:700})],saleCosts:[{productId:'a',srid:'order-a',qty:1,cost:200}]}).operations);assert.ok(foreign.includes('>—</b>'));assert.ok(!foreign.includes('500'));
});
test('already linked expense recovers missing nm from exact sticker peer or cabinet product identity without changing source',()=>{
 const rows=[row(1,'Логистика',{shkId:'58542540931',nmId:'',rebillLogisticCost:12},{nm_id:''}),row(2,'Продажа',{shkId:'58542540931',nmId:'100',forPay:700})],snapshot=JSON.stringify(rows);
 const data=build(rows);assert.equal(data.operations[0].productId,'a');assert.equal(data.operations[0].nmId,'100');assert.equal(data.units.length,1);assert.equal(JSON.stringify(rows),snapshot);
 const catalog=buildWbOperationAudit({...base,rows:rows.slice(0,1),products:[{id:'a',payload:{wbIdentity:{nmId:'123'},wb2Identity:{nmId:'456'}}}]});assert.equal(catalog.operations[0].nmId,'123');
 const second=buildWbOperationAudit({...base,market:'WB2',links:[{market:'WB2',sku:'barcode-a',productId:'a'}],rows:[{...rows[0],market:'WB2'}],products:[{id:'a',payload:{wbIdentity:{nmId:'123'},wb2Identity:{nmId:'456'}}}]});assert.equal(second.operations[0].nmId,'456');
});
test('history opens missing-nm expense via exact product, keeps known expense if no card identity exists, and remains read-only',async()=>{
 const expense=row(1,'Логистика',{shkId:'58542540931',nmId:'',rebillLogisticCost:12},{nm_id:''}),sale=row(2,'Продажа',{shkId:'58542540931',forPay:700});
 for(const rows of [[expense,sale],[expense]]){
  const out=await invokeHistory({market:'WB',shkId:'58542540931',productId:'a'},sql=>sql.startsWith('SELECT *')?rows:sql.includes('warehouse_products')?base.products:sql.includes('product_links')?base.links:[]);
  assert.equal(out.status,200);assert.equal(out.result.operations.length,rows.length);assert.equal(out.result.nmId,rows.length===2?'100':'');assert.ok(out.result.operations.every(r=>r.productId==='a'));assert.ok(out.calls.every(x=>/^SELECT /.test(x.sql)));assert.deepEqual(out.calls[0].args,['WB','58542540931']);
 }
 assert.equal((await invokeHistory({market:'WB',shkId:'58542540931'},()=>{throw Error('query forbidden')})).status,400);
});
test('missing-nm history refuses multiple cards for one sticker instead of merging them or deleting the expense',async()=>{
 const rows=[row(1,'Логистика',{shkId:'58542540931',nmId:'',rebillLogisticCost:12},{nm_id:''}),row(2,'Продажа',{shkId:'58542540931',nmId:'100'}),row(3,'Продажа',{shkId:'58542540931',nmId:'200'})];
 const data=build(rows);assert.equal(data.operations[0].nmId,'');assert.equal(data.rowCount,3);
 const out=await invokeHistory({market:'WB',shkId:'58542540931',productId:'a'},sql=>sql.startsWith('SELECT *')?rows:sql.includes('warehouse_products')?base.products:sql.includes('product_links')?base.links:[]);assert.equal(out.status,409);assert.ok(out.result.error.includes('Неоднозначная'));assert.ok(out.calls.every(x=>/^SELECT /.test(x.sql)));
});
test('UI opens a linked sticker without requiring first-row nmId, accepts canonical identity and rejects a wrong product',async()=>{
 const period=build([row(1,'Логистика',{shkId:'58542540931',nmId:'',rebillLogisticCost:12},{nm_id:''})]),full=build([row(1,'Логистика',{shkId:'58542540931',nmId:'',rebillLogisticCost:12},{nm_id:''}),row(2,'Продажа',{shkId:'58542540931',forPay:700})]);
 for(const wrong of [false,true]){
  const f=uiFixture(),calls=[];f.context.apiJson=async url=>{calls.push(url);return url.includes('/wb-unit-history')?{ok:true,scope:'unit-history',market:'WB',shkId:'58542540931',nmId:'100',productId:wrong?'b':'a',operations:full.operations,range:full.range}:{ok:true,...period}};
  f.context.window.openWbProductOperations('WB',1,{productId:'a'});await new Promise(r=>setImmediate(r));const opened=expandUnit(f,period.units[0]);await new Promise(r=>setImmediate(r));
  assert.equal(calls.length,2);assert.ok(calls[1].includes('productId=a'));assert.ok(!calls[1].includes('nmId='));assert.ok(!opened.body.innerHTML.includes('Нет точного nmId'));
  assert.ok(opened.body.innerHTML.includes(wrong?'Повторить':'История движения'));
 }
});

function placedOrders(count=25){return Array.from({length:count},(_,i)=>({market:'WB',order_id:String(i+1),entry_id:String(i+1),creation_date:START+8*3600000,sku:'item',qty:1,state:i%2?'cancelled':'new',raw_json:JSON.stringify({order:{orderUid:'placed-'+i,nmId:'100',skus:['barcode-a']},identity:{nmId:'100',barcode:'barcode-a',article:'item'}})}))}
function orderAdExample(extra={}){
 const rows=[row(801,'Продажа',{srid:'placed-0',shkId:'58347387921',orderDt:'2026-10-01T06:00:00Z',retailPriceWithDisc:1857.26,retailAmount:1395.6,forPay:1297.02,acquiringFee:68.08},{rr_date:START+DAY}),row(802,'Логистика',{srid:'placed-0',shkId:'58347387921',orderDt:'2026-10-01T06:00:00Z',deliveryService:164.76},{rr_date:START+DAY})];
 const ads=[{day:'2026-10-01',nmIds:['100'],amount:5000,currency:'KZT'}];
 return {...base,rows,orderFinanceRows:rows,orderRows:placedOrders(),allocationAdRows:ads,adRows:ads,purchaseRows:[{productId:'a',qty:1,status:'received',landedUnitCost:174.92531647326632}],...extra};
}
test('order-date allocation charges 200 once on order day, including unreceived orders; whole sticker profit becomes 757.33',()=>{
 const source=orderAdExample(),before=JSON.stringify(source),period=buildWbOperationAudit(source),full=buildWbOperationAudit({...source,allDates:true});
 assert.equal(period.totals[0].sellerRevenue,0);assert.equal(period.totals[0].saleQty,0);assert.equal(period.totals[0].orderAdvertising,5000);assert.equal(period.operations.filter(r=>r.kind==='advertising').length,25);assert.equal(period.coverage.unitRows,1);
 assert.equal(period.advertisingAllocation[0].qty,25);assert.equal(period.advertisingAllocation[0].perUnit,200);
 const unitRows=full.operations.filter(r=>r.shkId==='58347387921'),html=uiFixture().context.window.fixture.historyHtml({...full,operations:unitRows});
 assert.equal(unitRows.filter(r=>r.kind==='advertising').length,1);assert.equal(unitRows.find(r=>r.kind==='advertising').orderAdvertising,200);assert.ok(html.includes('≈ 757,33 ₸'));assert.ok(html.includes('Реклама · по дате заказа'));assert.ok(html.includes('-200 ₸'));assert.ok(html.includes('5 000 ₸ / 25 заказанных шт. × 1 шт.'));assert.ok(!html.includes('Реклама учитывается по товару'));
 const daily=uiFixture().context.window.fixture.periodMetricsHtml(period.operations.filter(r=>r.shkId==='58347387921'));assert.ok(daily.includes('0 ₸'));assert.ok(daily.includes('-200 ₸'));assert.equal(JSON.stringify(source),before);
});
test('later sale/return never repeats order-day advertising; report deduction WB Promotion is not another allocation',()=>{
 const options=orderAdExample(),original=options.rows;
 const saleDay=buildWbOperationAudit({...options,since:START+DAY,until:START+2*DAY,adRows:[]});assert.equal(saleDay.operations.filter(r=>r.kind==='advertising').length,0);assert.equal(saleDay.totals[0].orderAdvertising,0);assert.equal(saleDay.totals[0].saleQty,1);
 const promo=row(803,'Удержание',{srid:'placed-0',shkId:'58347387921',orderDt:'2026-10-01T06:00:00Z',deduction:5000,bonusTypeName:'WB Продвижение'},{rr_date:START+DAY});
 const full=buildWbOperationAudit({...options,rows:[...original,promo],orderFinanceRows:[...original,promo],allDates:true});const unit=full.operations.filter(r=>r.shkId==='58347387921');assert.equal(unit.reduce((s,r)=>s+(r.orderAdvertising||0),0),200);assert.equal(full.advertisingAllocation[0].qty,25);
 assert.ok(uiFixture().context.window.fixture.unitSummaryHtml(unit).includes('757,33 ₸'));assert.ok(full.reconciliation.every(r=>r.balanced));
});
test('unit-history endpoint uses all cached orders for the denominator rather than assigning the whole day budget to one sticker',async()=>{
 const options=orderAdExample(),out=await invokeHistory({market:'WB',shkId:'58347387921',nmId:'100',productId:'a'},sql=>sql.startsWith('SELECT *')?options.rows:sql.startsWith('SELECT f.*')?options.rows:sql.includes('FROM marketplace_order_lines o')?options.orderRows:sql.includes('FROM wb_ad_costs')?options.allocationAdRows:sql.includes('warehouse_products')?base.products:sql.includes('product_links')?base.links:sql.includes('warehouse_purchases')?options.purchaseRows:[]);
 assert.equal(out.status,200);assert.equal(out.result.operations.filter(r=>r.kind==='advertising').length,1);assert.equal(out.result.operations.find(r=>r.kind==='advertising').orderAdvertising,200);assert.ok(out.result.operations.every(r=>r.shkId==='58347387921'));assert.ok(out.calls.every(x=>/^SELECT /.test(x.sql)));assert.equal(out.calls.find(x=>x.sql.includes('FROM marketplace_order_lines o')).args[0],'WB');assert.ok(!out.calls.find(x=>x.sql.includes('FROM marketplace_order_lines o')).sql.includes("state='"));
 const ads=out.calls.find(x=>x.sql.includes('FROM wb_ad_costs'));assert.ok(ads.args[1].includes('2026-10-01'));assert.ok(out.result.range.since<=START);
});
test('unknown ad currency and ambiguous physical sticker do not produce a guessed net profit',()=>{
 const options=orderAdExample(),unknown=buildWbOperationAudit({...options,allocationAdRows:[{day:'2026-10-01',nmIds:['100'],amount:5000,currency:'UNKNOWN'}],allDates:true});const unit=unknown.operations.filter(r=>r.shkId==='58347387921'),html=uiFixture().context.window.fixture.unitSummaryHtml(unit);assert.ok(html.includes('>—</b>'));assert.ok(html.includes('Валюты рекламы'));
 const other={...options.rows[0],rrd_id:'999',raw_json:JSON.stringify({...JSON.parse(options.rows[0].raw_json),shkId:'99999999'})},ambiguous=buildWbOperationAudit({...options,rows:[...options.rows,other],orderFinanceRows:[...options.rows,other],allDates:true});const piece=ambiguous.operations.filter(r=>r.shkId==='58347387921');assert.ok(piece.some(r=>r.adUnknown));assert.ok(uiFixture().context.window.fixture.unitSummaryHtml(piece).includes('Не хватает связи с заказом'));assert.equal(ambiguous.operations.find(r=>r.kind==='advertising'&&r.srid==='placed-0').shkId,'');
});
