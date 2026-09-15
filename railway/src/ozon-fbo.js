import express from 'express';
import { pool } from './db.js';
import { credentialFor } from './connections.js';
import { asyncRoute, requireTrustedOrigin } from './http.js';
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
export async function fetchPostings(credentials,from,to){
 const rows=[];let offset=0;
 for(let page=0;page<100;page++){
  const data=await request(credentials,'/v2/posting/fbo/list',{dir:'ASC',filter:{since:from,to,status:''},limit:1000,offset,translit:false,with:{analytics_data:true,financial_data:true}});
  const result=Array.isArray(data.result)?data.result:data.result?.postings;
  if(!Array.isArray(result))throw new Error('Ozon: неизвестный формат отправлений ФБО');
  rows.push(...result);if(result.length<1000)return [...new Map(rows.map(x=>[x.posting_number,x])).values()];
  offset+=result.length;
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
export async function fetchFinance(credentials,from,to){
 const rows=[];let start=new Date(from),end=new Date(to);
 while(start<end){
  const next=new Date(Date.UTC(start.getUTCFullYear(),start.getUTCMonth()+1,1));
  const stop=new Date(Math.min(next.getTime()-1,end.getTime()));
  for(let page=1;page<=100;page++){
   const data=await request(credentials,'/v3/finance/transaction/list',{filter:{date:{from:start.toISOString(),to:stop.toISOString()},operation_type:[],posting_number:'',transaction_type:'all'},page,page_size:1000});
   const result=data.result;
   if(!Array.isArray(result?.operations))throw new Error('Ozon: неизвестный формат финансов');
   rows.push(...result.operations);
   if(page>=Number(result.page_count||1))break;
   if(page===100)throw new Error('Ozon: превышен лимит страниц финансов');
  }start=next;
 }
 return [...new Map(rows.map(x=>[String(x.operation_id),x])).values()];
}
async function run(){
 await ensureTable();const results=[];
 for(const account of await accounts()){
  const previous=(await pool.query('SELECT payload FROM ozon_fbo_cache WHERE account=$1',[account.id])).rows[0]?.payload||{};
  let credentials;
  try{credentials=JSON.parse(await credentialFor(account.id));if(!credentials.clientId||!credentials.apiKey)throw new Error('missing');}catch{results.push({account:account.id,error:'Проверьте Client ID и API-ключ'});continue;}
  const to=new Date().toISOString(),from=new Date(Date.now()-30*86400000).toISOString();
  const payload={...previous,account:account.id,label:account.label,scheme:'FBO',attemptAt:Date.now(),errors:{}};
  for(const [key,fn] of [['postings',()=>fetchPostings(credentials,from,to)],['stocks',()=>fetchStocks(credentials)],['finance',()=>fetchFinance(credentials,from,to)]]){
   try{payload[key]={rows:await fn(),updatedAt:Date.now(),from,to};}
   catch(e){payload.errors[key]=String(e.message||e);}
  }
  await pool.query('INSERT INTO ozon_fbo_cache(account,payload,updated_at) VALUES($1,$2::jsonb,$3) ON CONFLICT(account) DO UPDATE SET payload=EXCLUDED.payload,updated_at=EXCLUDED.updated_at',[account.id,JSON.stringify(payload),Date.now()]);
  const result={account:account.id,postings:payload.postings?.rows?.length||0,stocks:payload.stocks?.rows?.length||0,finance:payload.finance?.rows?.length||0,errors:payload.errors};
  results.push(result);console.info('Ozon FBO sync',JSON.stringify(result));
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
ozonRouter.post('/ozon-sync-now',asyncRoute(async(_req,res)=>{syncOzon().catch(e=>console.error('Ozon FBO sync failed',String(e.message||e)));res.status(202).json({ok:true,syncing:true});}));
