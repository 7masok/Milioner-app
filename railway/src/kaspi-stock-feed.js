export function linkedRecoveryStock(sku,rowsBySku){
  const linked=rowsBySku.get(String(sku||''));
  if(!linked)return {found:false,stock:0};
  const raw=Number(linked.stock);
  return {found:true,stock:Number.isFinite(raw)?Math.max(0,Math.floor(raw)):0};
}
