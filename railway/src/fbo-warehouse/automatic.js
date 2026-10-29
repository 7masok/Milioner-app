import crypto from 'node:crypto';
import {pool,transaction} from '../db.js';
import {config} from '../config.js';
import {readWarehouseContext,persistFboOperation} from './store.js';
import {resolver,createDraft,dispatchDraft,draftGroups,fail} from './core.js';
import {remoteForOrder} from './remote.js';
import {mirrorFboProducts} from './legacy.js';
import {stockLedgerViolation} from '../warehouse-ledger.js';

const CONFIRMED=new Set(['ACCEPTED_AT_SUPPLY_WAREHOUSE','IN_TRANSIT','ACCEPTANCE_AT_STORAGE_WAREHOUSE','ACCEPTED_AT_STORAGE_WAREHOUSE','REPORTS_CONFIRMATION_AWAITING','REPORT_REJECTED','COMPLETED']);
const PREPARING=new Set(['DATA_FILLING','READY_TO_SUPPLY','TIMESLOT_BOOKING','SUPPLY_VARIANTS_ARRANGING']);
const fresh=(s,now)=>!!s?.payload&&!s.last_error&&Number.isFinite(Number(s.updated_at))&&Number(s.updated_at)>0&&Number(s.updated_at)<=now+60000&&now-Number(s.updated_at)<=30*60000;
export function historicalOrders(payload){
 const ids=new Set();for(const s of payload?.supplies||[])if(!PREPARING.has(s.orderState||s.state)||!PREPARING.has(s.state))ids.add(String(s.orderId));return [...ids];
}
export async function readAutoAccounting(db=pool,account='',clientId=''){
 const row=(await db.query('SELECT client_id,enabled,enabled_at,checked_at,last_results FROM fbo_auto_accounting WHERE account=$1',[account])).rows[0];
 if(clientId&&row?.client_id!==clientId)return {enabled:false,enabledAt:0,checkedAt:0,results:[]};
 return {enabled:row?.enabled===true&&(!clientId||row.client_id===clientId),enabledAt:Number(row?.enabled_at)||0,checkedAt:Number(row?.checked_at)||0,results:Array.isArray(row?.last_results)?row.last_results:[]};
}
export async function setAutoAccounting(account,source,enabled,{transact=transaction,now=Date.now()}={}){
 if(enabled&&!fresh(source,now))fail('Сначала дождитесь свежего снимка Ozon. Старые отправки нужно отделить от новых.');
 await transact(async client=>{
  await client.query('SELECT pg_advisory_xact_lock($1)',[730021]);
  const old=(await client.query('SELECT enabled,client_id FROM fbo_auto_accounting WHERE account=$1 FOR UPDATE',[account.id])).rows[0];
  if(old?.enabled===enabled&&old?.client_id===account.clientId)return;
  await client.query(`INSERT INTO fbo_auto_accounting(account,enabled,enabled_at,excluded_orders,client_id,checked_at,last_results) VALUES($1,$2,$3,$4,$5,0,'[]') ON CONFLICT(account) DO UPDATE SET client_id=EXCLUDED.client_id,enabled=EXCLUDED.enabled,enabled_at=EXCLUDED.enabled_at,excluded_orders=EXCLUDED.excluded_orders,checked_at=0,last_results='[]'`,[account.id,enabled,now,enabled?historicalOrders(source.payload):[],account.clientId]);
 });return {ok:true,enabled};
}
// Work on a clone: an incomplete composition, ambiguous link or stock shortage
// must not reserve a partial order or consume any lot.
export function accountAutomaticOrder(context,payload,account,orderId,now=Date.now()){
 const remote=remoteForOrder({payload},orderId),before=context.state;
 if(remote.lines.some(l=>['name:','name:undefined','name:null','id:0'].includes(l.clusterKey)))fail('Не определён кластер заявки. Проверьте сопоставление.');
 const records=Object.entries(before.settings?.ozonFboTransfers||{}).filter(([k,t])=>String(t.account||k.split('|')[0])===account&&
  (String(t.orderId||k.split('|')[1])===orderId||remote.lines.some(l=>String(t.supplyId||k.split('|')[2])===l.supplyId&&String(t.sku||k.split('|')[4])===l.sku)));
 if(records.length){
  const complete=remote.lines.every(l=>records.some(([k,t])=>String(t.supplyId||k.split('|')[2])===l.supplyId&&String(t.sku||k.split('|')[4])===l.sku&&Number(t.qty)===l.qty));
  if(!complete)fail('Поставка уже учтена частично или состав изменился. Проверьте вручную.');
  return {changed:false};
 }
 const state=structuredClone(before),resolve=resolver(state,context.stockRows),groups=new Map();
 for(const l of remote.lines){const key=l.sku+'|'+l.clusterKey;const own=groups.get(key)||{sku:l.sku,clusterKey:l.clusterKey,cluster:l.warehouse,qty:0};own.qty+=l.qty;groups.set(key,own)}
 const id='auto-fbo-'+crypto.createHash('sha256').update(account+'|'+orderId).digest('hex').slice(0,40);
 const lines=[...groups.values()],matches=draftGroups(state).filter(d=>d.account===account&&d.status==='reserved'&&d.lines.length===lines.length&&d.lines.every(l=>lines.some(x=>x.sku===l.sku&&x.clusterKey===l.clusterKey&&x.qty===l.qty)));
 if(matches.length>1)fail('Несколько планов совпадают с заявкой. Выберите план вручную.');
 const draftId=matches[0]?.id||id;if(!matches.length)createDraft(state,{id,title:'Авто · заявка '+orderId,lines},resolve,account,now);
 const result=dispatchDraft(state,draftId,remote,now),violation=stockLedgerViolation(before,state);if(violation)fail('Списание не согласовано с журналом склада.');
 return {changed:true,state,draft:result.draft};
}
export async function runAutoAccounting(account,source,{db=pool,transact=transaction,readContext=readWarehouseContext,persist=persistFboOperation,mirror=mirrorFboProducts,now=Date.now(),writesEnabled=config.writesEnabled}={}){
 if(!writesEnabled||!fresh(source,now))return;
 const prefs=await readAutoAccounting(db,account.id,account.clientId);if(!prefs.enabled||Number(source.updated_at)<=prefs.enabledAt)return;
 const excluded=new Set((await db.query('SELECT excluded_orders FROM fbo_auto_accounting WHERE account=$1',[account.id])).rows[0]?.excluded_orders||[]);
 const ids=[...new Set((source.payload.supplies||[]).map(s=>String(s.orderId)))].filter(id=>!excluded.has(id)),results=[];
 for(const orderId of ids){
  // Ineligible/preparation and incomplete orders do not invoke warehouse writes.
  if(!(source.payload.supplies||[]).some(s=>String(s.orderId)===orderId&&!['CANCELLED','REJECTED_AT_SUPPLY_WAREHOUSE','OVERDUE'].includes(s.orderState||s.state)&&(CONFIRMED.has(s.state)||CONFIRMED.has(s.orderState))))continue;
  await transact(async client=>{
   await client.query('SELECT pg_advisory_xact_lock($1)',[730021]);
   const row=(await client.query('SELECT * FROM fbo_auto_accounting WHERE account=$1 FOR UPDATE',[account.id])).rows[0];
   if(!row?.enabled||row.client_id!==account.clientId||Number(source.updated_at)<=Number(row.enabled_at)||(row.excluded_orders||[]).includes(orderId))return;
   const context=await readContext(client,account.id,{lock:true,movements:true});if(!context.ready)return;
   let result;
   try{result=accountAutomaticOrder(context,source.payload,account.id,orderId,now)}catch(error){results.push({orderId,status:'attention',message:String(error.message||'Не удалось учесть поставку').slice(0,250)});return}
   if(result.changed){
    const originalIds=new Set((context.state.movements||[]).map(m=>m.id));context.state=result.state;
    const movements=result.state.movements.filter(m=>!originalIds.has(m.id));
    await persist(client,context,{products:true,purchases:true,movements,source:'fbo-automatic'});
    const changed=new Set(result.draft.rows.map(r=>r.productId));await mirror(client,result.state.products.filter(p=>changed.has(String(p.id))));
   }
   await client.query('UPDATE fbo_auto_accounting SET excluded_orders=array_append(excluded_orders,$2) WHERE account=$1',[account.id,orderId]);
   results.push({orderId,status:result.changed?'accounted':'already',message:result.changed?'Отправка списана со склада':'Уже учтено, повторного списания нет'});
  });
 }
 await db.query('UPDATE fbo_auto_accounting SET checked_at=$2,last_results=$3::jsonb WHERE account=$1 AND enabled AND enabled_at=$4 AND client_id=$5',[account.id,now,JSON.stringify(results.slice(-50)),prefs.enabledAt,account.clientId]);
}
