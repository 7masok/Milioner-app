import { createHash } from 'node:crypto';
import { pool } from './db.js';
import { config } from './config.js';
import { credentialFor } from './connections.js';
import { wbObservedExchangeRate } from './wb-price-profit.js';

const HOUR=3600000,DAY=86400000;
const object=v=>{if(v&&typeof v==='object')return v;try{return JSON.parse(v||'{}')}catch{return {}}};
const text=v=>String(v??'').trim();
const scopeFor=token=>createHash('sha256').update(token).digest('hex');
const tokenFor=market=>credentialFor(market,market==='WB2'?config.wbToken2:config.wbToken);
const localDate=now=>new Date(now+5*HOUR).toISOString().slice(0,10);
export function wbTariffNumber(value){
  const s=text(value).replace(/\s/g,'').replace(',','.');
  return s!==''&&Number.isFinite(Number(s))&&Number(s)>=0?Number(s):null;
}
export function normalizeWbDeliveryTariffs(data){
  const rows=data?.response?.data?.warehouseList;
  if(!Array.isArray(rows)||!rows.length)throw new Error('WB не вернул тарифы складов');
  const warehouses=rows.filter(r=>text(r.warehouseName)).map(r=>({
    id:JSON.stringify([text(r.geoName),text(r.warehouseName)]),name:text(r.warehouseName),country:text(r.geoName),
    fbs:{base:wbTariffNumber(r.boxDeliveryMarketplaceBase),liter:wbTariffNumber(r.boxDeliveryMarketplaceLiter),coefficient:wbTariffNumber(r.boxDeliveryMarketplaceCoefExpr)},
    fbw:{base:wbTariffNumber(r.boxDeliveryBase),liter:wbTariffNumber(r.boxDeliveryLiter),coefficient:wbTariffNumber(r.boxDeliveryCoefExpr)}
  })).filter((r,i,a)=>a.findIndex(x=>x.id===r.id)===i);
  if(!warehouses.length)throw new Error('WB не вернул тарифы складов');
  return warehouses;
}
export function wbTariffRetryAt(headers,now){
  return Math.max(now+HOUR+5000,...['retry-after','x-ratelimit-retry'].map(key=>{
    const raw=headers?.get?.(key);if(!text(raw))return 0;
    return Number.isFinite(Number(raw))?now+Math.max(0,Number(raw))*1000:Date.parse(raw)||0;
  }));
}
export async function syncWbDeliveryTariffs(market,{client=pool,token,fetcher=fetch,now=Date.now()}={}){
  token=token??await tokenFor(market);if(!token)return;
  const scope=scopeFor(token),db=await client.connect();
  try{
    await db.query('BEGIN');
    const lock=await db.query('SELECT pg_try_advisory_xact_lock(730145,hashtext($1)) AS locked',[scope]);
    if(!lock.rows[0]?.locked){await db.query('ROLLBACK');return;}
    await db.query('INSERT INTO wb_delivery_tariffs(scope) VALUES($1) ON CONFLICT DO NOTHING',[scope]);
    const state=(await db.query('SELECT * FROM wb_delivery_tariffs WHERE scope=$1 FOR UPDATE',[scope])).rows[0];
    if(Number(state?.next_allowed_at)>now){await db.query('COMMIT');return;}
    // Reserve before any upstream work; persists through restarts and is shared by shops.
    await db.query('UPDATE wb_delivery_tariffs SET next_allowed_at=$2 WHERE scope=$1',[scope,now+HOUR+5000]);
    await db.query('COMMIT');
    try{
      const response=await fetcher('https://common-api.wildberries.ru/api/v1/tariffs/box?date='+localDate(now),{
        headers:{Accept:'application/json',Authorization:token},signal:AbortSignal.timeout(25000)
      });
      const retryAt=wbTariffRetryAt(response.headers,now);
      if(!response.ok){
        const error=new Error(response.status===401||response.status===403?'Нет доступа к тарифам WB: проверьте категорию токена «Тарифы»':'Тарифы WB: HTTP '+response.status);
        error.retryAt=retryAt;throw error;
      }
      const warehouses=normalizeWbDeliveryTariffs(await response.json());
      await db.query(`UPDATE wb_delivery_tariffs SET payload=$2::jsonb,fetched_at=$3,next_allowed_at=$4,last_error='' WHERE scope=$1`,
        [scope,JSON.stringify({warehouses,date:localDate(now)}),now,retryAt]);
    }catch(error){
      // Never persist an upstream response body or a token in errors.
      const message=/^(Нет доступа к тарифам WB|Тарифы WB: HTTP|WB не вернул)/.test(error.message)?error.message:'Не удалось обновить тарифы WB';
      await db.query('UPDATE wb_delivery_tariffs SET last_error=$2,next_allowed_at=GREATEST(next_allowed_at,$3) WHERE scope=$1',[scope,message,error.retryAt||now+HOUR+5000]);
    }
  }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error}finally{db.release()}
}
export async function loadWbDeliveryTariffs(market,client=pool,now=Date.now(),token){
  token=token??await tokenFor(market);
  const [tariff,catalog,orders]=await Promise.all([
    client.query('SELECT payload,fetched_at,next_allowed_at,last_error FROM wb_delivery_tariffs WHERE scope=$1',[scopeFor(token||'unconfigured')]),
    client.query('SELECT payload,fetched_at FROM wb_card_group_snapshots WHERE market=$1',[market]),
    client.query('SELECT order_id,creation_date,raw_json FROM marketplace_order_lines WHERE market=$1 AND creation_date >= $2 ORDER BY creation_date DESC LIMIT 1000',[market,now-7*DAY])
  ]);
  const state=tariff.rows[0]||{},cards=catalog.rows[0]||{},payload=object(state.payload);
  return {ok:true,warehouses:payload.warehouses||[],date:payload.date||'',fetchedAt:Number(state.fetched_at)||0,
    retryAt:Number(state.next_allowed_at)||0,lastError:state.last_error||(!token?'Токен WB не настроен':''),
    cards:((object(cards.payload).cards)||[]).map(c=>({nmId:text(c.nmId),dimensions:c.dimensions||null})),
    cardsFetchedAt:Number(cards.fetched_at)||0,fx:wbObservedExchangeRate(orders.rows,now)};
}
let timer,running=false;
export function startWbDeliveryTariffLoop(){
  if(timer)return;
  const run=async()=>{
    if(running||!config.marketSyncEnabled)return;running=true;
    try{for(const market of ['WB','WB2'])await syncWbDeliveryTariffs(market)}
    catch{console.warn('WB delivery tariff cache update failed')}finally{running=false}
  };
  setTimeout(run,20000).unref();timer=setInterval(run,60000);timer.unref();
}
