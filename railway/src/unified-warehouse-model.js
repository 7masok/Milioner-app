// Virtual IDs are an API boundary only. Each warehouse keeps its original IDs.
export const INFERNO_ID = 'inferno:';
export const LISTS = ['products','purchases','movements','sales','reservations','kaspiAdExpenses'];
const IDS = new Set(['id','productId','variantGroupId','parentId','orderId','purchaseId','purchaseOrderId','shipmentId','batchId','reservationId','movementId','externalKey','componentId','packagingId','saleId','adjustmentMovementId','returnReceiptId','productIds','purchaseIds','reservationIds','movementIds','ids']);
const MARKETS = new Set(['market','channel','source','account','markets','variantMarket']);
export function scopeValue(value, toUnified = true, key = '', idKeys = IDS) {
  if (Array.isArray(value)) return value.map(v => scopeValue(v,toUnified,key,idKeys));
  if (value && typeof value === 'object') {
    const result={};
    for (let [k,v] of Object.entries(value)) {
      if(k===(toUnified?'WB':'WB3'))k=toUnified?'WB3':'WB';
      if (k === (toUnified ? 'wb' : 'wb3')) k=toUnified?'wb3':'wb';
      else if (k === (toUnified ? 'wbAliases' : 'wb3Aliases')) k=toUnified?'wb3Aliases':'wbAliases';
      else if(k===(toUnified?'wbIdentity':'wb3Identity'))k=toUnified?'wb3Identity':'wbIdentity';
      result[k]=scopeValue(v,toUnified,k,idKeys);
    }
    return result;
  }
  if (typeof value === 'string' && value && idKeys.has(key)) return toUnified ? INFERNO_ID+value : value.startsWith(INFERNO_ID)?value.slice(INFERNO_ID.length):value;
  if (typeof value === 'string' && MARKETS.has(key) && value === (toUnified?'WB':'WB3')) return toUnified?'WB3':'WB';
  return value;
}
export function mergeWarehouses(main, inferno) {
  const result={...main,settings:{...(main.settings||{}),unifiedWarehouseVersion:1,infernoSettings:structuredClone(inferno.settings||{})}};
  for(const key of LISTS)result[key]=[...(main[key]||[]),...scopeValue(inferno[key]||[])];
  if(main.settings?.purchasePlanIgnored||inferno.settings?.purchasePlanIgnored)result.settings.purchasePlanIgnored={...(main.settings?.purchasePlanIgnored||{}),...Object.fromEntries(Object.entries(inferno.settings?.purchasePlanIgnored||{}).map(([id,v])=>[INFERNO_ID+id,v]))};
  if(main.settings?.packagingV1||inferno.settings?.packagingV1){const a=main.settings?.packagingV1||{},b=inferno.settings?.packagingV1||{};result.settings.packagingV1={...a,items:[...(a.items||[]),...scopeValue(b.items||[])],movements:[...(a.movements||[]),...scopeValue(b.movements||[])]};}
  return result;
}
export function splitWarehouses(input, originalInferno={},originalMain={}) {
  const main={...input,settings:{...(input.settings||{})}},inferno={...originalInferno,settings:structuredClone(input.settings?.infernoSettings||originalInferno.settings||{})};
  delete main.settings.infernoSettings;delete main.settings.unifiedWarehouseVersion;
  if(input.settings?.purchasePlanIgnored){main.settings.purchasePlanIgnored={};inferno.settings.purchasePlanIgnored={};for(const [id,v]of Object.entries(input.settings.purchasePlanIgnored))(id.startsWith(INFERNO_ID)?inferno.settings.purchasePlanIgnored:main.settings.purchasePlanIgnored)[id.startsWith(INFERNO_ID)?id.slice(INFERNO_ID.length):id]=v;}
  if(input.settings?.packagingV1){const pack=input.settings.packagingV1;main.settings.packagingV1={...pack};inferno.settings.packagingV1={...(inferno.settings.packagingV1||{})};for(const key of ['items','movements']){main.settings.packagingV1[key]=(pack[key]||[]).filter(x=>!String(x.id).startsWith(INFERNO_ID)&&!String(x.packagingId||'').startsWith(INFERNO_ID));inferno.settings.packagingV1[key]=(pack[key]||[]).filter(x=>String(x.id).startsWith(INFERNO_ID)||String(x.packagingId||'').startsWith(INFERNO_ID)).map(x=>scopeValue(x,false));}}

  if(!originalMain.settings?.purchasePlanIgnored&&!Object.keys(main.settings.purchasePlanIgnored||{}).length)delete main.settings.purchasePlanIgnored;
  if(!originalInferno.settings?.purchasePlanIgnored&&!Object.keys(inferno.settings.purchasePlanIgnored||{}).length)delete inferno.settings.purchasePlanIgnored;
  if(!originalMain.settings?.packagingV1&&!(main.settings.packagingV1?.items||[]).length&&!(main.settings.packagingV1?.movements||[]).length)delete main.settings.packagingV1;
  if(!originalInferno.settings?.packagingV1&&!(inferno.settings.packagingV1?.items||[]).length&&!(inferno.settings.packagingV1?.movements||[]).length)delete inferno.settings.packagingV1;
  for(const key of LISTS){
    main[key]=[];inferno[key]=[];
    for(const row of input[key]||[]){
      const own=String(row?.id||'').startsWith(INFERNO_ID)||String(row?.productId||'').startsWith(INFERNO_ID)||String(row?.externalKey||'').startsWith(INFERNO_ID)||row.market==='WB3'||row.channel==='WB3'||row.source==='WB3'||(key==='products'&&row.warehouse==='WB3');
      if(own&&row.id&&!String(row.id||'').startsWith(INFERNO_ID)&&(originalMain[key]||[]).some(old=>old.id===row.id))throw new Error('Нельзя перемещать запись между складами');
      const checkRefs=(value)=>{if(Array.isArray(value)){value.forEach(checkRefs);return;}if(!value||typeof value!=='object')return;for(const [field,ref]of Object.entries(value)){if(['productId','variantGroupId','componentId','packagingId'].includes(field)&&typeof ref==='string'&&ref&&ref.startsWith(INFERNO_ID)!==own)throw new Error('Операция содержит ссылку другого склада');if(ref&&typeof ref==='object')checkRefs(ref);}};checkRefs(row);
      (own?inferno[key]:main[key]).push(own?scopeValue(row,false):row);
    }
  }
  // A virtual reference must never be persisted into the main database.
  for(const row of main.products||[])if(JSON.stringify(row).includes('"inferno:'))throw new Error('Товар основного склада не может ссылаться на товар WB3');
  return {main,inferno};
}
export function combinedRevision(main,child){
  if(!Number.isSafeInteger(main)||!Number.isSafeInteger(child)||main<0||child<0||child>=100000000||!Number.isSafeInteger(main*100000000+child))throw new Error('Unsupported warehouse revision');
  return main*100000000+child;
}
export function stable(value,key=''){
  if(Array.isArray(value)){const values=value.map(v=>stable(v));if(LISTS.includes(key))values.sort();return '['+values.join(',')+']';}
  if(value&&typeof value==='object')return '{'+Object.keys(value).filter(k=>!['serverUpdatedAt','serverMarketStatus','activeView','serverWarehouseRevision','serverWarehouseUpdatedAt'].includes(k)).sort().map(k=>JSON.stringify(k)+':'+stable(value[k],k)).join(',')+'}';
  return JSON.stringify(value);
}

export const scopeApiValue=value=>scopeValue(value,true,'',new Set(['productId','productIds','variantGroupId','componentId']));

export function entityKey(field,row){
 if(field==='sales')return String(row.externalKey||row.id||'');
 if(field==='reservations')return String((row.source||'')+'|'+(row.externalKey||row.id||''));
 if(field==='kaspiAdExpenses')return String(row.id||row.importId||[row.date,row.day,row.productId,row.sku,row.amount].join('|'));
 return String(row.id||'');
}
export function applyUnifiedPatch(base,patch){
 const state={...base};
 for(const field of LISTS){
  if(!Object.hasOwn(patch,field)&&!patch.deleted?.[field]?.length)continue;
  const rows=new Map((base[field]||[]).map(row=>[entityKey(field,row),row]));
  for(const key of patch.deleted?.[field]||[])rows.delete(String(key));
  for(const row of patch[field]||[])rows.set(entityKey(field,row),row);
  state[field]=[...rows.values()];
 }
 if(Object.hasOwn(patch,'settings'))state.settings=patch.settings;
 if(Object.hasOwn(patch,'kaspiBaselineAt'))state.kaspiBaselineAt=patch.kaspiBaselineAt;
 return state;
}
export function warehouseDelta(before,after){
 const patch={deleted:{}};
 for(const field of LISTS){
  const old=new Map((before[field]||[]).map(row=>[entityKey(field,row),row]));
  const current=new Map((after[field]||[]).map(row=>[entityKey(field,row),row]));
  const upserts=[...current].filter(([key,row])=>!old.has(key)||stable(old.get(key))!==stable(row)).map(([,row])=>row);
  const removed=[...old.keys()].filter(key=>!current.has(key));
  if(upserts.length)patch[field]=upserts;if(removed.length)patch.deleted[field]=removed;
 }
 if(!Object.keys(patch.deleted).length)delete patch.deleted;
 if(stable(before.settings)!==stable(after.settings))patch.settings=after.settings||{};
 if((before.kaspiBaselineAt||null)!==(after.kaspiBaselineAt||null))patch.kaspiBaselineAt=after.kaspiBaselineAt||null;
 return patch;
}
