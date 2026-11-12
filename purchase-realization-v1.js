(function () {
  'use strict';

  function quantity(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  function knownMoney(value) {
    return value != null && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0;
  }

  function summarize(snapshot) {
    const groups = new Map();
    const lots = new Map();
    for (const purchase of snapshot.purchases || []) {
      const id = String(purchase.id || '');
      const total = quantity(purchase.qty);
      if (!id || !total || purchase.returnAdjustment || purchase.inventoryAdjustment || purchase.opening) continue;
      const key = String(purchase.shipmentId || id);
      const group = groups.get(key) || { key, total: 0, sold: 0, profit: 0, cost: 0, received: false, complete: false, lines: [] };
      const received = purchase.status === 'received';
      const line = { total, received, sold: 0, profit: 0, cost: 0, financeKnown: true };
      group.total += total;
      group.received ||= received;
      group.lines.push(line);
      groups.set(key, group);
      lots.set(id, { purchase, line });
    }

    const seen = new Set();
    for (const sale of snapshot.sales || []) {
      const id = String(sale.externalKey || sale.id || '');
      const sold = quantity(sale.qty);
      if (!id || seen.has(id) || sale.channel !== 'Ручная' || !sold) continue;
      if (sale.returned || sale.cancelled || snapshot.settings?.kaspiReturnReceipts?.[id] || snapshot.settings?.wbReturnReceipts?.[id]) continue;
      seen.add(id);
      const allocations = Array.isArray(sale.fifoLots) ? sale.fifoLots : [];
      if (allocations.reduce((sum, row) => sum + quantity(row.qty), 0) !== sold) continue;
      for (const allocation of allocations) {
        const entry = lots.get(String(allocation.purchaseId || ''));
        const count = quantity(allocation.qty);
        if (!entry || !entry.line.received || allocation.fallback || !count || String(entry.purchase.productId) !== String(sale.productId)) continue;
        entry.line.sold += count;
        const ready = !quantity(sale.stockShortage) && knownMoney(sale.price) && knownMoney(sale.fee) && knownMoney(allocation.unitCost);
        entry.line.financeKnown &&= ready;
        if (ready) {
          const cost = count * Number(allocation.unitCost);
          entry.line.cost += cost;
          entry.line.profit += count * (Number(sale.price) - Number(sale.fee)) - cost;
        }
      }
    }
    for (const group of groups.values()) {
      group.sold = group.lines.reduce((sum, line) => sum + Math.min(line.sold, line.total), 0);
      group.complete = group.lines.every(line => line.received && line.sold === line.total && line.financeKnown);
      group.profit = group.complete ? group.lines.reduce((sum, line) => sum + line.profit, 0) : null;
      group.cost = group.complete ? group.lines.reduce((sum, line) => sum + line.cost, 0) : null;
    }
    return groups;
  }

  window.purchaseRealizationSummary = function (snapshot = state) {
    return summarize(snapshot);
  };

  window.purchaseRealizationLabel = function (row) {
    if (!row?.received) return '';
    if (row.complete) return 'Продано ' + row.total + ' из ' + row.total + ' шт. · Прибыль ' + fmt(row.profit);
    if (row.sold > 0) return 'Подтверждено ручных продаж ' + row.sold + ' из ' + row.total + ' шт.' + (row.sold === row.total ? ' · Нет полного расчёта прибыли' : '');
    return 'Связь продаж с партией не подтверждена';
  };
})();
