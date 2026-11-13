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
    const results = apiJson(MILLIONER_API + '/api/purchase-sale-results');
    const hasKaspi = (state.sales || []).some(sale => sale.purchaseRealizationTracked && sale.channel === 'Kaspi');
    const settlements = hasKaspi
      ? apiJson(MILLIONER_API + '/api/purchases/kaspi-pay').catch(() => null)
      : Promise.resolve(null);
    pendingRefresh = Promise.all([results, settlements]).then(([payload, kaspi]) => {
      const next = { ...payload.results, ...kaspi?.results };
      const changed = JSON.stringify(next) !== JSON.stringify(confirmed);
      confirmed = next;
      if (changed && document.querySelector('.view.active')?.id === 'purchases') renderPurchases({ listOnly: true });
      return changed;
    }).catch(() => false).finally(() => { pendingRefresh = null; });
    return pendingRefresh;
  };

  async function importKaspiSettlements(file) {
    const xlsx = await loadXlsxLibrary();
    const book = xlsx.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
    const lines = [];
    for (const name of book.SheetNames) {
      const grid = xlsx.utils.sheet_to_json(book.Sheets[name], { header: 1, defval: '' });
      const header = grid.findIndex(row => {
        const cells = row.map(adsColumn);
        return cells.includes('номер заказа id rrn') && cells.includes('тип операции');
      });
      if (header < 0) continue;
      const labels = grid[header].map(adsColumn);
      const col = prefix => labels.findIndex(label => label.startsWith(prefix));
      const ids = { orderId: col('номер заказа id rrn'), date: col('дата операции'), time: col('время'), operation: col('тип операции'),
        detail: col('детали покупки'), amount: col('сумма операции'), commission: col('комиссия за операции т'),
        cardCommission: col('комиссия за операции по карте'), paymentGuarantee: col('комиссия за обеспечение платежа'),
        kaspiPay: col('комиссия kaspi pay'), kaspiTravel: col('комиссия kaspi travel'),
        bonusProduct: col('бонусы на товар'), bonusReview: col('бонусы за отзыв'), delivery: col('стоимость услуги за kaspi доставку') };
      if (['date','amount','commission','kaspiPay','delivery'].some(key => ids[key] < 0)) continue;
      for (const row of grid.slice(header+1)) {
        const get = key => row[ids[key]];
        const operation = String(get('operation') || '').trim();
        const orderId = String(get('orderId') || '').trim();
        const date = kaspiAdsIsoDate(get('date'));
        if (!orderId || !date || !/^(покупка|возврат)$/i.test(operation)) continue;
        const line = { operation, orderId, date, time: String(get('time') || ''), detail: String(get('detail') || '') };
        for (const key of ['amount','commission','cardCommission','paymentGuarantee','kaspiPay','kaspiTravel','bonusProduct','bonusReview','delivery']) {
          const clean = String(get(key) ?? '').replace(/[\s₸]/g,'').replace(',','.').replace(/−/g,'-');
          line[key] = clean === '' && key === 'amount' ? null : Number(clean);
        }
        if (Object.values(line).some(value => value === null || typeof value === 'number' && !Number.isFinite(value))) continue;
        lines.push(line);
      }
    }
    if (!lines.length) throw Error('В файле не найдены операции Kaspi Pay с комиссиями.');
    const response = await fetch(MILLIONER_API + '/api/purchases/kaspi-pay', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lines })
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw Error(result.error || 'Не удалось сохранить отчёт.');
    refreshAt = 0;
    await window.refreshPurchaseRealization();
    return result.count;
  }

  window.chooseKaspiPurchaseReport = function () {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.xlsx,.xls';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try { alert('Принято операций Kaspi Pay · ' + await importKaspiSettlements(file)); }
      catch(error) { alert(error.message); }
    };
    input.click();
  };

  window.purchaseRealizationLabel = function (row) {
    if (!row?.received) return '';
    if (row.complete) return 'Продано ' + row.total + ' из ' + row.total + ' шт. · Прибыль ' + fmt(row.profit);
    if (row.sold > 0) return (row.tracked ? 'Продано ' : 'Подтверждено ручных продаж ') + row.sold + ' из ' + row.total + ' шт.' + (row.sold === row.total ? ' · Нет полного расчёта прибыли' : '');
    if (row.tracked) return 'Выкупы с привязкой к партии пока не подтверждены';
    return 'Связь продаж с партией не подтверждена';
  };
})();
