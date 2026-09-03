export function linkedRecoveryStock(sku,rowsBySku){
  const linked=rowsBySku.get(String(sku||''));
  if(!linked)return {found:false,stock:0};
  const raw=Number(linked.stock);
  return {found:true,stock:Number.isFinite(raw)?Math.max(0,Math.floor(raw)):0};
}

function normalize(value){return String(value||'').toLowerCase().replace(/ё/g,'е').replace(/[^a-zа-я0-9]+/gi,' ').trim().replace(/\s+/g,' ')}

export function normalizedWordsMatch(value,hintValue){
  const name=normalize(value),hint=normalize(hintValue);
  if(!hint)return false;
  if(name.includes(hint))return true;
  const words=name.split(' '),tokens=hint.split(' ').filter(x=>x.length>=3);
  return tokens.length>0&&tokens.every(token=>words.some(word=>word.startsWith(token)||token.startsWith(word)));
}
