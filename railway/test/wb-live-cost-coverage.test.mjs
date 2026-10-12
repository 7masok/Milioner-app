import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const report = readFileSync(new URL('../../kaspi-report-v2.js', import.meta.url), 'utf8');
const line = (source, name) => source.split('\n').find(x => x.startsWith('function ' + name + '('));
const business = report.slice(report.indexOf('function businessWbLiveStats('), report.indexOf('function resolvedWbReportStats('));
const details = report.slice(report.indexOf('function wbLiveCostCoverageNote('), report.indexOf('function renderWbCompact('));
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const live = { buyoutCount: 54, buyoutSum: 13976, products: [{ productId: 'known', qty: 52, vendorCode: 'known' }, { productId: '', qty: 1, vendorCode: 'unlinked' }, { productId: 'missing-cost', qty: 1, vendorCode: 'missing-cost' }] };
function fixture() {
  const nodes = new Map(), c = { window: {}, console, reportPeriod: -1, esc, fmt: x => String(x) + ' ₸', productNameById: (id, fallback) => fallback,
    wbLiveProductId: (_market, x) => x.productId || '', wbRealizedFifoCost: (pid, _market, _days, qty) => pid === 'missing-cost' ? 0 : qty * 100,
    reportConfidenceNote() {}, ensureWbLiveOverview: async () => live, showSheet() { nodes.set('wbLiveCostDetails', { innerHTML: '' }); },
    document: { getElementById(id) { if (id === 'wbLiveCostDetails') return nodes.get(id) || null; if (!nodes.has(id)) nodes.set(id, { innerHTML: '', textContent: '' }); return nodes.get(id); } } };
  vm.runInNewContext(line(html, 'wbLiveRealizedCostSummary') + '\n' + business + '\n' + details + '\n' + line(report, 'resolvedWbReportStats') + '\n' + line(report, 'renderWbCompact'), c);
  return { c, nodes };
}
test('52 of 54 known units retain their subtotal and explain the two different missing-cost causes', () => {
  const { c } = fixture(), data = c.wbLiveRealizedCostSummary('WB', -1, live);
  assert.equal(data.cost, 5200); assert.equal(data.complete, false); assert.equal(data.knownUnits, 52); assert.equal(data.totalUnits, 54); assert.equal(data.unknownUnits, 2);
  assert.deepEqual(Array.from(data.rows, x => x.reason), ['known', 'link_missing', 'cost_missing']);
  const stats = c.resolvedWbReportStats({ financeAvailable: false, products: [] }, live, 'WB', -1);
  assert.equal(stats.cost, 5200); assert.equal(stats.costComplete, false); assert.equal(stats.profit, null); assert.equal(stats.fees, null);
  c.renderWbCompact({ financeAvailable: false, products: [] }, 'WB', -1, live);
  assert.equal(c.document.getElementById('rCost').textContent, '≈ 5200 ₸');
  assert.ok(c.document.getElementById('mpReport').innerHTML.includes('52 из 54 шт.'));
  assert.ok(c.document.getElementById('mpReport').innerHTML.includes('Разобрать'));
  assert.equal(c.document.getElementById('rProfit').textContent, '—');
});
test('entirely unknown products keep a dash instead of inventing a cost from other goods', () => {
  const { c } = fixture(), data = { buyoutCount: 2, products: [live.products[1], live.products[2]] };
  const stats = c.businessWbLiveStats({}, data, 'WB', -1);
  assert.equal(stats.cost, null); assert.equal(stats.costKnownUnits, 0); assert.equal(stats.costUnknownUnits, 2);
});
test('complete linked products retain their cost without a partial warning', () => {
  const { c } = fixture(), data = { buyoutCount: 3, products: [{ productId: 'known', qty: 3 }] };
  const stats = c.businessWbLiveStats({}, data, 'WB2', -1);
  assert.equal(stats.cost, 300); assert.equal(stats.costComplete, true); assert.equal(c.wbLiveCostCoverageNote({ ...stats, useLive: true }, 'WB2', -1), '');
});
test('return signs are preserved while coverage counts both known and unknown units', () => {
  const { c } = fixture(), data = c.wbLiveRealizedCostSummary('WB', -1, { buyoutCount: 3, products: [{ productId: 'known', qty: 5 }, { productId: 'known', qty: -1 }, { productId: '', qty: -1 }] });
  assert.equal(data.cost, 400); assert.equal(data.knownUnits, 6); assert.equal(data.totalUnits, 7); assert.equal(data.unknownUnits, 1); assert.equal(data.complete, false);
});
test('a missing product breakdown is listed explicitly rather than priced by store averages', () => {
  const { c } = fixture(), data = c.wbLiveRealizedCostSummary('WB', -1, { buyoutCount: 5, products: [{ productId: 'known', qty: 2 }] });
  assert.equal(data.cost, 200); assert.equal(data.unknownUnits, 3); assert.equal(data.rows[1].reason, 'breakdown_missing'); assert.equal(data.rows[1].cost, null);
});
test('cost detail shows missing rows and safe manual links without writing business data', async () => {
  const { c, nodes } = fixture(); await c.window.openWbLiveCostDetails('WB', -1);
  const body = nodes.get('wbLiveCostDetails').innerHTML;
  assert.ok(body.includes('Известная часть себестоимости')); assert.ok(body.includes('52 из 54 шт.')); assert.ok(body.includes('Привязать товар')); assert.ok(body.includes('Открыть товар'));
  assert.ok(body.includes('Рассчитанные товары · 1')); assert.ok(body.includes('Не привязан к товару склада'));
  assert.equal(/\b(save|pushWarehouseToServer|persistWarehouse|attachMarketplaceSku)\s*\(/.test(details), false);
  const unsafe = c.wbLiveCostRowHtml({ name: '<img src=x>', sku: "a' onclick='hack", productId: '', qty: 1, cost: null, reason: 'link_missing' }, 'WB', -1);
  assert.ok(!unsafe.includes('<img')); assert.ok(unsafe.includes('&lt;img')); assert.ok(unsafe.includes('&#39;'));
});
test('closing the cost diagnostic while its data loads cannot reopen or replace another modal', async () => {
  const { c, nodes } = fixture(); let resolve;
  c.ensureWbLiveOverview = () => new Promise(r => { resolve = r; });
  const pending = c.window.openWbLiveCostDetails('WB', -1); nodes.delete('wbLiveCostDetails'); resolve(live); await pending;
  assert.equal(nodes.has('wbLiveCostDetails'), false);
});
test('the shared business summary retains known WB cost while marking the total cost as partial', async () => {
  const { c } = fixture();
  Object.assign(c, { businessMarketplaceSummaryCache: new Map(), explicitRangeBounds: () => null,
    loadKaspiOrders: async () => ({}), buildModel: () => ({ revenue: 1000, cost: 100, fees: 100, ads: 0, qty: 1, unknownRevenue: 0 }), reportProfitView: () => ({ value: 800, estimated: false }),
    loadWbModel: async market => ({ market, financeAvailable: false, complete: false, products: [] }), loadOzonSummary: async () => ({ sales: 0, qty: 0, cost: 0, fees: 0, ads: 0, profit: 0 }) });
  vm.runInNewContext(report.slice(report.indexOf('function businessWbFinanceStats('), report.indexOf('function businessWbLiveStats(')) + '\n'
    + report.slice(report.indexOf('window.loadBusinessMarketplaceSummary='), report.indexOf('const productPeriodStatsCache=')), c);
  const data = await c.window.loadBusinessMarketplaceSummary(-1);
  assert.equal(data.sources.WB.cost, 5200); assert.equal(data.sources.WB.costComplete, false);
  assert.equal(data.cost, 10500); assert.equal(data.partial.cost, true); assert.equal(data.partial.profit, true);
  assert.equal(data.sources.WB.profit, null);
});
