// History rows are display data. They never enter the FBS stock reconciler.
export function wbTime(value) {
  if (typeof value === 'number') return value > 0 ? value : 0;
  const text = String(value || '');
  // WB Statistics timestamps without an offset are Moscow local time.
  return Date.parse(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?$/.test(text) ? text + '+03:00' : text) || 0;
}
export function fulfillment(row) {
  if (typeof row.isMp === 'boolean') return row.isMp ? 'FBS' : 'FBO';
  if (row.warehouseType === 'Склад WB') return 'FBO';
  if (row.warehouseType === 'Склад продавца') return 'FBS';
  return '';
}
export function normalizeHistory(row, source, currency = '') {
  const srid = String(row.srid || '').trim(), date = wbTime(row.createdAt || row.date);
  if (!srid || !date || !(Number(row.nmId) > 0)) throw new Error('WB: заказ без srid, артикула или даты');
  const model = fulfillment(row);
  const status = source === 'feed' ? String(row.status || 'created') : row.isCancel ? 'cancel' : 'created';
  return {srid, orderId:'srid:' + srid, entryId:srid, code:srid, market:'WB',
    creationDate:date, updatedAt:wbTime(row.updatedAt || row.lastChangeDate) || date,
    fulfillment:model, orderStatus:status, status, state:'', source,
    nmId:String(row.nmId), chrtId:Number(row.chrtId) || 0, barcode:String(row.barcode || ''),
    sku:String(row.supplierArticle || ''), productName:String(row.supplierArticle || row.subject || 'WB ' + row.nmId),
    qty:1, currency:source === 'feed' ? currency : String(row.currency || ''),
    // Do not label a Statistics amount as tenge without an explicit currency.
    unitPrice:source === 'feed' ? Number(row.sellerPrice) || 0 : row.currency ? Number(row.finishedPrice) || 0 : 0,
    priceKnown:source === 'feed' ? Number.isFinite(Number(row.sellerPrice)) : Boolean(row.currency),
    warehouseName:String(row.warehouseName || '')};
}
export function mergeHistory(previous, next) {
  if (!previous) return next;
  if (next.source === 'statistics' && previous.source === 'feed') {
    return {...next,...previous,orderStatus:next.orderStatus === 'cancel' && next.updatedAt > previous.updatedAt ? 'cancel' : previous.orderStatus};
  }
  return next.updatedAt >= previous.updatedAt || next.source === 'feed' ? {...previous,...next,sku:next.sku || previous.sku,barcode:next.barcode || previous.barcode} : previous;
}
function rawObject(raw) {try{return typeof raw === 'string' ? JSON.parse(raw) : raw || {};}catch{return {};}}
export function combineOrders(nativeRows, historyRows, products = []) {
  const history = new Map(historyRows.map(row => [row.srid,row])), out = [];
  for (const input of nativeRows) {
    const {rawJson,...row} = input, raw = rawObject(rawJson), order = raw.order || raw;
    // orderUid identifies a cart; only RID/SRID identifies the individual unit.
    const srid = String(order.rid || order.srid || '').trim(), cached = history.get(srid);
    if (cached) history.delete(srid);
    const currencyCode = Number(order.convertedCurrencyCode ?? order.currencyCode);
    const currency = ({398:'KZT',643:'RUB',840:'USD',933:'BYN',417:'KGS'})[currencyCode] || '';
    const amount = Number(row.totalPrice) || 0;
    out.push({...cached,...row,fulfillment:'FBS',srid,source:'fbs',orderStatus:cached?.orderStatus || '',
      currency,priceKnown:Boolean(currency && amount > 0),totalPrice:amount,
      nmId:String(order.nmId || cached?.nmId || ''),barcode:String(order.skus?.[0] || cached?.barcode || '')});
  }
  for (const row of history.values()) out.push({...row,totalPrice:row.unitPrice});
  for (const row of out) {
    if (row.productId) continue;
    // Exact article or a unique size identity; never fuzzy names or shared carts.
    let matches = products.filter(p => row.sku && [p.wb,...(p.wbAliases || [])].some(x => String(x || '') === row.sku));
    if (!matches.length) matches = products.filter(p => {
      const v=p.wbVariant || {}, nm=String(v.nmId || p.wbIdentity?.nmId || p.variantNmId || '');
      if (!nm || nm !== row.nmId) return false;
      if (row.chrtId) return Number(v.chrtId || p.wbIdentity?.chrtId) === row.chrtId;
      if (row.barcode) return [v.barcode,...(v.barcodes || [])].includes(row.barcode);
      return products.filter(x=>String(x.wbVariant?.nmId || x.wbIdentity?.nmId || x.variantNmId || '')===nm).length===1;
    });
    if (matches.length === 1) row.productId=String(matches[0].id);
    if (row.productId) row.productName=matches[0].name || row.productName;
  }
  return out.sort((a,b)=>b.creationDate-a.creationDate || String(a.orderId).localeCompare(String(b.orderId),'en'));
}
export function orderPage(rows, cursor, limit=500) {
  const key=row=>JSON.stringify([Number(row.creationDate),String(row.orderId),String(row.entryId)]);
  const start=cursor ? rows.findIndex(row=>key(row)===cursor)+1 : 0;
  if (cursor && !start) throw new Error('Страница заказов изменилась. Обновите список.');
  const orders=rows.slice(start,start+limit);
  return {orders,nextCursor:start+orders.length<rows.length ? key(orders.at(-1)) : null,total:rows.length};
}
