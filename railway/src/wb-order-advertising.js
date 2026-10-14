// Management allocation only. These entries are never written to the WB/warehouse ledger.
const num = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const key = (...parts) => JSON.stringify(parts);
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
  const totals = new Map(),budgets = new Map(),byDay = new Map();
  for (const order of placed.values()) {
    const k=key(order.productId,order.orderDay);totals.set(k,num(totals.get(k))+num(order.qty));
    const list=byDay.get(k)||[];list.push(order);byDay.set(k,list);
  }
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
  const entries=[],allocation=[];
  for (const b of budgets.values()) {
    const qty=num(totals.get(key(b.productId,b.day))),eligible=b.amount!==0?byDay.get(key(b.productId,b.day))||[]:[];
    let assigned=0,assignedQty=0;
    for (let i=0;i<eligible.length;i++) {
      const order=eligible[i],nextQty=assignedQty+num(order.qty),amount=(Math.round(b.amount*100*nextQty/qty)-Math.round(b.amount*100*assignedQty/qty))/100;assigned+=amount;assignedQty=nextQty;
      const peers=identities.get(key(order.productId,order.srid)),identity=peers?.size===1?[...peers.values()][0]:null;
      entries.push({...order,shkId:identity?.shkId||'',nmId:identity?.nmId||order.nmId||'',barcode:identity?.barcode||order.barcode||'',
        currency:b.currency,amount,allocation:{day:b.day,budget:b.amount,dayQty:qty,qty:order.qty,source:'cached_orders',estimated:true}});
    }
    if (!days || days.includes(b.day)) allocation.push({...b,qty,perUnit:qty?b.amount/qty:null,allocated:assigned,unallocated:Math.abs(b.amount-assigned)<0.005?0:b.amount-assigned,
      reason:qty?'allocated':'no_orders',estimated:true});
  }
  return {entries,allocation,orders:[...placed.values()],conflicts:[...conflicts]};
}
