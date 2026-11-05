import {resolveWbSupplyProduct,supplyKey,ACCOUNT} from './wb3-supply-accounting.js';
import {draftGroups} from './fbo-warehouse/core.js';
const list=x=>Array.isArray(x)?x:[];
const str=x=>String(x??'').trim();
export const goodsIdentity=row=>JSON.stringify([str(row.barcode),str(row.nmID),str(row.techSize)]);
export function enrichSupplyGoods(sync,key,goods){
 return list(goods).map(raw=>{
  const row={...raw,chrtId:null,currentVendorCode:'',manualProductId:null};
  const cards=list(sync.catalog).filter(c=>str(c.nmId)===str(row.nmID)),matches=cards.flatMap(c=>list(c.sizes).filter(v=>[v.barcode,...list(v.barcodes)].map(str).includes(str(row.barcode))).map(v=>({c,v})));
  if(matches.length===1){const {c,v}=matches[0];row.chrtId=v.chrtId;row.currentVendorCode=c.vendorCode;row.title=c.title;row.photo=c.photo}
  const manual=sync.manualLinks?.[key]?.[str(row.barcode)];
  if(manual&&manual.tokenHash===sync.tokenHash&&manual.identity===goodsIdentity(row))row.manualProductId=manual.productId;
  return row;
 });
}
export function historicalSupplyDraft(supply,enabledAt){
 if(Number(supply.statusID)!==1||supply.supplyID||supply.supplyDate||!enabledAt)return false;
 const last=Math.max(Date.parse(supply.createDate)||0,Date.parse(supply.updatedDate)||0),d=new Date(Number(enabledAt)+5*3600000),start=Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate())-5*3600000;
 return last>0&&last<start;
}
export function supplyPresentation(sync,state){
 const drafts=draftGroups(state).filter(d=>d.account===ACCOUNT),owned=new Set(drafts.filter(d=>['reserved','sent'].includes(d.status)).map(d=>d.orderId)),sent=new Set(drafts.filter(d=>d.status==='sent').map(d=>d.orderId)),details={};
 for(const supply of list(sync.supplies)){
  const key=supplyKey(supply),entry=sync.goods?.[key],rows=enrichSupplyGoods(sync,key,entry?.rows),result=list(sync.results).find(r=>r.key===key);
  const lines=rows.map(row=>{let product=null,issue='';try{product=resolveWbSupplyProduct(state,row)}catch(error){issue=error.message}
   return {barcode:str(row.barcode),nmId:str(row.nmID),size:str(row.techSize),vendorCode:str(row.currentVendorCode||row.vendorCode),name:product?.name||row.currentVendorCode||row.vendorCode||row.title||'Товар без привязки',productId:product?str(product.id):'',qty:Number(row.quantity)||0,accepted:row.acceptedQuantity==null?null:Number(row.acceptedQuantity),issue};
  });
  details[key]={archived:historicalSupplyDraft(supply,sync.enabledAt)&&!owned.has(key),lines,totalQty:lines.reduce((n,r)=>n+r.qty,0),compositionReady:!!entry&&entry.listAt===sync.listAt,accounted:sent.has(key)||result?.status==='sent',date:supply.factDate||supply.supplyDate||supply.createDate||''};
 }
 return details;
}
