import {pool} from './db.js';
import {config} from './config.js';
import {credentialFor} from './connections.js';
import {hydrateWarehouseProducts} from './warehouse-products.js';
import {normalizeHistory,mergeHistory,combineOrders,orderPage} from './wb3-order-model.js';

const CADENCE=35*60_000, PAGE_DELAY=65_000;
function retryDelay(headers) {
  return Math.max(PAGE_DELAY,...['retry-after','x-ratelimit-retry','x-ratelimit-reset'].map(name=>{
    const raw=headers.get(name),n=Number(raw);
    if(n>1e12)return n-Date.now();
    if(n>1e9)return n*1000-Date.now();
    if(n>0)return n*1000;
    return Math.max(0,Date.parse(raw)-Date.now())||0;
  }));
}
async function request(url,token,body) {
  const response=await fetch(url,{method:body?'POST':'GET',headers:{Authorization:token,Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30_000)});
  const text=await response.text();
  if(!response.ok){const error=new Error(response.status===429?'Лимит WB':response.status===403?'В API-ключе нужен доступ «'+(body?'Аналитика':'Статистика')+'»':'Заказы WB: HTTP '+response.status);error.delay=retryDelay(response.headers);throw error;}
  const data=text?JSON.parse(text):[];
  return {data,delay:response.headers.get('x-ratelimit-remaining')==='0'?retryDelay(response.headers):PAGE_DELAY};
}
async function syncSource(source,token) {
  const client=await pool.connect(),lock='inferno:orders:'+source;let locked=false;
  try {
    locked=Boolean((await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked',[lock])).rows[0].locked);
    if(!locked)return {source,skipped:true};
    const previous=(await client.query('SELECT * FROM wb3_order_history_sync WHERE source=$1',[source])).rows[0]||{};
    const now=Date.now();if(Number(previous.next_allowed_at)>now)return {source,skipped:true,nextAt:Number(previous.next_allowed_at),error:previous.last_error};
    const cursor=previous.cursor||{};
    try {
      let rows,next={},currency='',delay=PAGE_DELAY;
      if(source==='statistics') {
        const dateFrom=cursor.dateFrom||new Date(now-89*86400000).toISOString();
        const result=await request('https://statistics-api.wildberries.ru/api/v1/supplier/orders?'+new URLSearchParams({dateFrom,flag:'0'}),token);
        if(!Array.isArray(result.data))throw new Error('WB не вернул список заказов');
        rows=result.data;delay=result.delay;
        const latest=rows.reduce((max,row)=>String(row.lastChangeDate||'')>max?String(row.lastChangeDate):max,dateFrom);
        if(rows.length>=79000&&latest===dateFrom)throw new Error('WB повторяет страницу истории заказов');
        next={dateFrom:latest,more:rows.length>=79000};
      } else {
        const start=cursor.start||new Date(now-30*86400000).toISOString(),end=cursor.end||new Date(now).toISOString();
        const result=await request('https://seller-analytics-api.wildberries.ru/api/analytics/v1/order-feed',token,{selectedPeriod:{start,end},nmIds:[],subjectIds:[],brandNames:[],tagIds:[],pagination:{limit:10000,offset:Number(cursor.offset)||0,...(cursor.snapshotTime?{snapshotTime:cursor.snapshotTime}:{})}});
        const data=result.data?.data;if(!Array.isArray(data?.orders))throw new Error('WB не вернул ленту заказов');
        rows=data.orders;currency=String(data.currency||'');delay=result.delay;
        if(rows.length===10000){if(!data.snapshotTime)throw new Error('WB не вернул курсор ленты');next={start,end,offset:(Number(cursor.offset)||0)+rows.length,snapshotTime:data.snapshotTime,more:true};}
      }
      const normalized=rows.map(row=>normalizeHistory(row,source,currency));
      await client.query('BEGIN');
      // The two independent API sources can discover the same SRID at once.
      // Serialize insertion too: FOR UPDATE cannot lock a row that does not exist.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('inferno:order-history-write'))");
      for(const row of normalized){
        const old=(await client.query('SELECT payload FROM wb3_order_history WHERE srid=$1 FOR UPDATE',[row.srid])).rows[0]?.payload;
        const merged=mergeHistory(old,row);
        await client.query('INSERT INTO wb3_order_history(srid,creation_date,payload,updated_at) VALUES($1,$2,$3,$4) ON CONFLICT(srid) DO UPDATE SET creation_date=excluded.creation_date,payload=excluded.payload,updated_at=excluded.updated_at',[row.srid,merged.creationDate,JSON.stringify(merged),now]);
      }
      const nextAt=now+Math.max(delay,next.more?PAGE_DELAY:CADENCE);
      await client.query(`INSERT INTO wb3_order_history_sync(source,cursor,last_success_at,next_allowed_at,last_error,updated_at) VALUES($1,$2,$3,$4,'',$3) ON CONFLICT(source) DO UPDATE SET cursor=excluded.cursor,last_success_at=excluded.last_success_at,next_allowed_at=excluded.next_allowed_at,last_error='',updated_at=excluded.updated_at`,[source,JSON.stringify(next),now,nextAt]);
      await client.query('COMMIT');
      return {source,ok:true,items:normalized.length,nextAt,more:Boolean(next.more)};
    }catch(error){
      await client.query('ROLLBACK').catch(()=>{});
      const nextAt=now+Math.max(65*60_000,Number(error.delay)||0),message=String(error.message||error).slice(0,400);
      await client.query(`INSERT INTO wb3_order_history_sync(source,cursor,next_allowed_at,last_error,updated_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(source) DO UPDATE SET next_allowed_at=excluded.next_allowed_at,last_error=excluded.last_error,updated_at=excluded.updated_at`,[source,JSON.stringify(cursor),nextAt,message,now]);
      return {source,ok:false,error:message,nextAt};
    }
  }finally{if(locked)await client.query('SELECT pg_advisory_unlock(hashtext($1))',[lock]).catch(()=>{});client.release();}
}
export async function syncWb3OrderHistory() {
  if(config.storeProfile!=='WB3')return {skipped:true};
  const token=await credentialFor('WB');if(!token)return {ok:false,error:'Добавьте API-ключ WB в настройках'};
  const sources=await Promise.all(['statistics','feed'].map(source=>syncSource(source,token)));
  return {ok:sources.some(x=>x.ok),sources};
}
export function startWb3OrderHistoryLoop() {
  if(config.storeProfile!=='WB3')return;
  const run=()=>syncWb3OrderHistory().catch(error=>console.error('WB3 orders',String(error.message||error)));
  void run();const timer=setInterval(run,60_000);timer.unref();return timer;
}
export async function readWb3Orders({after=0,limit=500,cursor=''}={}) {
  const [native,history,warehouse,status]=await Promise.all([
    pool.query(`SELECT o.order_id AS "orderId",o.code,o.entry_id AS "entryId",o.status,o.state,o.creation_date AS "creationDate",o.sku,o.product_name AS "productName",o.qty,o.unit_price AS "unitPrice",o.total_price AS "totalPrice",o.updated_at AS "updatedAt",o.raw_json AS "rawJson",'WB' AS market FROM marketplace_order_lines o WHERE o.market='WB' AND o.creation_date >= $1`,[after]),
    pool.query('SELECT payload FROM wb3_order_history WHERE creation_date >= $1',[after]),
    pool.query('SELECT payload FROM warehouse_state WHERE id=1'),
    pool.query('SELECT source,last_success_at AS "lastSuccessAt",next_allowed_at AS "nextAt",last_error AS error,cursor FROM wb3_order_history_sync ORDER BY source')
  ]);
  const raw=warehouse.rows[0]?.payload,state=await hydrateWarehouseProducts(pool,typeof raw==='string'?JSON.parse(raw):raw||{});
  const rows=combineOrders(native.rows,history.rows.map(x=>x.payload),state.products||[]);
  return {ok:true,...orderPage(rows,cursor,limit),sync:status.rows.map(({cursor,...x})=>({...x,more:Boolean(cursor?.more)}))};
}
