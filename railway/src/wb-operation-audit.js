// Read-only audit of the persisted WB report. No warehouse/FIFO writes or upstream calls.
const text = value => String(value ?? '').trim();
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
const moneyFields = ['revenue', 'forPay', 'commission', 'acquiring', 'delivery', 'rebill', 'storage', 'acceptance', 'deduction', 'promotionDeduction', 'penalty', 'additionalPayment', 'settlement', 'beforeAdsAndCost', 'legacyBeforeAdsAndCost'];
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
  const result = {
    market, rrdId: id(row.rrd_id || field(raw, ['rrdId', 'rrd_id'], '')), reportId: id(row.report_id),
    date: number(row.rr_date), saleDate: number(row.sale_date), operation: operation || docType || 'Операция WB', docType,
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
    acquiring: signed(amount(['acquiringFee', 'acquiring_fee'], 'acquiring_fee')),
    delivery: amount(['deliveryService', 'deliveryRub', 'delivery_rub'], 'delivery_service'),
    rebill: amount(['rebillLogisticCost', 'rebill_logistic_cost'], 'rebill_logistic_cost'),
    storage: amount(['paidStorage', 'storageFee', 'storage', 'storage_fee'], 'paid_storage'),
    acceptance: amount(['paidAcceptance', 'acceptance', 'acceptanceFee', 'acceptance_fee'], 'paid_acceptance'),
    deduction: allDeduction - promotionDeduction, promotionDeduction,
    penalty: amount(['penalty'], 'penalty'), additionalPayment: amount(['additionalPayment', 'additional_payment'], 'additional_payment')
  };
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
  const bySku = new Map(), catalog = new Map(), nmProducts = new Map();
  for (const source of products) { const p = { ...object(source.payload), ...source }; catalog.set(text(p.id), p); }
  for (const link of links) {
    const sku = id(link.sku), pid = text(link.productId ?? link.product_id);
    if (!sku || !pid) continue;
    const set = bySku.get(sku) || new Set(); set.add(pid); bySku.set(sku, set);
  }
  const field = market === 'WB2' ? 'wb2' : 'wb';
  for (const p of catalog.values()) {
    const identity = p[field + 'Identity'] || (p.wbVariant?.market === market ? p.wbVariant : {});
    const parent = p.variantGroupId ? catalog.get(text(p.variantGroupId)) : null;
    const nm = id(identity.nmId || (parent?.variantMarket === market ? parent.variantNmId : ''));
    if (!nm) continue;
    const set = nmProducts.get(nm) || new Set(); set.add(text(p.id)); nmProducts.set(nm, set);
  }
  return { bySku, catalog, nmProducts };
}
function linkProduct(row, index) {
  // A barcode is more specific than the common nmId/article of a card with sizes.
  const precise = row.barcode && index.bySku.get(row.barcode);
  if (precise?.size === 1) return { productId: [...precise][0], linkSource: 'barcode' };
  if (precise?.size > 1) return { productId: '', linkSource: 'ambiguous' };
  const candidates = new Set([...(index.bySku.get(row.vendorCode) || []), ...(index.bySku.get(row.nmId) || [])]);
  // A shared card link must not silently collapse barcode-specific variants.
  const knownSizes = index.nmProducts.get(row.nmId);
  if (knownSizes?.size > 1 || row.barcode && knownSizes?.size === 1 && !candidates.has([...knownSizes][0])) return { productId: '', linkSource: 'ambiguous' };
  return candidates.size === 1 ? { productId: [...candidates][0], linkSource: 'article' } : { productId: '', linkSource: candidates.size > 1 ? 'ambiguous' : 'none' };
}
function adNmIds(value) { const values = Array.isArray(value) ? value : (() => { try { return JSON.parse(value || '[]'); } catch { return []; } })(); return Array.isArray(values) ? [...new Set(values.map(id).filter(Boolean))] : []; }

export function buildWbOperationAudit({ market, rows = [], links = [], products = [], adRows = [], since = 0, until = Infinity }) {
  if (!['WB', 'WB2'].includes(market)) throw new Error('market must be WB or WB2');
  const index = indexes(links.filter(x => !x.market || x.market === market), products, market), unique = new Map();
  let duplicateRows = 0;
  for (const row of rows) {
    if (row.market && row.market !== market || number(row.rr_date) < since || number(row.rr_date) >= until) continue;
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
  const groups = new Map(), currencies = new Map(), orders = new Map(), units = new Map();
  for (const row of operations) {
    row.productKey = row.productId ? 'p:' + row.productId : 'u:' + JSON.stringify([row.nmId, row.vendorCode, row.barcode]);
    const p = index.catalog.get(row.productId);
    row.productName = p?.name || row.title || row.vendorCode || ('WB ' + (row.nmId || 'без товара'));
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
  }
  const advertising = adRows.filter(row => !row.market || row.market === market).map((row, n) => {
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
    if (productId) {
      const key = 'p:' + productId, p = index.catalog.get(productId);
      const group = groups.get(key) || { key, productId, name: p?.name || 'Реклама WB', linked: true, rows: [], totals: new Map(), advertising: [] };
      group.advertising.push(result.key); groups.set(key, group);
    }
    return result;
  });
  const sums = map => [...map].map(([currency, total]) => ({ currency, ...total, calculationDelta: total.beforeAdsAndCost - total.legacyBeforeAdsAndCost }));
  const productRows = [...groups.values()].map(g => ({ ...g, totals: sums(g.totals) }));
  const reconciliation = [...currencies].map(([currency, total]) => {
    const grouped = productRows.reduce((sum, group) => sum + number(group.totals.find(x => x.currency === currency)?.settlement), 0);
    return { currency, sourceSettlement: total.settlement, groupedSettlement: grouped, difference: total.settlement - grouped, balanced: Math.abs(total.settlement - grouped) < 0.005 };
  });
  return { market, range: { since, until, timezone: 'Asia/Almaty' }, rowCount: operations.length, duplicateRows, operations, products: productRows,
    orders: [...orders.values()], units: [...units.values()].map(unit => ({ ...unit, srids: [...unit.srids] })), totals: sums(currencies), advertising, reconciliation,
    coverage: { linkedRows: operations.filter(x => x.productId).length, orderRows: operations.filter(x => x.srid).length, unitRows: operations.filter(x => x.shkId).length },
    basis: 'WB report operation date; forPay already includes commission and acquiring; no warehouse cost estimates' };
}
