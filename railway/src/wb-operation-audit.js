import { wbFinancePeriodDate } from './wb-finance-period.js';
import { allocateWbOrderAdvertising, wbOrderDay } from './wb-order-advertising.js';
// Read-only audit of the persisted WB report. No warehouse/FIFO writes or upstream calls.
const text = value => String(value ?? '').trim();
const articleKey = value => text(value).toLocaleLowerCase('ru-RU');
const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const id = value => { const s = text(value); return s === '0' ? '' : s; };
function object(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try { const parsed = JSON.parse(value || '{}'); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; }
}
function field(raw, names, fallback) {
  for (const name of names) if (raw[name] !== undefined && raw[name] !== null && text(raw[name]) !== '') return raw[name];
  return fallback;
}
const moneyFields = ['revenue', 'sellerRevenue', 'forPay', 'commission', 'commissionVat', 'acquiring', 'delivery', 'rebill', 'storage', 'acceptance', 'deduction', 'promotionDeduction', 'penalty', 'additionalPayment', 'settlement', 'beforeAdsAndCost', 'legacyBeforeAdsAndCost', 'orderAdvertising'];
function totals() { return { rows: 0, saleQty: 0, returnQty: 0, ...Object.fromEntries(moneyFields.map(key => [key, 0])) }; }
function add(target, row) {
  target.rows++; target.saleQty += row.saleQty; target.returnQty += row.returnQty;
  for (const key of moneyFields) target[key] += number(row[key]);
}
function normalized(row, market) {
  const raw = object(row.raw_json), docType = text(field(raw, ['docTypeName', 'doc_type_name'], row.doc_type));
  const operation = text(field(raw, ['sellerOperName', 'supplierOperName', 'supplier_oper_name'], row.operation));
  const kind = (operation || docType).toLocaleLowerCase('ru-RU');
  // A logistics row can also have docType=Продажа and quantity=1: it is not another buyout.
  const sale = kind === 'продажа', returned = kind === 'возврат', returnDocument = returned || docType.toLocaleLowerCase('ru-RU') === 'возврат';
  const signed = value => returnDocument ? -Math.abs(number(value)) : number(value);
  const currency = text(field(raw, ['currency', 'currencyCode', 'currency_code'], '')).toUpperCase() || 'UNKNOWN';
  const qty = Math.abs(number(field(raw, ['quantity', 'qty'], row.qty)));
  const amount = (names, column) => {
    const value = field(raw, names, row[column]);
    if (value !== undefined && value !== null && text(value) !== '' && !Number.isFinite(Number(value))) throw new Error('Некорректная сумма WB: строка ' + id(row.rrd_id) + ', ' + column);
    return number(value);
  };
  const bonus = text(field(raw, ['bonusTypeName', 'bonus_type_name'], '')).toLocaleLowerCase('ru-RU');
  const allDeduction = amount(['deduction'], 'deduction'), promotionDeduction = bonus.includes('wb продвижение') ? allDeduction : 0;
  const commissionRaw = field(raw, ['ppvzSalesCommission', 'ppvz_sales_commission'], null);
  if (commissionRaw !== null && !Number.isFinite(Number(commissionRaw))) throw new Error('Некорректная комиссия WB: строка ' + id(row.rrd_id));
  const optional = names => { const v = field(raw, names, null); if (v === null) return null; if (!Number.isFinite(Number(v))) throw new Error('Некорректное поле WB: строка ' + id(row.rrd_id)); return Number(v); };
  const result = {
    market, rrdId: id(row.rrd_id || field(raw, ['rrdId', 'rrd_id'], '')), reportId: id(row.report_id),
    date: number(row.rr_date), saleDate: number(row.sale_date), orderDay: wbOrderDay(field(raw,['orderDt','order_dt','orderDate'],'')), operation: operation || docType || 'Операция WB', docType,
    kind: sale ? 'sale' : returned ? 'return' : /логист|достав/i.test(operation) ? 'logistics' : 'other',
    srid: id(field(raw, ['srid', 'orderUid', 'order_uid'], '')),
    shkId: id(field(raw, ['shkId', 'shk_id'], '')),
    barcode: id(field(raw, ['sku', 'barcode'], '')),
    nmId: id(field(raw, ['nmId', 'nm_id'], row.nm_id)), vendorCode: text(field(raw, ['vendorCode', 'saName', 'sa_name'], row.vendor_code)),
    title: text(field(raw, ['title', 'subjectName', 'subject_name'], row.title)), size: text(field(raw, ['techSize', 'ts_name'], '')),
    currency, saleQty: sale ? qty : 0, returnQty: returned ? qty : 0,
    revenue: signed(amount(['retailAmount', 'retail_amount'], 'retail_amount')),
    forPay: signed(amount(['forPay', 'ppvzForPay', 'ppvz_for_pay'], 'for_pay')),
    commission: commissionRaw === null ? null : signed(commissionRaw),
    wbReward: field(raw, ['vw', 'ppvzVw', 'ppvz_vw'], null) === null ? null : signed(optional(['vw', 'ppvzVw', 'ppvz_vw'])),
    commissionVat: field(raw, ['vwNds', 'ppvzVwNds', 'ppvz_vw_nds'], null) === null ? null : signed(optional(['vwNds', 'ppvzVwNds', 'ppvz_vw_nds'])),
    commissionPercent: optional(['commissionPercent', 'commission_percent']), wbDiscountPercent: optional(['spp', 'ppvz_spp_prc']),
    sellerUnitPrice: optional(['retailPriceWithDisc', 'retail_price_withdisc_rub']), logisticsType: text(field(raw, ['bonusTypeName', 'bonus_type_name'], '')),
    acquiring: signed(amount(['acquiringFee', 'acquiring_fee'], 'acquiring_fee')),
    delivery: amount(['deliveryService', 'deliveryRub', 'delivery_rub'], 'delivery_service'),
    rebill: amount(['rebillLogisticCost', 'rebill_logistic_cost'], 'rebill_logistic_cost'),
    storage: amount(['paidStorage', 'storageFee', 'storage', 'storage_fee'], 'paid_storage'),
    acceptance: amount(['paidAcceptance', 'acceptance', 'acceptanceFee', 'acceptance_fee'], 'paid_acceptance'),
    deduction: allDeduction - promotionDeduction, promotionDeduction,
    penalty: amount(['penalty'], 'penalty'), additionalPayment: amount(['additionalPayment', 'additional_payment'], 'additional_payment')
  };
  result.sellerRevenue = sale || returned ? result.sellerUnitPrice !== null ? (sale ? qty : -qty) * Math.abs(result.sellerUnitPrice) : result.revenue : 0;
  const charges = result.delivery + result.rebill + result.storage + result.acceptance + result.deduction + result.penalty;
  // forPay already includes the commission/payment fees. The columns remain visible for audit only.
  result.beforeAdsAndCost = result.forPay - charges + result.additionalPayment;
  result.settlement = result.beforeAdsAndCost - promotionDeduction;
  const legacyDeduction = bonus.includes('wb продвижение') ? 0 : number(row.deduction);
  result.legacyBeforeAdsAndCost = number(row.for_pay) - number(row.acquiring_fee) - number(row.delivery_service) - number(row.rebill_logistic_cost)
    - number(row.paid_storage) - number(row.paid_acceptance) - legacyDeduction - number(row.penalty) + number(row.additional_payment);
  return result;
}
function indexes(links, products, market) {
  const bySku = new Map(), byArticle = new Map(), catalog = new Map(), nmProducts = new Map();
  for (const source of products) { const p = { ...object(source.payload), ...source }; catalog.set(text(p.id), p); }
  for (const link of links) {
    const sku = id(link.sku), pid = text(link.productId ?? link.product_id);
    if (!sku || !pid) continue;
    const set = bySku.get(sku) || new Set(); set.add(pid); bySku.set(sku, set);
    const articles = byArticle.get(articleKey(sku)) || new Set(); articles.add(pid); byArticle.set(articleKey(sku), articles);
  }
  const field = market === 'WB2' ? 'wb2' : 'wb';
  for (const p of catalog.values()) {
    const identity = p[field + 'Identity'] || (p.wbVariant?.market === market ? p.wbVariant : {});
    const parent = p.variantGroupId ? catalog.get(text(p.variantGroupId)) : null;
    const nm = id(identity.nmId || (parent?.variantMarket === market ? parent.variantNmId : ''));
    if (!nm) continue;
    const set = nmProducts.get(nm) || new Set(); set.add(text(p.id)); nmProducts.set(nm, set);
  }
  return { bySku, byArticle, catalog, nmProducts };
}
function linkProduct(row, index) {
  // A barcode is more specific than the common nmId/article of a card with sizes.
  const precise = row.barcode && index.bySku.get(row.barcode);
  if (precise?.size === 1) return { productId: [...precise][0], linkSource: 'barcode' };
  if (precise?.size > 1) return { productId: '', linkSource: 'ambiguous' };
  // Finance changes seller-article casing; normal report links already ignore that difference.
  // Keep all matching IDs so conflicting links/sizes remain ambiguous instead of picking the first.
  const candidates = new Set([...(index.byArticle.get(articleKey(row.vendorCode)) || []), ...(index.bySku.get(row.nmId) || [])]);
  // A shared card link must not silently collapse barcode-specific variants.
  const knownSizes = index.nmProducts.get(row.nmId);
  if (knownSizes?.size > 1 || row.barcode && knownSizes?.size === 1 && !candidates.has([...knownSizes][0])) return { productId: '', linkSource: 'ambiguous' };
  return candidates.size === 1 ? { productId: [...candidates][0], linkSource: 'article' } : { productId: '', linkSource: candidates.size > 1 ? 'ambiguous' : 'none' };
}
function adNmIds(value) { const values = Array.isArray(value) ? value : (() => { try { return JSON.parse(value || '[]'); } catch { return []; } })(); return Array.isArray(values) ? [...new Set(values.map(id).filter(Boolean))] : []; }

// Saved order costs are read, never consumed again. A fallback is explicitly an estimate,
// not FIFO for a physical sticker, and does not allocate campaign spend to that sticker.
function costResolver(index, purchaseRows, saleCosts, market) {
  const purchases = new Map(), saved = new Map();
  const nonnegative = v => v !== null && v !== undefined && text(v) !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null;
  for (const source of purchaseRows) {
    const p = { ...object(source.payload), ...source }, qty = number(p.qty), pid = text(p.productId ?? p.product_id);
    if (!pid || qty <= 0 || p.relocation || !['received', 'at_warehouse'].includes(p.status)) continue;
    const landed = nonnegative(p.landedUnitCost), buy = nonnegative(p.buyTotal), unit = nonnegative(p.unitCost);
    const cost = landed ?? (buy !== null ? buy / qty : unit);
    const t = purchases.get(pid) || { qty: 0, value: 0, missing: false };
    t.qty += qty; t.missing ||= cost === null;
    t.value += qty * (cost ?? 0) + (landed === null ? Math.max(0, number(p.delivery)) : 0); purchases.set(pid, t);
  }
  for (const source of saleCosts) {
    if (source.market && source.market !== market) continue;
    const key = JSON.stringify([text(source.productId ?? source.product_id), id(source.srid)]);
    const entries = saved.get(key) || []; entries.push(source); saved.set(key, entries);
  }
  function estimate(pid, seen = new Set()) {
    if (seen.has(pid)) return null;
    const p = index.catalog.get(pid); if (!p) return null;
    const t = purchases.get(pid);
    if (p.kind === 'bundle' && Array.isArray(p.components) && p.components.length) {
      const next = new Set(seen); next.add(pid); let value = 0;
      for (const part of p.components) { const cost = estimate(text(part.productId), next), qty = number(part.qty); if (!cost || qty <= 0) return null; value += cost.value * qty; }
      return { value, source: 'purchase_average' };
    }
    if (t?.qty > 0 && !t.missing) return { value: t.value / t.qty, source: 'purchase_average' };
    const cost = nonnegative(p.cost); return cost > 0 ? { value: cost, source: 'product_cost' } : null;
  }
  return row => {
    const qty = row.saleQty - row.returnQty;
    if (!qty) return;
    const entries = row.productId && row.srid ? saved.get(JSON.stringify([row.productId, row.srid])) : null;
    const s = entries?.length === 1 ? entries[0] : null, value = s && nonnegative(s.cost);
    const known = value !== null && value !== undefined && number(s.qty) >= Math.abs(qty) && number(s.stockShortage) === 0;
    const cost = known ? { value, source: 'saved_order' } : estimate(row.productId);
    row.costKzt = cost ? cost.value * qty : null;
    row.costSource = cost?.source || 'unknown'; row.costEstimated = Boolean(cost && !known);
    row.afterCostBeforeAds = row.currency === 'KZT' && cost ? row.beforeAdsAndCost - row.costKzt : null;
  };
}
export function buildWbOperationAudit({ market, rows = [], links = [], products = [], adRows = [], purchaseRows = [], saleCosts = [], since = 0, until = Infinity, allDates = false, orderRows = [], orderFinanceRows = [], allocationAdRows = null, allocationDays = null }) {
  if (!['WB', 'WB2'].includes(market)) throw new Error('market must be WB or WB2');
  const index = indexes(links.filter(x => !x.market || x.market === market), products, market), unique = new Map();
  let duplicateRows = 0;
  for (const row of rows) {
    if (row.market && row.market !== market || !allDates && (wbFinancePeriodDate(row) < since || wbFinancePeriodDate(row) >= until)) continue;
    const key = id(row.rrd_id);
    if (!key) throw new Error('WB report row has no rrdId');
    if (unique.has(key)) { duplicateRows++; if (number(row.updated_at) < number(unique.get(key).updated_at)) continue; }
    unique.set(key, row);
  }
  const operations = [...unique.values()].map(row => normalized(row, market)).sort((a, b) => a.date - b.date || a.rrdId.localeCompare(b.rrdId));
  for (const row of operations) {
    const precise = index.bySku.get(row.barcode);
    if (!row.nmId || precise?.size !== 1) continue;
    const set = index.nmProducts.get(row.nmId) || new Set(); set.add([...precise][0]); index.nmProducts.set(row.nmId, set);
  }
  const byOrder = new Map(), byUnit = new Map();
  for (const row of operations) {
    Object.assign(row, linkProduct(row, index));
    if (!row.productId) continue;
    for (const [key, map] of [[row.srid, byOrder], [row.shkId, byUnit]]) {
      if (!key) continue;
      const peers = map.get(key) || []; peers.push(row); map.set(key, peers);
    }
  }
  for (const row of operations) {
    if (row.productId) continue;
    for (const [peers, source] of [[byOrder.get(row.srid), 'order'], [byUnit.get(row.shkId), 'unit']]) {
      if (!peers?.length) continue;
      const ids = new Set(peers.map(x => x.productId));
      if (ids.size !== 1 || peers.some(x => row.nmId && x.nmId && row.nmId !== x.nmId || row.barcode && x.barcode && row.barcode !== x.barcode)) continue;
      row.productId = [...ids][0]; row.linkSource = source;
      const nmIds = [...new Set(peers.map(x => x.nmId).filter(Boolean))];
      if (!row.nmId && nmIds.length === 1) row.nmId = nmIds[0];
      break;
    }
  }
  const productNmIds = new Map();
  for (const [nm, ids] of index.nmProducts) for (const pid of ids) {
    const values = productNmIds.get(pid) || new Set(); values.add(nm); productNmIds.set(pid, values);
  }
  // A barcode-linked expense can still omit nmId. Exact sticker peers take
  // precedence; otherwise require a single saved card identity in this cabinet.
  for (const row of operations) {
    if (row.nmId || !row.productId) continue;
    const peers = byUnit.get(row.shkId) || [];
    if (peers.some(x => x.productId !== row.productId || row.barcode && x.barcode && row.barcode !== x.barcode)) continue;
    const peerIds = new Set(peers.map(x => x.nmId).filter(Boolean));
    if (peerIds.size > 1) continue;
    const knownIds = peerIds.size ? peerIds : productNmIds.get(row.productId) || new Set();
    if (knownIds.size === 1 && /^\d{1,20}$/.test([...knownIds][0])) row.nmId = [...knownIds][0];
  }
  const financeOrders=orderFinanceRows.length?buildWbOperationAudit({market,rows:orderFinanceRows,links,products,allDates:true}).operations:operations;
  const cachedOrders=orderRows.filter(o=>!o.market||o.market===market).map(o=>{
    const raw=object(o.raw_json),identity=raw.identity||{},order=raw.order||raw;
    const r={nmId:id(identity.nmId||order.nmId),barcode:id(identity.barcode||order.skus?.[0]),vendorCode:text(identity.article||order.article||o.sku)};
    return {...r,...linkProduct(r,index),market,srid:id(order.orderUid||raw.orderUid||raw.srid||o.order_id||o.orderId),
      cacheKey:JSON.stringify([o.order_id||o.orderId,o.entry_id||o.entryId]),orderDay:wbOrderDay(o.creation_date||o.creationDate||order.createdAt),qty:number(o.qty),source:'order_cache'};
  });
  const identityOrders=new Map();
  for(const r of [...financeOrders,...cachedOrders]) {
    if(!r.productId||!r.nmId)continue;
    const ids=index.nmProducts.get(r.nmId)||new Set();ids.add(r.productId);index.nmProducts.set(r.nmId,ids);
    const k=JSON.stringify([r.productId,r.srid]),values=identityOrders.get(k)||new Set();values.add(r.nmId);identityOrders.set(k,values);
  }
  for(const r of operations){const ids=identityOrders.get(JSON.stringify([r.productId,r.srid]));if(!r.nmId&&ids?.size===1&&/^\d{1,20}$/.test([...ids][0]))r.nmId=[...ids][0];}
  const groups = new Map(), currencies = new Map(), orders = new Map(), units = new Map();
  const resolveCost = costResolver(index, purchaseRows, saleCosts, market);
  const register = row => {
    row.productKey = row.productId ? 'p:' + row.productId : 'u:' + JSON.stringify([row.nmId, row.vendorCode, row.barcode]);
    const p = index.catalog.get(row.productId);
    row.productName = p?.name || row.title || row.vendorCode || ('WB ' + (row.nmId || 'без товара'));
    resolveCost(row);
    row.orderKey = row.srid ? 'order:' + JSON.stringify([row.productKey, row.srid]) : 'row:' + row.rrdId;
    // Never use the shared product barcode as the identity of a physical unit.
    row.unitKey = row.shkId ? 'unit:' + JSON.stringify([row.productKey, row.nmId, row.shkId]) : '';
    const group = groups.get(row.productKey) || { key: row.productKey, productId: row.productId, name: row.productName, vendorCode: row.vendorCode,
      nmId: row.nmId, barcode: row.barcode, linked: Boolean(row.productId), rows: [], totals: new Map(), advertising: [] };
    group.rows.push(row.rrdId);
    const total = group.totals.get(row.currency) || totals(); add(total, row); group.totals.set(row.currency, total); groups.set(row.productKey, group);
    const global = currencies.get(row.currency) || totals(); add(global, row); currencies.set(row.currency, global);
    const order = orders.get(row.orderKey) || { key: row.orderKey, productKey: row.productKey, srid: row.srid, rows: [] };
    order.rows.push(row.rrdId); orders.set(row.orderKey, order);
    if (row.unitKey) { const unit = units.get(row.unitKey) || { key: row.unitKey, productKey: row.productKey, shkId: row.shkId, rows: [], srids: new Set() }; unit.rows.push(row.rrdId); if (row.srid) unit.srids.add(row.srid); units.set(row.unitKey, unit); }
  };
  operations.forEach(register);
  const normalizeAds = source => source.filter(row => !row.market || row.market === market).map((row, n) => {
    if (!Number.isFinite(Number(row.amount))) throw new Error('Некорректный расход рекламы WB');
    const nmIds = adNmIds(row.nmIds ?? row.nm_ids), candidates = new Set(); let missing = !nmIds.length;
    for (const nm of nmIds) {
      const variants = index.nmProducts.get(nm), direct = index.bySku.get(nm);
      // Campaign money is not allocated to one size just because it was the latest sale.
      const set = variants?.size ? variants : direct;
      if (!set?.size) missing = true; else for (const pid of set) candidates.add(pid);
    }
    const productId = !missing && candidates.size === 1 ? [...candidates][0] : '';
    const adRaw = object(row.raw_json);
    const result = { key: 'ad:' + n, day: text(row.day), advertId: text(row.advertId ?? row.advert_id), campaign: text(row.campaign),
      amount: number(row.amount), currency: text(field(adRaw, ['currency', 'currencyCode', 'currency_code'], row.currency)).toUpperCase() || 'UNKNOWN', nmIds, productId,
      reason: productId ? 'linked' : candidates.size > 1 ? 'multiple_products' : 'unlinked' };
    return result;
  });
  const advertising = normalizeAds(adRows);
  for (const result of advertising) {
    if (result.productId) {
      const productId=result.productId;
      const key = 'p:' + productId, p = index.catalog.get(productId);
      const group = groups.get(key) || { key, productId, name: p?.name || 'Реклама WB', linked: true, rows: [], totals: new Map(), advertising: [] };
      group.advertising.push(result.key); groups.set(key, group);
    }
  }
  // Cost-only postings can carry the posting day as orderDt (for example
  // re-billed transport). They are expenses, not evidence of order placement.
  const ordersForAds=[...cachedOrders,...financeOrders.filter(r=>['sale','return','logistics'].includes(r.kind)).map(r=>({...r,qty:Math.max(1,r.saleQty||r.returnQty),source:'finance_order_date'}))];
  const allocationAds=allocationAdRows===null?advertising:normalizeAds(allocationAdRows);
  const allocation=allocateWbOrderAdvertising({market,orders:ordersForAds,finance:financeOrders,advertising:allocationAds,days:allocationDays});
  const placedOrders=new Map(allocation.orders.map(r=>[JSON.stringify([r.productId,r.srid]),r])),datedOrders=new Set(placedOrders.keys()),advertisedProducts=new Set(allocationAds.filter(a=>a.amount!==0&&a.productId).map(a=>a.productId));
  const operationOrders=new Map(),conflictingOrders=new Set(allocation.conflicts);
  for(const r of operations){const k=JSON.stringify([r.productId,r.srid]),peers=operationOrders.get(k)||[];peers.push(r);operationOrders.set(k,peers);r.orderDay=placedOrders.get(k)?.orderDay||'';if(advertisedProducts.has(r.productId)&&(!datedOrders.has(k)||conflictingOrders.has(k)))r.adUnknown=true;}
  for (const entry of allocation.entries) {
    const date=Date.parse(entry.orderDay+'T00:00:00+05:00');
    if (!allDates&&(date<since||date>=until)) continue;
    if(!entry.shkId&&entry.amount!==0)for(const r of operationOrders.get(JSON.stringify([entry.productId,entry.srid]))||[])r.adUnknown=true;
    const r={...entry,rrdId:'ad-order:'+JSON.stringify([entry.productId,entry.srid,entry.orderDay,entry.currency]),reportId:'',date,saleDate:0,
      operation:'Реклама заказа',kind:'advertising',docType:'',vendorCode:entry.vendorCode||'',size:'',saleQty:0,returnQty:0,orderAdvertising:entry.amount,
      ...Object.fromEntries(moneyFields.filter(k=>k!=='orderAdvertising').map(k=>[k,0])),adEstimated:true};
    register(r);operations.push(r);
  }
  operations.sort((a,b)=>a.date-b.date||a.rrdId.localeCompare(b.rrdId));
  const sums = map => [...map].map(([currency, total]) => ({ currency, ...total, calculationDelta: total.beforeAdsAndCost - total.legacyBeforeAdsAndCost }));
  const productRows = [...groups.values()].map(g => ({ ...g, totals: sums(g.totals) }));
  const reconciliation = [...currencies].map(([currency, total]) => {
    const grouped = productRows.reduce((sum, group) => sum + number(group.totals.find(x => x.currency === currency)?.settlement), 0);
    return { currency, sourceSettlement: total.settlement, groupedSettlement: grouped, difference: total.settlement - grouped, balanced: Math.abs(total.settlement - grouped) < 0.005 };
  });
  return { market, range: { since, until, timezone: 'Asia/Almaty', businessTimezone: 'Europe/Moscow' }, rowCount: operations.length, duplicateRows, operations, products: productRows,
    orders: [...orders.values()], units: [...units.values()].map(unit => ({ ...unit, srids: [...unit.srids] })), totals: sums(currencies), advertising, advertisingAllocation:allocation.allocation, reconciliation,
    coverage: { linkedRows: operations.filter(x => x.productId).length, orderRows: operations.filter(x => x.srid).length, unitRows: operations.filter(x => x.shkId).length },
    basis: 'WB Moscow event day (posting day for other charges); forPay already includes commission, VAT and acquiring; saved order costs or explicit KZT estimates; daily product advertising allocated once to placed orders by Moscow creation day; cached-order estimate' };
}
