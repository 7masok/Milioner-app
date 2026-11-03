import {ozonFinancePosting, ozonSalesRows} from './ozon-posting-recovery.js';
const obj = value => {try{return typeof value === 'string' ? JSON.parse(value) : value || {};}catch{return {};}};
const num = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
const first = (raw, keys) => keys.map(k => raw[k]).find(v => v !== null && v !== undefined && v !== '');
export function wbFinanceIdentity(row) {
  return String(obj(row.raw_json).srid || '').trim();
}
export function reconcileWbPrices(market, finance, orders = []) {
  const result = {market, buyer:0, seller:0, saleQty:0, returnQty:0, excludedCurrency:0, unknownSeller:0, matched:0, unmatched:0, ambiguous:0, matchedOrderBuyer:0, matchedBuyoutBuyer:0, matchedBuyoutSeller:0, examples:[]};
  const byId = new Map(), sales = new Map(), seen = new Set();
  for (const row of orders) {
    const raw = obj(row.raw_json), order = raw.order || raw;
    const id = String(order.rid || order.srid || row.srid || '').trim();
    if (!id || row.market !== market) continue;
    const list = byId.get(id) || []; list.push(row); byId.set(id, list);
  }
  for (const row of finance) {
    if (row.market !== market) continue;
    const raw = obj(row.raw_json), id = String(row.rrd_id || first(raw,['rrdId','rrd_id']) || '');
    if (!id || seen.has(id)) continue; seen.add(id);
    const kind = String(row.operation || first(raw,['sellerOperName','supplierOperName','supplier_oper_name']) || row.doc_type || '').trim().toLowerCase();
    if (!['продажа','возврат'].includes(kind)) continue;
    if (String(first(raw,['currency','currencyCode','currency_code']) || '').toUpperCase() !== 'KZT') {result.excludedCurrency++; continue;}
    const qty = Math.abs(num(row.qty) ?? num(first(raw,['quantity','qty'])) ?? 0), buyer = num(row.retail_amount) ?? num(first(raw,['retailAmount','retail_amount']));
    if (!qty || buyer === null) continue;
    const sign = kind === 'возврат' ? -1 : 1, price = num(first(raw,['retailPriceWithDisc','retail_price_withdisc_rub']));
    result.buyer += sign * Math.abs(buyer);
    if (price === null) result.unknownSeller++; else result.seller += sign * qty * Math.abs(price);
    result[sign > 0 ? 'saleQty' : 'returnQty'] += qty;
    const srid = wbFinanceIdentity(row);
    if (sign > 0) {const rows = sales.get(srid || 'row:'+id) || []; rows.push({row,qty,buyer:Math.abs(buyer),seller:price===null?null:qty*Math.abs(price),srid}); sales.set(srid || 'row:'+id,rows);}
    if (sign > 0 && price !== null && Math.abs(qty*Math.abs(price)-Math.abs(buyer))>.01 && result.examples.length<3)
      result.examples.push({id:srid, item:String(row.vendor_code||''), buyer:Math.abs(buyer), seller:qty*Math.abs(price), discountPercent:num(first(raw,['spp','ppvz_spp_prc']))});
  }
  for (const entries of sales.values()) {
    const sale = entries[0], matches = byId.get(sale.srid) || [];
    if (entries.length!==1 || matches.length>1) {result.ambiguous++; continue;}
    if (matches.length!==1) {result.unmatched++; continue;}
    const order = matches[0], raw = obj(order.raw_json).order || obj(order.raw_json), currency = Number(raw.convertedCurrencyCode ?? raw.currencyCode);
    if (currency!==398 || Number(order.qty)!==sale.qty || sale.seller===null) {result.unmatched++; continue;}
    result.matched++; result.matchedOrderBuyer += Number(order.total_price)||0; result.matchedBuyoutBuyer += sale.buyer; result.matchedBuyoutSeller += sale.seller;
  }
  result.discountDifference = result.unknownSeller ? null : result.seller-result.buyer;
  return result;
}
export function reconcileOzonPrices(accounts, since, until) {
  const result={market:'Ozon',buyer:null,seller:0,sales:0,returns:0,matched:0,samePrice:0,differentPrice:0,ambiguous:0,missing:0,missingAmount:0,matchedOrderAmount:0,matchedSaleAmount:0,excludedCurrency:0,examples:[]};
  for (const account of accounts) {
    const postings=new Map(),groups=new Map(),seen=new Set();
    for (const posting of account.postings?.rows||[]) for(const product of posting.products||[]) {
      const key=String(posting.posting_number)+'|'+String(product.sku),rows=postings.get(key)||[];rows.push({posting,product});postings.set(key,rows);
    }
    for(const row of ozonSalesRows(account)) {
      const at=Date.parse(row.operation_date),id=String(row.operation_id||'');if(!(at>=since&&at<until)||!id||seen.has(id))continue;seen.add(id);
      if(String(row.currency_code||row.currency||'').toUpperCase()!=='KZT'){result.excludedCurrency++;continue;}
      const amount=num(row.accruals_for_sale)||num(row.amount);if(amount===null||amount===0)continue;
      result.seller+=amount;result[amount>0?'sales':'returns']++;
      const key=ozonFinancePosting(row)+'|'+String(row.items?.[0]?.sku||''),entries=groups.get(key)||[];entries.push({row,amount});groups.set(key,entries);
    }
    for(const [key,entries]of groups) {
      const matches=postings.get(key)||[],positive=entries.filter(x=>x.amount>0),net=entries.reduce((n,x)=>n+x.amount,0);
      if(!matches.length){result.missing++;result.missingAmount+=net;continue;}
      if(matches.length!==1||positive.length!==1){if(positive.length)result.ambiguous++;continue;}
      const {posting,product}=matches[0],currency=String(product.currency_code||product.currency||'').toUpperCase(),price=num(typeof product.price==='object'?product.price.amount:product.price),qty=num(product.quantity);
      if(currency!=='KZT'||price===null||!qty){result.ambiguous++;continue;}
      const ordered=price*qty,sold=positive[0].amount;result.matched++;result.matchedOrderAmount+=ordered;result.matchedSaleAmount+=sold;
      if(Math.abs(ordered-sold)<=.01)result.samePrice++;else{result.differentPrice++;if(result.examples.length<3)result.examples.push({id:posting.posting_number,item:String(product.offer_id||product.sku),ordered,sold});}
    }
  }
  return result;
}
