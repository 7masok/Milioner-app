// Management allocation only. These entries are never written to the WB/warehouse ledger.
const num = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const key = (...parts) => JSON.stringify(parts);
function firstOrderDay(days, day) {
  let low = 0, high = days.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (days[middle] < day) low = middle + 1;
    else high = middle;
  }
  return days[low] || '';
}
export function wbOrderDay(value) {
  const source = String(value ?? '').trim();
  if (!source || /^1970-/.test(source)) return '';
  const timestamp = /^20\d{2}-\d{2}-\d{2}/.test(source)
    ? Date.parse(source + (/Z$|[+-]\d\d:\d\d$/.test(source) ? '' : source.length>10 ? '+03:00' : 'T00:00:00+03:00')) : Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp + 3 * 3600000).toISOString().slice(0, 10) : '';
}
export function allocateWbOrderAdvertising({market,orders=[],finance=[],advertising=[],days=null}) {
  const placed = new Map(), conflicts = new Set();
  for (const order of orders) {
    if (order.market && order.market !== market || !order.productId || !order.srid || !order.orderDay || num(order.qty) <= 0) continue;
    const k = key(order.productId,order.srid),old = placed.get(k);
    if(old?.source==='order_cache'&&order.source!=='order_cache')continue;
    if(old&&old.source!=='order_cache'&&order.source==='order_cache'){placed.set(k,{...order,cacheKeys:order.cacheKey?[order.cacheKey]:[]});conflicts.delete(k);continue;}
    if (old && old.orderDay !== order.orderDay) { conflicts.add(k); continue; }
    // A repeated report row is not another placed order. Cached order lines have priority.
    if (!old || order.source === 'order_cache' && old.source !== 'order_cache') placed.set(k,{...order,cacheKeys:order.cacheKey?[order.cacheKey]:[]});
    else if (order.source === 'order_cache' && order.cacheKey && !old.cacheKeys.includes(order.cacheKey)) {old.qty+=order.qty;old.cacheKeys.push(order.cacheKey);}
    else if (old.source !== 'order_cache') old.qty=Math.max(old.qty,order.qty);
  }
  for (const k of conflicts) placed.delete(k);
  const budgets = new Map(), byDay = new Map(), daysByProduct = new Map();
  for (const order of placed.values()) {
    const k = key(order.productId, order.orderDay);
    if (!byDay.has(k)) {
      byDay.set(k, { qty: 0, eligible: [] });
      const productDays = daysByProduct.get(order.productId) || [];
      productDays.push(order.orderDay);
      daysByProduct.set(order.productId, productDays);
    }
    const group = byDay.get(k);
    group.eligible.push(order);
    group.qty += num(order.qty);
  }
  for (const productDays of daysByProduct.values()) productDays.sort();
  for (const { eligible } of byDay.values()) eligible.sort((a, b) => a.srid.localeCompare(b.srid));
  for (const ad of advertising) {
    if (!ad.productId || !ad.day || ad.market && ad.market!==market) continue;
    const k=key(ad.productId,ad.day,ad.currency),b=budgets.get(k)||{productId:ad.productId,day:ad.day,currency:ad.currency,amount:0};
    b.amount+=num(ad.amount);budgets.set(k,b);
  }
  const identities=new Map();
  for (const row of finance) {
    if (!row.productId || !row.srid || !row.shkId) continue;
    const k=key(row.productId,row.srid),map=identities.get(k)||new Map();map.set(key(row.shkId,row.nmId),row);identities.set(k,map);
  }
  const entries = [], allocation = [], orderBudgets = new Map();
  const visibleDays = days && new Set(days);
  for (const b of budgets.values()) {
    const orderDay = firstOrderDay(daysByProduct.get(b.productId) || [], b.day);
    const orderKey = key(b.productId, orderDay);
    const { qty = 0, eligible } = byDay.get(orderKey) || {};
    const cents = Math.round(b.amount * 100);
    if (qty && cents) {
      const budgetKey = key(orderKey, b.currency);
      const budget = orderBudgets.get(budgetKey) || { orderDay, currency: b.currency, cents: 0, firstSpendDay: b.day, lastSpendDay: b.day, qty, eligible };
      budget.cents += cents;
      if (b.day < budget.firstSpendDay) budget.firstSpendDay = b.day;
      if (b.day > budget.lastSpendDay) budget.lastSpendDay = b.day;
      orderBudgets.set(budgetKey, budget);
    }
    if (!visibleDays || visibleDays.has(b.day)) allocation.push({ ...b, orderDay, qty, perUnit: qty ? b.amount / qty : null,
      allocated: qty ? cents / 100 : 0, unallocated: qty ? 0 : b.amount,
      reason: !qty ? 'no_orders' : orderDay === b.day ? 'allocated' : 'carried', estimated: true });
  }
  for (const budget of orderBudgets.values()) {
    if (!budget.cents) continue;
    const { orderDay, currency, cents, firstSpendDay, lastSpendDay, qty, eligible } = budget;
    let assignedQty = 0;
    for (const order of eligible) {
      const nextQty = assignedQty + num(order.qty);
      const amount = (Math.round(cents * nextQty / qty) - Math.round(cents * assignedQty / qty)) / 100;
      assignedQty = nextQty;
      const peers=identities.get(key(order.productId,order.srid)),identity=peers?.size===1?[...peers.values()][0]:null;
      entries.push({...order,shkId:identity?.shkId||'',nmId:identity?.nmId||order.nmId||'',barcode:identity?.barcode||order.barcode||'',
        currency, amount, allocation: { day: orderDay, firstSpendDay, lastSpendDay, budget: cents / 100, dayQty: qty, qty: order.qty, source: 'cached_orders', estimated: true } });
    }
  }
  return {entries,allocation,orders:[...placed.values()],conflicts:[...conflicts]};
}
