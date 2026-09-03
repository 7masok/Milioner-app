export function linkedRecoveryStock(sku,rowsBySku){
  const linked=rowsBySku.get(String(sku||''));
  if(!linked)return {found:false,stock:0};
  const raw=Number(linked.stock);
  return {found:true,stock:Number.isFinite(raw)?Math.max(0,Math.floor(raw)):0};
}

export function automaticOfferFromRow(row,existingSkus,storeId){
  const sku=String(row?.sku||'').trim(),model=String(row?.name||'').trim(),price=Math.max(0,Number(row?.price)||0);
  if(!sku||!model||!(price>0)||existingSkus.has(sku))return null;
  return {sku,model,brand:String(row?.brand||'LuxAr'),price,stock:Math.max(0,Math.floor(Number(row?.stock)||0)),storeId:String(storeId||'')};
}

export function rewriteOfferPrice(body,price){
  const amount=Math.max(0,Number(price)||0);
  if(!(amount>0))return String(body||'');
  const value=String(Math.floor(amount));
  let next=String(body||'').replace(/<price\b([^>]*)>[\s\S]*?<\/price>/gi,(_whole,attrs)=>`<price${attrs}>${value}</price>`);
  next=next.replace(/<cityprice\b([^>]*)>[\s\S]*?<\/cityprice>/gi,(_whole,attrs)=>`<cityprice${attrs}>${value}</cityprice>`);
  return next;
}
