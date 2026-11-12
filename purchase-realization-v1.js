(function () {
  'use strict';
  let confirmed = {};
  let refreshAt = 0;
  let pendingRefresh = null;

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
      const group = groups.get(key) || { key, total: 0, sold: 0, profit: 0, cost: 0, received: false, complete: false, tracked: false, lines: [] };
      const received = purchase.status === 'received';
      const line = { total, received, sold: 0, profit: 0, cost: 0, financeKnown: true };
      group.total += total;
      group.received ||= received;
      group.tracked ||= purchase.purchaseRealizationTracked === true;
      group.lines.push(line);
      groups.set(key, group);
      lots.set(id, { purchase, line });
    }

    const seen = new Set();
    for (const sale of snapshot.sales || []) {
      const id = String(sale.externalKey || sale.id || '');
      const qty = quantity(sale.qty);
      const automatic = sale.purchaseRealizationTracked === true;
      if (!id || seen.has(id) || (!automatic && sale.channel !== 'Ручная') || !qty) continue;
      const returned = sale.returned || sale.cancelled || snapshot.settings?.wbReturnReceipts?.[id]
        || snapshot.settings?.kaspiReturnReceipts?.[sale.purchaseRealizationOrderId || id];
      if (returned && !automatic) continue;
      seen.add(id);
      const allocations = Array.isArray(sale.fifoLots) ? sale.fifoLots : [];
      if (allocations.reduce((sum, row) => sum + quantity(row.qty), 0) !== qty) continue;
      const result = automatic ? confirmed[sale.id] : null;
      const sold = returned ? 0 : automatic ? quantity(result?.sold) : qty;
      if (sold > qty || (sold > 0 && sold < qty && allocations.length !== 1)) continue;
      const moneyKnown = automatic
        ? result?.sold === sold && typeof result.proceeds === 'number' && Number.isFinite(result.proceeds)
        : knownMoney(sale.price) && knownMoney(sale.fee);
      for (const allocation of allocations) {
        const entry = lots.get(String(allocation.purchaseId || ''));
        const allocated = quantity(allocation.qty);
        const count = sold === qty ? allocated : sold;
        if (!entry || !entry.line.received || allocation.fallback || !allocated || String(entry.purchase.productId) !== String(sale.productId)) continue;
        if (automatic && !entry.purchase.purchaseRealizationTracked) continue;
        entry.line.sold += count;
        const ready = !quantity(sale.stockShortage) && moneyKnown && knownMoney(allocation.unitCost);
        entry.line.financeKnown &&= ready;
        if (ready) {
          const cost = count * Number(allocation.unitCost);
          entry.line.cost += cost;
          const proceeds = automatic ? result.proceeds * (allocated / qty) : count * (Number(sale.price) - Number(sale.fee));
          entry.line.profit += proceeds - cost;
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

  window.restorePurchaseRealizationReturn = function (externalKey, productId, qty) {
    const sale = (state.sales || []).find(row => row.purchaseRealizationTracked && row.externalKey === externalKey);
    if (!sale || String(sale.productId) !== String(productId) || Number(sale.qty) !== qty || !sale.fifoLots?.length) return false;
    const changes = new Map();
    let total = 0;
    for (const part of sale.fifoLots) {
      const lot = (state.purchases || []).find(row => String(row.id) === String(part.purchaseId));
      const count = quantity(part.qty);
      const remaining = (changes.get(lot) ?? Number(lot?.remainingQty)) + count;
      if (!lot?.purchaseRealizationTracked || lot.status !== 'received' || String(lot.productId) !== String(productId)
        || !count || !Number.isFinite(remaining) || remaining > Number(lot.qty)) return false;
      changes.set(lot, remaining);
      total += count;
    }
    if (total !== qty) return false;
    for (const [lot, remaining] of changes) lot.remainingQty = remaining;
    return true;
  };

  window.refreshPurchaseRealization = function () {
    if (pendingRefresh) return pendingRefresh;
    if (!(state.sales || []).some(sale => sale.purchaseRealizationTracked)
      || Date.now() - refreshAt < 120000) return Promise.resolve(false);
    refreshAt = Date.now();
    pendingRefresh = apiJson(MILLIONER_API + '/api/purchase-sale-results').then(payload => {
      const next = payload.results || {};
      const changed = JSON.stringify(next) !== JSON.stringify(confirmed);
      confirmed = next;
      if (changed && document.querySelector('.view.active')?.id === 'purchases') renderPurchases({ listOnly: true });
      return changed;
    }).catch(() => false).finally(() => { pendingRefresh = null; });
    return pendingRefresh;
  };

  window.purchaseRealizationLabel = function (row) {
    if (!row?.received) return '';
    if (row.complete) return 'Продано ' + row.total + ' из ' + row.total + ' шт. · Прибыль ' + fmt(row.profit);
    if (row.sold > 0) return (row.tracked ? 'Продано ' : 'Подтверждено ручных продаж ') + row.sold + ' из ' + row.total + ' шт.' + (row.sold === row.total ? ' · Нет полного расчёта прибыли' : '');
    if (row.tracked) return 'Выкупы с привязкой к партии пока не подтверждены';
    return 'Связь продаж с партией не подтверждена';
  };
})();
