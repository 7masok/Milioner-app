// Read actual missing postings by their exact finance identifier. Never invent
// order dates or product prices from the date/amount of a financial accrual.
export function ozonFinancePosting(row) {
  return String(row?.posting?.posting_number || row?.unit_number || '').trim();
}
export function ozonSalesRows(account) {
  return (account?.finance?.rows || []).filter(r =>
    Number(r.accruals_for_sale) !== 0 && Number.isFinite(Number(r.accruals_for_sale)) ||
    String(r.operation_type_name || '').toLowerCase() === 'продажа');
}
export function missingOzonPostings(account) {
  const known = new Set((account?.postings?.rows || []).map(p => String(p.posting_number)));
  return [...new Set(ozonSalesRows(account).map(ozonFinancePosting))]
    .filter(n => /^\d{4,20}-\d{2,20}-\d{1,10}$/.test(n) && !known.has(n));
}
export async function recoverOzonPostings(account, readPosting, now = Date.now(), budget = 5) {
  const old = account.postings || {}, prior = old.reconciliation || {};
  const retry = {...prior.retry}, repairedDays = {...prior.repairedDays}, recalculatedDays={...prior.recalculatedDays};
  if(prior.qtyVersion!==1)for(const row of ozonSalesRows(account)){const t=Date.parse(row.operation_date||'');if(Number(row.accruals_for_sale||row.amount)<0&&Number.isFinite(t))recalculatedDays[new Date(t+18000000).toISOString().slice(0,10)]=now;}
  const rows = [...(old.rows || [])], missing = missingOzonPostings(account);
  let nextAt = Math.max(now + 60000, Number(prior.nextAt) || 0), attempted = 0, recovered = 0;
  if (!(Number(prior.nextAt) > now)) for (const number of missing) {
    if (attempted >= budget) break;
    if (Number(retry[number]?.nextAt) > now) continue;
    attempted++;
    try {
      const result = await readPosting(number), posting = result?.result || result;
      if (String(posting?.posting_number) !== number || !Number.isFinite(Date.parse(posting.created_at)) || !Array.isArray(posting.products) || !posting.products.length ||
          posting.products.some(p => !p.sku || !Number.isSafeInteger(Number(p.quantity)) || Number(p.quantity) < 1 || (p.price===null||p.price===undefined||p.price===''||typeof p.price==='object'&&(p.price.amount===null||p.price.amount===undefined||p.price.amount==='')||!Number.isFinite(Number(typeof p.price === 'object' ? p.price.amount : p.price)))))
        throw Error('Ozon: неполное отправление при сверке');
      rows.push({...posting, products: posting.products.map(p => ({...p, price: typeof p.price === 'object' ? p.price.amount : p.price, currency_code: p.price?.currency || p.currency_code || p.currency || posting.financial_data?.currency_code}))});
      const day = new Date(Date.parse(posting.created_at) + 18000000).toISOString().slice(0,10);
      repairedDays[day] = now; delete retry[number]; recovered++;
    } catch (error) {
      const wait = /HTTP 404/.test(error.message) ? 86400000 : 15 * 60000;
      retry[number] = {nextAt: Math.max(now + wait, Number(error.retryAt) || 0),error:String(error.message||'Ozon: не удалось прочитать отправление').slice(0,240)};
      if (Number(error.retryAt) > now || /HTTP 429/.test(error.message)) {nextAt = retry[number].nextAt; break;}
    }
  }
  const present = new Set(rows.map(p => String(p.posting_number))), remaining = missing.filter(n => !present.has(n));
  for (const n of Object.keys(retry)) if (!remaining.includes(n)) delete retry[n];
  if (remaining.length && remaining.every(n => Number(retry[n]?.nextAt) > now)) nextAt = Math.max(nextAt, Math.min(...remaining.map(n => retry[n].nextAt)));
  return {...old, rows, reconciliation: {version:1, pending:remaining.length, recovered:(Number(prior.recovered)||0)+recovered, checkedAt:now, nextAt:remaining.length?nextAt:0, retry, repairedDays, recalculatedDays, qtyVersion:1}};
}
