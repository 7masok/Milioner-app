import { buildWbOperationAudit } from './wb-operation-audit.js';

const groupKey = (vendor, nm) => JSON.stringify([String(vendor || ''), String(nm || '')]);

// Keep the report's financial period and every expense. Only reconcile cost and
// explain charges on pieces that did not sell in that period; never write FIFO.
export function reconcileWbReportProducts({ market, reportRows, financeRows, links, products, purchaseRows, saleCosts }) {
  const audit = buildWbOperationAudit({ market, rows: financeRows, links, products, purchaseRows, saleCosts, allDates: true });
  const originals = new Map(financeRows.map(row => [String(row.rrd_id), row]));
  const groups = new Map();
  for (const operation of audit.operations) {
    const original = originals.get(operation.rrdId);
    if (!original) continue;
    const key = groupKey(original.vendor_code, original.nm_id), rows = groups.get(key) || [];
    rows.push(operation); groups.set(key, rows);
  }
  return reportRows.map(row => {
    const operations = groups.get(groupKey(row.vendorCode, row.nmId)) || [];
    if (!operations.length && !(Math.abs(Number(row.saleQty)||0)+Math.abs(Number(row.returnQty)||0)+Math.abs(Number(row.qty)||0))) return { ...row, realizedCostKzt: 0, realizedCostEstimated: false, otherUnitExpenses: 0, otherUnits: [] };
    // Do not attach another size/product's saved cost to an ambiguous legacy link.
    if (!operations.length || operations.some(r => String(r.productId || '') !== String(row.productId || ''))) {
      return { ...row, realizedCostKzt: null, realizedCostEstimated: false, otherUnitExpenses: null, otherUnits: [] };
    }
    const realized = operations.filter(r => r.saleQty || r.returnQty);
    const known = realized.every(r => r.currency === 'KZT' && r.costKzt !== null && r.costKzt !== undefined);
    const sold = new Set(operations.filter(r => r.saleQty > 0).map(r => r.unitKey));
    const units = new Map();
    for (const r of operations) {
      if (!r.unitKey || sold.has(r.unitKey) || r.saleQty || r.returnQty) continue;
      const key = JSON.stringify([r.unitKey, r.currency]);
      const unit = units.get(key) || { shkId: r.shkId, expense: 0, currency: r.currency };
      unit.expense -= r.beforeAdsAndCost; units.set(key, unit);
    }
    const otherUnits = [...units.values()].filter(x => Math.abs(x.expense) >= 0.005);
    return { ...row, realizedCostKzt: known ? realized.reduce((sum, r) => sum + r.costKzt, 0) : null,
      realizedCostEstimated: realized.some(r => r.costEstimated),
      otherUnitExpenses: otherUnits.every(x => x.currency === 'KZT') ? otherUnits.reduce((sum, x) => sum + x.expense, 0) : null,
      otherUnits };
  });
}
