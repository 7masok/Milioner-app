const rows=value=>Array.isArray(value)?value:[];
const map=value=>value&&typeof value==='object'&&!Array.isArray(value)?value:{};
const receiptFields=['wbReturnReceipts','kaspiReturnReceipts'];
const receiptKey=(field,key)=>field==='kaspiReturnReceipts'?'Kaspi:'+key:key;
// Receipts survive stale settings snapshots. The first accepted disposition is
// authoritative; a retry must not replace it with a newer stock credit.
export function preserveReturnReceipts(previous,next){
 next.settings={...map(next.settings)};
 for(const field of receiptFields){const prior=map(previous?.settings?.[field]),incoming=map(next.settings[field]);if(Object.keys(prior).length||Object.keys(incoming).length)next.settings[field]={...incoming,...prior}}
}
export function returnReceiptViolation(previous,next){
 const ids=new Set(rows(previous.movements).map(m=>String(m.id))),added=rows(next.movements).filter(m=>m.type==='возврат'&&!ids.has(String(m.id)));
 const positive=added.filter(m=>Number(m.qty)>0),processed=new Set(rows(previous.movements).filter(m=>/^WB\d*:/.test(String(m.externalKey||''))&&(m.type==='продажа'&&m.stockRestoredAt||m.type==='возврат'&&Number(m.qty)>0)).map(m=>String(m.externalKey)));
 for(const field of receiptFields){const prior=map(previous?.settings?.[field]),incoming=map(next.settings?.[field]);
  for(const key of Object.keys(incoming))if(!prior[key]&&positive.length&&processed.has(receiptKey(field,key)))return {reason:'return-already-processed',orderKey:receiptKey(field,key)};
  for(const [key,value]of Object.entries(prior)){
   processed.add(receiptKey(field,key));
   if(positive.length&&Number(incoming[key]?.at)>Number(value?.at))return {reason:'return-already-processed',orderKey:receiptKey(field,key)};
  }
 }
 const reversed=new Set(rows(previous.movements).filter(m=>m.type==='возврат'&&Number(m.qty)>0).flatMap(m=>[m.reversesMovementId,...rows(m.reversesMovementIds)]).filter(Boolean).map(String)),seen=new Set();
 for(const m of positive){
  const external=String(m.externalKey||''),key=String(m.returnReceiptKey||(/^Kaspi:/.test(external)?external.split(':').slice(0,2).join(':'):external));
  if(key&&processed.has(key))return {reason:'return-already-processed',orderKey:key};
  for(const id of [m.reversesMovementId,...rows(m.reversesMovementIds)].filter(Boolean).map(String)){if(reversed.has(id))return {reason:'return-debit-already-restored',movementId:id};reversed.add(id)}
  // Separate products/entries of a bundle or multi-line order remain valid.
  if(key){const identity=JSON.stringify([key,external,String(m.productId)]);if(seen.has(identity))return {reason:'duplicate-order-return',orderKey:key};seen.add(identity)}
 }
 return null;
}
