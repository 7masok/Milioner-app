import express from 'express';
import { pool } from './db.js';
import { credentialFor } from './connections.js';
import { asyncRoute, requireTrustedOrigin } from './http.js';
import { buildOzonReplenishmentRows, mergeAnalyticsCycleRows } from './ozon-replenishment.js';
export const ozonRouter=express.Router();
let ready, running;
function ensureTable(){return ready ||= pool.query('CREATE TABLE IF NOT EXISTS ozon_fbo_cache (account TEXT PRIMARY KEY, payload JSONB NOT NULL, updated_at BIGINT NOT NULL)').catch(e=>{ready=null;throw e});}
async function accounts(){return (await pool.query("SELECT id,label FROM marketplace_credentials WHERE provider='OZON' AND enabled=1 AND encrypted_token IS NOT NULL")).rows;}
async function request(credentials,path,body){
 for(let attempt=0;attempt<3;attempt++){
  const response=await fetch('https://api-seller.ozon.ru'+path,{method:'POST',headers:{'Content-Type':'application/json','Client-Id':credentials.clientId,'Api-Key':credentials.apiKey},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
  if((response.status===429||response.status>=500)&&attempt<2){await new Promise(r=>setTimeout(r,1000*(attempt+1)));continue;}
  if(!response.ok){const detail=await response.json().catch(()=>({}));const reason=String(detail.message||detail.error?.message||'').replaceAll(String(credentials.apiKey),'[hidden]').replaceAll(String(credentials.clientId),'[hidden]').slice(0,300);const e=new Error('Ozon '+path+': HTTP '+response.status+(reason?' · '+reason:''));e.status=502;throw e;}
  const data=await response.json();if(data.error)throw new Error('Ozon '+path+': ошибка ответа');return data;
 }
}

const ANALYTICS_CHUNK_SIZE=100;
const ANALYTICS_RETRY_FALLBACK_MS=15*60*1000;

function retryAtFromHeaders(headers,now=Date.now()){
 const values=[];
 const retryAfter=String(headers?.get?.('retry-after')||'').trim();
 if(retryAfter){
  const numeric=Number(retryAfter);
  if(Number.isFinite(numeric)&&numeric>=0)values.push(now+numeric*1000);
  else{const parsed=Date.parse(retryAfter);if(Number.isFinite(parsed))values.push(parsed);}
 }
 const itemRetry=Number(headers?.get?.('item-retry-after'));
 if(Number.isFinite(itemRetry)&&itemRetry>=0)values.push(now+itemRetry*60*1000);
 const reset=Number(headers?.get?.('x-ratelimit-retry'));
 if(Number.isFinite(reset)&&reset>0)values.push(reset>1e12?reset:reset>1e9?reset*1000:now+reset*1000);
 return values.length?Math.max(...values):0;
}

async function requestAnalyticsStocksChunk(credentials,skus){
 const started=Date.now();
 const response=await fetch('https://api-seller.ozon.ru/v1/analytics/stocks',{
  method:'POST',
  headers:{'Content-Type':'application/json','Client-Id':credentials.clientId,'Api-Key':credentials.apiKey},
  body:JSON.stringify({skus}),
  signal:AbortSignal.timeout(30000)
 });
 const retryAt=retryAtFromHeaders(response.headers,started);
 const data=await response.json().catch(()=>({}));
 if(!response.ok){
  const reason=String(data?.message||data?.error?.message||data?.error||'')
    .replaceAll(String(credentials.apiKey),'[hidden]').replaceAll(String(credentials.clientId),'[hidden]').slice(0,300);
  const error=new Error('Ozon /v1/analytics/stocks: HTTP '+response.status+(reason?' · '+reason:''));
  error.status=response.status;
  error.retryAt=response.status===429?(retryAt||Date.now()+ANALYTICS_RETRY_FALLBACK_MS):0;
  throw error;
 }
 const items=Array.isArray(data?.items)?data.items:Array.isArray(data?.result?.items)?data.result.items:null;
 if(!items)throw new Error('Ozon /v1/analytics/stocks: неизвестный формат ответа');
 return {items,retryAt};
}

function analyticsSkus(stockRows){
 const values=[];
 for(const row of Array.isArray(stockRows)?stockRows:[]){
  for(const stock of row?.stocks||[]){
   const sku=String(stock?.sku||'').trim();
   if(sku)values.push(sku);
  }
 }
 return [...new Set(values)].sort((a,b)=>a.localeCompare(b,'en'));
}

export async function syncClusterAnalytics(credentials,previous,stockRows,supplyOrders,now=Date.now()){
 const skus=analyticsSkus(stockRows);
 const prev=previous&&typeof previous==='object'?previous:{};
 if(!skus.length){
  return {rows:[],workingRows:[],cursor:0,totalSkus:0,complete:true,updatedAt:now,attemptAt:now,nextAllowedAt:0,lastError:'',stale:false,
    replenishment:{targetDays:14,rows:[],updatedAt:now}};
 }
 if(Number(prev.nextAllowedAt||0)>now){
  const rows=Array.isArray(prev.rows)?prev.rows:[];
  return {...prev,totalSkus:skus.length,attemptAt:now,stale:true,
    replenishment:{targetDays:14,rows:buildOzonReplenishmentRows(rows,supplyOrders,{targetDays:14,now}),updatedAt:Number(prev.updatedAt||0)}};
 }
 const safeCursor=Math.max(0,Math.min(skus.length-1,Math.trunc(Number(prev.cursor)||0)));
 const cursor=(safeCursor>=skus.length?0:safeCursor);
 const chunk=skus.slice(cursor,cursor+ANALYTICS_CHUNK_SIZE);
 try{
  const result=await requestAnalyticsStocksChunk(credentials,chunk);
  const working=cursor===0?result.items:mergeAnalyticsCycleRows(prev.workingRows,result.items);
  const nextCursor=cursor+chunk.length;
  const cycleComplete=nextCursor>=skus.length;
  const rows=cycleComplete?working:(Array.isArray(prev.rows)?prev.rows:[]);
  const updatedAt=cycleComplete?now:Number(prev.updatedAt||0);
  const next={
   rows,
   workingRows:cycleComplete?[]:working,
   cursor:cycleComplete?0:nextCursor,
   totalSkus:skus.length,
   complete:cycleComplete,
   updatedAt,
   attemptAt:now,
   nextAllowedAt:Math.max(0,Number(result.retryAt||0)),
   lastError:'',
   stale:!cycleComplete&&rows.length>0,
   source:'/v1/analytics/stocks'
  };
  next.replenishment={targetDays:14,rows:buildOzonReplenishmentRows(rows,supplyOrders,{targetDays:14,now}),updatedAt};
  return next;
 }catch(error){
  const retryAt=Math.max(Number(error?.retryAt||0),error?.status===429?now+ANALYTICS_RETRY_FALLBACK_MS:now+10*60*1000);
  const rows=Array.isArray(prev.rows)?prev.rows:[];
  return {...prev,rows,totalSkus:skus.length,attemptAt:now,nextAllowedAt:retryAt,
   lastError:String(error?.message||error).slice(0,500),stale:true,
   replenishment:{targetDays:14,rows:buildOzonReplenishmentRows(rows,supplyOrders,{targetDays:14,now}),updatedAt:Number(prev.updatedAt||0)}};
 }
}
export async function fetchPostings(credentials,from,to){
 const rows=[];let cursor='';
 for(let page=0;page<100;page++){
  const data=await request(credentials,'/v3/posting/fbo/list',{sort_dir:'asc',cursor,filter:{since:from,to},limit:100,translit:false,with:{analytics_data:true,financial_data:true}});
  if(!Array.isArray(data.postings))throw new Error('Ozon: неизвестный формат отправлений ФБО');
  rows.push(...data.postings.map(p=>({...p,products:(p.products||[]).map(x=>({...x,price:typeof x.price==='object'?x.price.amount??x.price.value:x.price,currency_code:x.price?.currency||x.price?.currency_code||x.currency_code||x.currency||p.financial_data?.currency_code}))})));
  if(!data.has_next)return [...new Map(rows.map(x=>[x.posting_number,x])).values()];
  if(!data.cursor||data.cursor===cursor)throw new Error('Ozon: повтор курсора отправлений');cursor=data.cursor;
 }throw new Error('Ozon: превышен лимит страниц отправлений');
}
export async function fetchStocks(credentials){
 const rows=[];let cursor='';
 for(let page=0;page<100;page++){
  const data=await request(credentials,'/v4/product/info/stocks',{filter:{visibility:'ALL'},limit:1000,cursor});
  const result=data.result||data,items=result.items;
  if(!Array.isArray(items))throw new Error('Ozon: неизвестный формат остатков');
  rows.push(...items.map(x=>({...x,stocks:(x.stocks||[]).filter(s=>String(s.type).toLowerCase()==='fbo')})));
  const next=result.cursor||'';
  if(items.length<1000||!next)return rows;
  if(next===cursor)throw new Error('Ozon: повтор курсора остатков');cursor=next;
 }throw new Error('Ozon: превышен лимит страниц остатков');
}
const SUPPLY_STATES=['DATA_FILLING','READY_TO_SUPPLY','ACCEPTED_AT_SUPPLY_WAREHOUSE','IN_TRANSIT','ACCEPTANCE_AT_STORAGE_WAREHOUSE','REPORTS_CONFIRMATION_AWAITING','REPORT_REJECTED','COMPLETED','REJECTED_AT_SUPPLY_WAREHOUSE','CANCELLED','OVERDUE','SUPPLY_VARIANTS_ARRANGING','SUPPLY_VARIANTS_CONFIRMATION','TIMESLOT_BOOKING'];
export async function fetchSupplyOrders(credentials){
 const listed=await request(credentials,'/v3/supply-order/list',{filter:{states:SUPPLY_STATES},last_id:'',limit:100,sort_by:'ORDER_CREATION',sort_dir:'DESC'});
 const ids=(Array.isArray(listed.order_ids)?listed.order_ids:[]).map(String).filter(Boolean);
 if(!ids.length)return [];
 const rows=[];
 for(let offset=0;offset<ids.length;offset+=50){
  const data=await request(credentials,'/v3/supply-order/get',{order_ids:ids.slice(offset,offset+50)});
  if(!Array.isArray(data.orders))throw new Error('Ozon: неизвестный формат заявок FBO');
  rows.push(...data.orders);
 }
 return rows;
}
async function fetchSupplyBundle(credentials,bundleId){
 const rows=[];let lastId='';
 for(let page=0;page<100;page++){
  const data=await request(credentials,'/v1/supply-order/bundle',{bundle_ids:[String(bundleId)],last_id:lastId,limit:100,is_asc:true,sort_field:'SKU'});
  if(!Array.isArray(data.items))throw new Error('Ozon: неизвестный формат состава поставки');
  rows.push(...data.items);
  if(!data.has_next)return rows;
  const next=String(data.last_id||'');if(!next||next===lastId)throw new Error('Ozon: повтор курсора состава поставки');lastId=next;
 }
 throw new Error('Ozon: превышен лимит страниц состава поставки');
}
async function detailedSupplyOrder(credentials,orderId){
 const data=await request(credentials,'/v3/supply-order/get',{order_ids:[String(orderId)]});
 const order=Array.isArray(data.orders)?data.orders[0]:null;if(!order)throw new Error('Ozon: заявка FBO не найдена');
 const supplies=[];
 for(const supply of order.supplies||[]){
  let items=[];let error='';
  try{items=supply.bundle_id?await fetchSupplyBundle(credentials,supply.bundle_id):[];}catch(e){error=String(e.message||e);}
  supplies.push({...supply,items,bundle_error:error});
 }
 return {...order,supplies};
}
export function normalizeAccruals(accruals,date,types){
 const rows=[];
 for(let index=0;index<accruals.length;index++){
  const a=accruals[index],posting=a.posting||{};
  const add=(value,name,sku,kind='service')=>{
   if(value==null)return;
   if(typeof value!=='object'||!Number.isFinite(Number(value.amount)))throw new Error('Ozon: неизвестный формат суммы начисления');
   const amount=Number(value.amount);
   rows.push({operation_id:date+':'+String(a.accrual_id??index)+':'+rows.length,operation_date:date+'T12:00:00Z',operation_type_name:name,amount,currency_code:value.currency,accruals_for_sale:kind==='sale'?amount:0,sale_commission:kind==='commission'?amount:0,posting:{posting_number:posting.posting_number||''},items:sku?[{sku}]:[]});
  };
  for(const p of posting.products||[]){
   add(p.commission?.seller_price,'Продажа',p.sku,'sale');
   add(p.commission?.sale_commission,'Комиссия Ozon',p.sku,'commission');
   const delivery=p.delivery;
   if(delivery?.services?.length){for(const f of delivery.services)add(f.accrued,types.get(String(f.type_id))||'Доставка · '+f.type_id,p.sku);}
   else add(delivery?.total_accrued,'Доставка',p.sku);
  }
  for(const group of a.item_fees?.fees||[])for(const fee of group.fees||[])add(fee.accrued,types.get(String(fee.type_id))||'Услуга · '+fee.type_id,group.sku);
  const fee=a.non_item_fee;if(fee)add(fee.accrued,types.get(String(fee.type_id))||'Услуга · '+fee.type_id);
  if(!a.posting&&!a.item_fees&&!a.non_item_fee)throw new Error('Ozon: неизвестная категория начисления '+String(a.accrued_category));
 }
 return rows;
}
export async function fetchFinance(credentials,from,to){
 const typesData=await request(credentials,'/v1/finance/accrual/types',{});
 const types=new Map((typesData.accrual_types||[]).map(x=>[String(x.id),x.description||x.name]));
 const rows=[];const end=to.slice(0,10);
 for(let day=new Date(from.slice(0,10)+'T00:00:00Z');day.toISOString().slice(0,10)<=end;day.setUTCDate(day.getUTCDate()+1)){
  const date=day.toISOString().slice(0,10);let cursor='';const raw=[];
  for(let page=0;page<200;page++){
   const data=await request(credentials,'/v1/finance/accrual/by-day',{date,last_id:cursor});
   if(!Array.isArray(data.accruals))throw new Error('Ozon: неизвестный формат начислений');
   raw.push(...data.accruals);
   const next=data.last_id||'';if(!next||!data.accruals.length)break;
   if(next===cursor||page===199)throw new Error('Ozon: не завершена загрузка начислений за '+date);
   cursor=next;await new Promise(r=>setTimeout(r,300));
  }
  rows.push(...normalizeAccruals(raw,date,types));
  await new Promise(r=>setTimeout(r,300));
 }
 return rows;
}
async function run(){
 await ensureTable();const results=[];
 for(const account of await accounts()){
  const previous=(await pool.query('SELECT payload FROM ozon_fbo_cache WHERE account=$1',[account.id])).rows[0]?.payload||{};
  let credentials;
  try{credentials=JSON.parse(await credentialFor(account.id));if(!credentials.clientId||!credentials.apiKey)throw new Error('missing');}catch{results.push({account:account.id,error:'Проверьте Client ID и API-ключ'});continue;}
  const to=new Date().toISOString(),from=new Date(Date.now()-30*86400000).toISOString();
  const payload={...previous,account:account.id,label:account.label,scheme:'FBO',attemptAt:Date.now(),errors:{}};
  for(const [key,fn] of [['postings',()=>fetchPostings(credentials,from,to)],['stocks',()=>fetchStocks(credentials)],['finance',()=>fetchFinance(credentials,from,to)],['supplies',()=>fetchSupplyOrders(credentials)]]){
   try{payload[key]={rows:await fn(),updatedAt:Date.now(),from,to};}
   catch(e){payload.errors[key]=String(e.message||e);}
  }
  payload.analytics=await syncClusterAnalytics(credentials,previous.analytics,payload.stocks?.rows||[],payload.supplies?.rows||[],Date.now());
  if(payload.analytics?.lastError)payload.errors.analytics=payload.analytics.lastError;
  await pool.query('INSERT INTO ozon_fbo_cache(account,payload,updated_at) VALUES($1,$2::jsonb,$3) ON CONFLICT(account) DO UPDATE SET payload=EXCLUDED.payload,updated_at=EXCLUDED.updated_at',[account.id,JSON.stringify(payload),Date.now()]);
  const result={account:account.id,postings:payload.postings?.rows?.length||0,stocks:payload.stocks?.rows?.length||0,finance:payload.finance?.rows?.length||0,supplies:payload.supplies?.rows?.length||0,
   analytics:payload.analytics?.rows?.length||0,analyticsComplete:Boolean(payload.analytics?.complete),analyticsStale:Boolean(payload.analytics?.stale),errors:payload.errors};
  results.push(result);if(result.error||Object.keys(result.errors||{}).length)console.warn('Ozon FBO sync issue',JSON.stringify(result));
 }
 return {ok:results.every(x=>!x.error&&!Object.keys(x.errors||{}).length),results};
}
export function syncOzon(){if(!running)running=run().finally(()=>{running=null});return running;}
export function startOzonSyncLoop(){const tick=()=>syncOzon().catch(e=>console.error('Ozon FBO sync failed',String(e.message||e)));setTimeout(tick,5000).unref();setInterval(tick,10*60*1000).unref();}
ozonRouter.use(requireTrustedOrigin);
ozonRouter.get('/ozon-fbo',asyncRoute(async(_req,res)=>{
 await ensureTable();const configured=await accounts();
 const rows=(await pool.query('SELECT payload FROM ozon_fbo_cache')).rows;
 const allowed=new Set(configured.map(x=>x.id));
 res.json({ok:true,configured:configured.length>0,syncing:Boolean(running),accounts:rows.map(x=>x.payload).filter(x=>allowed.has(x.account))});
}));
ozonRouter.get('/ozon-supply-order',asyncRoute(async(req,res)=>{
 const accountId=String(req.query.account||''),orderId=String(req.query.orderId||'');
 if(!accountId||!orderId)return res.status(400).json({ok:false,error:'Нужны account и orderId'});
 const configured=(await accounts()).find(x=>String(x.id)===accountId);if(!configured)return res.status(404).json({ok:false,error:'Ozon магазин не найден'});
 const credentials=JSON.parse(await credentialFor(accountId));
 const order=await detailedSupplyOrder(credentials,orderId);
 res.json({ok:true,account:accountId,label:configured.label,order});
}));
ozonRouter.post('/ozon-sync-now',asyncRoute(async(_req,res)=>{syncOzon().catch(e=>console.error('Ozon FBO sync failed',String(e.message||e)));res.status(202).json({ok:true,syncing:true});}));
