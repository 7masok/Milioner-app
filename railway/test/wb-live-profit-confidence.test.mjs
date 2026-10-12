import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const report = readFileSync(new URL('../../kaspi-report-v2.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const liveStats = report.slice(report.indexOf('function businessWbLiveStats('), report.indexOf('function resolvedWbReportStats('));
const line = (source, name) => source.split('\n').find(x => x.startsWith('function ' + name + '('));
function context(costInfo) {
  const elements = new Map(), window = {};
  // An available forecast must not be read for actual-day financial profit.
  Object.defineProperty(window, 'allMarketUnitProfit30', { get() { throw Error('forecast used as a financial fact'); } });
  const c = { window, document: { getElementById(id) { if (!elements.has(id)) elements.set(id, { innerHTML: '', textContent: '' }); return elements.get(id); } },
    reportConfidenceNote() {}, fmt: x => String(x) + ' ₸', reportPeriod: -1, wbLiveRealizedCostSummary: () => costInfo };
  vm.runInNewContext(liveStats + '\n' + line(report, 'resolvedWbReportStats') + '\n' + line(report, 'renderWbCompact'), c);
  return c;
}
for (const fixture of [{ market: 'WB2', revenue: 9330, qty: 38, cost: 6503, complete: true }, { market: 'WB', revenue: 13976, qty: 54, cost: 0, complete: false }]) {
  test(fixture.market + ' screenshot: live revenue remains visible, unsupported profit and zero expenses become unknown', () => {
    const c = context({ cost: fixture.cost, complete: fixture.complete });
    const model = { financeAvailable: false, revenue: 0, cost: 0, expenses: 0, ads: 0, products: [], profit: null },
      live = { buyoutSum: fixture.revenue, buyoutCount: fixture.qty, products: [{ qty: fixture.qty, productId: 'product' }] };
    const stats = c.resolvedWbReportStats(model, live, fixture.market, -1);
    assert.equal(stats.revenue, fixture.revenue); assert.equal(stats.qty, fixture.qty);
    assert.equal(stats.cost, fixture.complete ? fixture.cost : null); assert.equal(stats.fees, null); assert.equal(stats.profit, null);
    c.renderWbCompact(model, fixture.market, -1, live);
    assert.equal(c.document.getElementById('rRevenue').textContent, '≈ ' + fixture.revenue + ' ₸');
    assert.equal(c.document.getElementById('rFees').textContent, '—'); assert.equal(c.document.getElementById('rProfit').textContent, '—');
    assert.equal(c.document.getElementById('rCost').textContent, fixture.complete ? '≈ ' + fixture.cost + ' ₸' : '—');
    assert.ok(c.document.getElementById('mpReport').innerHTML.includes('расход —'));
  });
}
test('partially lagging financial data cannot supply confirmed profit for newer live buyouts', () => {
  const c = context({ cost: 600, complete: true });
  const view = c.resolvedWbReportStats({ financeAvailable: true, complete: true, revenue: 1000, cost: 300, expenses: 100, ads: 50, profit: 550, products: [{ saleQty: 1 }] },
    { buyoutSum: 2000, buyoutCount: 2, products: [{ qty: 2 }] }, 'WB', 1);
  assert.equal(view.useLive, true); assert.equal(view.profit, null); assert.equal(view.fees, null); assert.equal(view.ads, 50);
});
test('current financial report continues to provide known zero fees and actual profit', () => {
  const c = context({ cost: 600, complete: true });
  const view = c.resolvedWbReportStats({ financeAvailable: true, complete: true, revenue: 2000, cost: 600, expenses: 0, ads: 50, profit: 1350, products: [{ saleQty: 2 }] },
    { buyoutSum: 2000, buyoutCount: 2 }, 'WB', -1);
  assert.equal(view.useLive, false); assert.equal(view.fees, 0); assert.equal(view.profit, 1350);
});
test('daily cache without product rows cannot classify a positive quantity as zero complete FIFO', () => {
  const c = { wbLiveProductId: (_market, x) => x.productId, wbRealizedFifoCost: () => 100 };
  vm.runInNewContext(line(html, 'wbLiveRealizedCostSummary'), c);
  assert.equal(c.wbLiveRealizedCostSummary('WB', 1, { buyoutCount: 38, products: [] }).complete, false);
  assert.equal(c.wbLiveRealizedCostSummary('WB', 1, { buyoutCount: 2, products: [{ productId: 'p', qty: 1 }] }).complete, false);
  const all = c.wbLiveRealizedCostSummary('WB', 1, { buyoutCount: 1, products: [{ productId: 'p', qty: 1 }] });
  assert.equal(all.complete, true); assert.equal(all.cost, 100);
  c.wbRealizedFifoCost = () => 0;
  assert.equal(c.wbLiveRealizedCostSummary('WB', 1, { buyoutCount: 1, products: [{ productId: 'p', qty: 1 }] }).complete, false);
});
