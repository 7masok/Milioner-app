import {createDraft,cancelDraft,dispatchDraft,draftGroups,uid,fail} from './fbo-warehouse/core.js';
import {stockLedgerViolation} from './warehouse-ledger.js';
export const ACCOUNT='wb3-fbw';
export const preparing=s=>[1,2,3].includes(Number(s.statusID));
export const shipped=s=>[4,5,6].includes(Number(s.statusID));
export const supplyKey=s=>Number.isSafeInteger(Number(s.preorderID))&&Number(s.preorderID)>0?'preorder:'+s.preorderID:'';
const arr=x=>Array.isArray(x)?x:[];
const str=x=>String(x??'').trim();
export function resolveWbSupplyProduct(state,row){
 const products=arr(state.products).filter(p=>p.kind!=='variant-group');
 // Size identity wins. An article shared by several sizes is never sufficient.
 const barcode=str(row.barcode),nm=str(row.nmID),size=str(row.techSize);
 const identity=p=>p.wbVariant||p.wbIdentity||{};
 let matches=products.filter(p=>{const v=identity(p);return barcode&&[v.barcode,...arr(v.barcodes)].map(str).includes(barcode)&&(!nm||!str(v.nmId||p.variantNmId)||str(v.nmId||p.variantNmId)===nm)});
 if(!matches.length)matches=products.filter(p=>{const v=identity(p);return nm&&str(v.nmId||p.variantNmId)===nm&&size&&str(v.techSize||v.size)===size});
 if(!matches.length){
  const article=str(row.vendorCode);
  matches=products.filter(p=>article&&[p.wb,...arr(p.wbAliases)].map(str).includes(article));
  if(matches.some(p=>p.kind==='variant'||str(identity(p).barcode)||str(identity(p).techSize||identity(p).size)))matches=[];
 }
 if(matches.length!==1)fail('Баркод '+barcode+': '+(matches.length?'несколько привязок':'нет точной привязки товара или размера'));
 return matches[0];
}
export function supplyLines(state,goods){
 if(!Array.isArray(goods)||!goods.length)fail('Состав поставки ещё не получен');
 const grouped=new Map(),links=new Map();
 for(const row of goods){
  const qty=Number(row.quantity),sku=str(row.barcode);if(!sku||!Number.isSafeInteger(qty)||qty<0)fail('Некорректный состав поставки');if(!qty)continue;
  const p=resolveWbSupplyProduct(state,row),old=grouped.get(sku);
  if(old&&links.get(sku).id!==p.id)fail('Баркод связан с разными товарами');
  links.set(sku,p);grouped.set(sku,{sku,qty:(old?.qty||0)+qty,clusterKey:'WB3',cluster:'WB3 FBO'});
 }
 if(!grouped.size)fail('Поставка не содержит товаров');return {lines:[...grouped.values()],resolve:sku=>({product:links.get(sku)})};
}
const same=(a,b)=>a.length===b.length&&a.every(l=>b.some(x=>l.sku===x.sku&&l.qty===x.qty&&l.clusterKey===x.clusterKey));
export function accountWbSupply(before,supply,goods,now=Date.now(),tokenHash=''){
 const key=supplyKey(supply);if(!key)fail('У поставки нет постоянного preorderID');
 if(!preparing(supply)&&!shipped(supply))return {changed:false,status:'unknown'};
 const state=structuredClone(before),owned=draftGroups(state).filter(d=>d.account===ACCOUNT&&d.orderId===key),active=owned.filter(d=>d.status==='reserved');
 if(tokenHash&&owned.some(d=>d.rows.some(r=>r.supplyTokenHash&&r.supplyTokenHash!==tokenHash)))fail('Ключ WB3 изменился. Проверьте прежний резерв вручную');
 if(active.length>1)fail('Найдено несколько резервов поставки');
 const sent=owned.find(d=>d.status==='sent');
 if(sent){
  // The shipped composition is immutable. Acceptance is observation, not stock intake.
  const report=acceptance(supply,goods),old=state.settings?.wb3SupplyReceipts?.[key];
  if(JSON.stringify(old)===JSON.stringify(report))return {changed:false,status:'sent'};
  state.settings={...state.settings,wb3SupplyReceipts:{...state.settings?.wb3SupplyReceipts,[key]:report}};
  return {changed:true,state,status:'sent'};
 }
 if(owned.some(d=>d.status==='cancelled'&&!d.rows.every(r=>r.autoSuperseded)))return {changed:false,status:'cancelled'};
 const {lines,resolve}=supplyLines(state,goods);
 for(const l of active[0]?.lines||[])if(resolve(l.sku).product&&String(resolve(l.sku).product.id)!==String(l.productId))fail('Привязка зарезервированного товара изменилась');
 if(active.length&&!same(active[0].lines,lines)){
  // Never silently resize a dispatched shipment or infer a return from a shortage.
  cancelDraft(state,active[0].id,now);for(const r of state.reservations.filter(r=>r.draftId===active[0].id))r.autoSuperseded=true;
 }
 let draft=active.length&&same(active[0].lines,lines)?active[0]:null;
 if(!draft){draft=createDraft(state,{id:'wb3-reserve-'+uid(key,owned.length),title:'Поставка WB3 '+supply.preorderID,lines},resolve,ACCOUNT,now).draft;for(const r of draft.rows)Object.assign(r,{orderId:key,autoWb3Supply:true,supplyTokenHash:tokenHash,market:'WB',updatedAt:now})}
 if(shipped(supply)){
  dispatchDraft(state,draft.id,{marketplace:'WB3',orderId:key,lines:lines.map(l=>({...l,supplyId:key,bundleId:'',warehouse:'WB3 FBO'}))},now);
  state.settings.wb3SupplyReceipts={...state.settings.wb3SupplyReceipts,[key]:acceptance(supply,goods)};
 }
 const violation=stockLedgerViolation(before,state);if(violation)fail('Списание не согласовано с журналом склада: '+violation.reason);
 return {changed:JSON.stringify(before)!==JSON.stringify(state),state,status:shipped(supply)?'sent':'reserved'};
}
export function acceptance(supply,goods){return {supplyID:supply.supplyID||null,statusID:Number(supply.statusID),lines:arr(goods).map(g=>({barcode:str(g.barcode),sent:Number(g.quantity)||0,accepted:g.acceptedQuantity!=null&&Number.isSafeInteger(Number(g.acceptedQuantity))?Number(g.acceptedQuantity):null,ready:g.readyForSaleQuantity!=null&&Number.isSafeInteger(Number(g.readyForSaleQuantity))?Number(g.readyForSaleQuantity):null})).sort((a,b)=>a.barcode.localeCompare(b.barcode))}}
