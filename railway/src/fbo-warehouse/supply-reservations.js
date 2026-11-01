import crypto from 'node:crypto';
import {transaction} from '../db.js';
import {config} from '../config.js';
import {readWarehouseContext,persistFboOperation} from './store.js';
import {resolver,createDraft,cancelDraft,draftGroups,uid,fail} from './core.js';
import {remoteForOrder} from './remote.js';
const PREPARING=new Set(['DATA_FILLING','READY_TO_SUPPLY','TIMESLOT_BOOKING','SUPPLY_VARIANTS_ARRANGING']);
const CANCELLED=new Set(['CANCELLED','REJECTED_AT_SUPPLY_WAREHOUSE','OVERDUE']);
const clientHash=a=>crypto.createHash('sha256').update(String(a.clientId)).digest('hex');
const sameLines=(a,b)=>a.length===b.length&&a.every(l=>b.some(x=>x.sku===l.sku&&x.clusterKey===l.clusterKey&&x.qty===l.qty));
// Every order works on a clone: failed relinking/resizing keeps its previous
// reservation intact. A missing order or unknown status never frees stock.
export function reserveSupplyOrder(context,payload,account,orderId,now=Date.now()){
 const before=context.state,parts=(payload.supplies||[]).filter(s=>String(s.orderId)===orderId),hash=clientHash(account);
 const owned=draftGroups(before).filter(d=>d.account===account.id&&d.orderId===orderId&&d.rows.some(r=>r.autoOzonSupply));
 if(owned.some(d=>d.rows.some(r=>r.supplyClientHash!==hash)))fail('Кабинет Ozon изменился. Проверьте прежний резерв вручную.');
 const active=owned.filter(d=>d.status==='reserved');if(active.length>1)fail('У заявки несколько резервов. Проверьте вручную.');
 if(!parts.length)return {changed:false,status:'unchanged'};
 if(parts.every(s=>CANCELLED.has(s.orderState||s.state))){
  if(!active.length)return {changed:false,status:'cancelled',message:'Заявка отменена, резерв снят'};
  const state=structuredClone(before);for(const d of active){cancelDraft(state,d.id,now);for(const r of state.reservations.filter(r=>r.draftId===d.id))r.autoRemoteCancelled=true;}
  return {changed:true,state,status:'cancelled',message:'Заявка отменена, резерв снят'};
 }
 if(!parts.every(s=>PREPARING.has(s.orderState||s.state)&&PREPARING.has(s.state)))return {changed:false,status:'unchanged'};
 if(owned.some(d=>d.status==='sent'))return {changed:false,status:'already'};
 if(!active.length&&owned.some(d=>d.status==='cancelled'&&!d.rows.every(r=>r.autoSuperseded||r.autoRemoteCancelled)))return {changed:false,status:'cancelled',message:'Резерв снят вручную, повторно не создаём'};
 const remote=remoteForOrder({payload},orderId,{preparing:true}),groups=new Map();
 for(const l of remote.lines){if(!l.clusterKey||['name:','name:undefined','name:null','id:0'].includes(l.clusterKey))fail('Не определён кластер заявки.');const key=l.sku+'|'+l.clusterKey;const row=groups.get(key)||{sku:l.sku,clusterKey:l.clusterKey,cluster:l.warehouse,qty:0};row.qty+=l.qty;groups.set(key,row)}
 const lines=[...groups.values()],state=structuredClone(before),resolve=resolver(state,context.stockRows);
 // Even an unchanged composition must still point to the same warehouse item.
 for(const l of lines){const link=resolve(l.sku);if(!link.product)fail('SKU '+l.sku+': '+(link.ambiguous?'несколько товаров склада':'выберите товар склада в FBO'));const previous=active[0]?.lines.find(x=>x.sku===l.sku&&x.clusterKey===l.clusterKey);if(previous&&String(previous.productId)!==String(link.product.id))fail('Привязка зарезервированного SKU изменилась. Проверьте резерв вручную.');}
 if(active.length&&sameLines(active[0].lines,lines))return {changed:false,status:'reserved',message:'Товар зарезервирован до отгрузки'};
 for(const d of active){cancelDraft(state,d.id,now);for(const r of state.reservations.filter(r=>r.draftId===d.id))r.autoSuperseded=true;}
 const matches=draftGroups(state).filter(d=>d.account===account.id&&d.status==='reserved'&&!d.orderId&&sameLines(d.lines,lines));
 if(matches.length>1)fail('Несколько планов совпадают с заявкой. Выберите план вручную.');
 const draft=matches[0]||createDraft(state,{id:'ozon-reserve-'+uid(account.id,hash,orderId,owned.length),title:'Заявка Ozon '+orderId,lines},resolve,account.id,now).draft;
 for(const r of draft.rows)Object.assign(r,{orderId,autoOzonSupply:true,supplyClientHash:hash,updatedAt:now});
 return {changed:true,state,status:'reserved',message:'Товар зарезервирован до отгрузки'};
}
export async function runSupplyReservations(account,source,{transact=transaction,readContext=readWarehouseContext,persist=persistFboOperation,now=Date.now(),writesEnabled=config.writesEnabled}={}){
 if(!writesEnabled||!source?.payload||source.last_error||!Number(source.updated_at)||Number(source.updated_at)>now+60000||now-Number(source.updated_at)>30*60000||source.client_id&&source.client_id!==account.clientId)return;
 await transact(async client=>{
  const context=await readContext(client,account.id,{lock:true});if(!context.ready)return;
  let changed=false;const results=[];
  for(const orderId of [...new Set((source.payload.supplies||[]).map(s=>String(s.orderId)))].sort()){
   try{const result=reserveSupplyOrder(context,source.payload,account,orderId,now);if(result.changed){context.state=result.state;changed=true;}if(result.status!=='unchanged')results.push({orderId,status:result.status,message:result.message||'Уже учтено'});}catch(error){results.push({orderId,status:'attention',message:String(error.message||'Проверьте резерв заявки').slice(0,250)});}
  }
  const state=context.state,old=state.settings?.fboSupplyReservations?.[account.id],report={sourceAt:Number(source.updated_at),results:results.slice(-100)};
  if(!changed&&JSON.stringify(old)===JSON.stringify(report))return;
  state.settings||={};state.settings.fboSupplyReservations={...state.settings.fboSupplyReservations,[account.id]:report};
  await persist(client,context,{source:'fbo-supply-reserve'});
 });
}
