import {pool} from './db.js';
import {config} from './config.js';
import {credentialFor} from './connections.js';
import {aggregateInventory,inventoryPage} from './wb3-inventory-model.js';
const CADENCE=15*60_000;
export async function readWb3Inventory(){
 const row=(await pool.query('SELECT payload,fetched_at AS "fetchedAt",last_error AS error,next_allowed_at AS "nextAt",updated_at AS "updatedAt" FROM wb_stock_snapshots WHERE market=$1',['WB'])).rows[0]||{};
 const {staging,...snapshot}=row.payload||{};
 return {ok:true,...snapshot,fetchedAt:Number(row.fetchedAt)||0,error:row.error||'',nextAt:Number(row.nextAt)||0,loading:Boolean(staging)};
}
export async function syncWb3Inventory(){
 if(config.storeProfile!=='WB3')return {skipped:true};
 const client=await pool.connect();let locked=false;
 try{
  locked=Boolean((await client.query("SELECT pg_try_advisory_lock(hashtext('inferno:inventory')) AS locked")).rows[0].locked);
  if(!locked)return {skipped:true};
  const old=(await client.query("SELECT * FROM wb_stock_snapshots WHERE market='WB'")).rows[0]||{},now=Date.now();
  if(Number(old.next_allowed_at)>now)return {skipped:true,nextAt:Number(old.next_allowed_at),error:old.last_error||''};
  const token=await credentialFor('WB');if(!token)return {ok:false,error:'Добавьте API-ключ WB'};
  const payload=old.payload||{},staging=payload.staging||{},offset=Number(staging.offset)||0;
  try{
   const response=await fetch('https://seller-analytics-api.wildberries.ru/api/analytics/v1/stocks-report/wb-warehouses',{method:'POST',headers:{Authorization:token,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({nmIds:[],chrtIds:[],limit:250000,offset}),signal:AbortSignal.timeout(45_000)});
   const raw=await response.text();let data;try{data=raw?JSON.parse(raw):{};}catch{throw new Error('WB вернул некорректный ответ по остаткам');}
   if(!response.ok){
    const message=response.status===403?'Для остатков FBO нужен Персональный или Сервисный ключ WB с категорией «Аналитика»':response.status===429?'Лимит WB по остаткам':response.status===401?'WB отклонил API-ключ':'Остатки WB: HTTP '+response.status;
    const error=new Error(message);error.status=response.status;
    const retry=Math.max(0,...['x-ratelimit-retry','retry-after','x-ratelimit-reset'].map(name=>{const n=Number(response.headers.get(name));return n>1e12?n-now:n>1e9?n*1000-now:n*1000||0;}));
    error.retryAt=now+Math.max(response.status===429?65_000:65*60_000,retry);throw error;
   }
   const rows=inventoryPage(data?.data?.items),all=inventoryPage([...(staging.rows||[]),...rows]);
   const more=data.data.items.length===250000,next=more?{...payload,staging:{offset:offset+250000,rows:all}}:aggregateInventory(all),fetchedAt=more?Number(old.fetched_at)||0:now,nextAt=now+(more?25_000:CADENCE);
   await client.query(`INSERT INTO wb_stock_snapshots(market,payload,fetched_at,last_error,updated_at,next_allowed_at) VALUES('WB',$1,$2,'',$3,$4) ON CONFLICT(market) DO UPDATE SET payload=excluded.payload,fetched_at=excluded.fetched_at,last_error='',updated_at=excluded.updated_at,next_allowed_at=excluded.next_allowed_at`,[JSON.stringify(next),fetchedAt,now,nextAt]);
   console.info('INFERNO_INVENTORY',JSON.stringify({ok:true,rows:all.length,total:next.total??null,toClient:next.toClient??null,more,fetchedAt,nextAt}));
   return {ok:true,total:next.total??null,more,nextAt};
  }catch(error){
   const message=String(error.message||error).slice(0,400),nextAt=Number(error.retryAt)||now+5*60_000;
   await client.query(`INSERT INTO wb_stock_snapshots(market,payload,fetched_at,last_error,updated_at,next_allowed_at) VALUES('WB','{"items":{}}',0,$1,$2,$3) ON CONFLICT(market) DO UPDATE SET last_error=excluded.last_error,updated_at=excluded.updated_at,next_allowed_at=excluded.next_allowed_at`,[message,now,nextAt]);
   console.warn('INFERNO_INVENTORY',JSON.stringify({ok:false,status:Number(error.status)||0,error:message,nextAt}));return {ok:false,error:message,nextAt};
  }
 }finally{if(locked)await client.query("SELECT pg_advisory_unlock(hashtext('inferno:inventory'))").catch(()=>{});client.release();}
}
export function startWb3InventoryLoop(){if(config.storeProfile!=='WB3')return;const run=()=>syncWb3Inventory().catch(e=>console.warn('INFERNO_INVENTORY',String(e.message||e)));setTimeout(run,3000).unref();setInterval(run,30_000).unref();}
