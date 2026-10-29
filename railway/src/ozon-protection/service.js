import {pool} from '../db.js';
import {config} from '../config.js';
import {credentialFor} from '../connections.js';
import {text,id,newJob,step} from './engine.js';
export const INTERVAL=15*60*1000,STEP_DELAY=5000;
const json=v=>typeof v==='string'?JSON.parse(v):v||{};
export async function withOzonProtectionLock(account,fn,db=pool){
 const c=await db.connect(),key='millioner:ozon-price-protection:'+account;let locked=false;
 try{locked=!!(await c.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked',[key])).rows[0]?.locked;if(!locked)throw Object.assign(Error('Ozon сейчас проверяет цены. Повторите через несколько секунд.'),{status:409});return await fn(c)}
 finally{if(locked)await c.query('SELECT pg_advisory_unlock(hashtext($1))',[key]).catch(()=>{});c.release()}
}
export async function protectionRows(account,db=pool){return(await db.query('SELECT * FROM ozon_price_protection WHERE account=$1 ORDER BY offer_id',[account])).rows}
export async function decorateOzonProtectionRows(rows,db=pool){
 const accounts=[...new Set(rows.map(r=>r.accountId).filter(Boolean))],byKey=new Map();
 for(const a of accounts)for(const p of await protectionRows(a,db))byKey.set(a+'|'+p.offer_id,p);
 return rows.map(r=>{const p=byKey.get(r.accountId+'|'+r.sku);return{...r,ozonProtection:p?{enabled:p.enabled,price:Number(p.protected_price),currency:p.currency,status:p.status,message:p.message,checkedAt:Number(p.checked_at),updatedAt:Number(p.updated_at)}:null}});
}
export function retryAt(response,now=Date.now()){
 const value=response.headers.get('retry-after'),seconds=Number(value),date=Number.isFinite(seconds)?NaN:Date.parse(value||'');
 return Math.max(now+STEP_DELAY,Number.isFinite(seconds)&&seconds>0?now+seconds*1000:0,Number.isFinite(date)?date:0);
}
export function createOzonRequester(credentials,fetcher=fetch){return async(path,body,method='POST')=>{
 const response=await fetcher('https://api-seller.ozon.ru'+path,{method,headers:{'Content-Type':'application/json','Client-Id':credentials.clientId,'Api-Key':credentials.apiKey},...(method==='GET'?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});
 const raw=await response.text();let data;try{data=JSON.parse(raw)}catch{if(response.ok)throw Object.assign(Error('Некорректный ответ Ozon'),{status:502})}
 if(!response.ok){let message=text(data?.message||data?.error?.message||'Ошибка API');for(const secret of [credentials.apiKey,credentials.clientId])if(secret)message=message.replaceAll(String(secret),'[hidden]');throw Object.assign(Error('Ozon: HTTP '+response.status+' · '+message.slice(0,300)),{status:response.status,retryAt:retryAt(response)})}
 if(!data||typeof data!=='object')throw Error('Ozon не вернул данные');return data;
}}
export async function runOzonProtectionAccount(account,{db=pool,request,now=Date.now()}={}){
 if(!config.writesEnabled)return{skipped:true};
 return withOzonProtectionLock(account,async c=>{
  const prefs=(await protectionRows(account,c)).filter(p=>p.enabled);if(!prefs.length)return{skipped:true};
  const sync=(await c.query('SELECT * FROM ozon_protection_sync WHERE account=$1',[account])).rows[0];if(Number(sync?.next_at)>now)return{skipped:true};
  let job=json(sync?.job);if(!job.tasks?.length)job=newJob(prefs);
  try{
   const send=request||createOzonRequester(JSON.parse(await credentialFor(account)));
   const out=await step(job,prefs,send),next=now+(out.done?INTERVAL:STEP_DELAY);
   await c.query('BEGIN');
   if(out.done)for(const p of prefs){const issues=out.job.issues[p.offer_id]||[];await c.query('UPDATE ozon_price_protection SET status=$3,message=$4,checked_at=$5 WHERE account=$1 AND offer_id=$2',[account,p.offer_id,issues.length?'attention':'checked',issues.join(' · ').slice(0,1600),now])}
   await c.query(`INSERT INTO ozon_protection_sync(account,next_at,job,last_error,updated_at) VALUES($1,$2,$3::jsonb,'',$4) ON CONFLICT(account) DO UPDATE SET next_at=EXCLUDED.next_at,job=EXCLUDED.job,last_error='',updated_at=EXCLUDED.updated_at`,[account,next,JSON.stringify(out.done?{}:out.job),now]);await c.query('COMMIT');return{done:out.done};
  }catch(e){
   await c.query('ROLLBACK').catch(()=>{});const next=Math.max(now+INTERVAL,Number(e.retryAt)||0,e.status===403?now+3600000:0),message=text(e.message).slice(0,1000);
   // Keep the original unexecuted task on an ambiguous response; operations are fixed and idempotent.
   await c.query(`INSERT INTO ozon_protection_sync(account,next_at,job,last_error,updated_at) VALUES($1,$2,$3::jsonb,$4,$5) ON CONFLICT(account) DO UPDATE SET next_at=EXCLUDED.next_at,job=EXCLUDED.job,last_error=EXCLUDED.last_error,updated_at=EXCLUDED.updated_at`,[account,next,JSON.stringify(job),message,now]);
   await c.query("UPDATE ozon_price_protection SET status='error',message=$2 WHERE account=$1 AND enabled",[account,message]);return{error:message};
  }
 },db);
}
export async function saveProtection(account,items,enabled,{db=pool,now=Date.now()}={}){
 if(!account||typeof enabled!=='boolean'||!Array.isArray(items)||!items.length||items.length>1000)throw Object.assign(Error('Выберите от 1 до 1000 товаров Ozon'),{status:400});
 const clean=items.map(row=>{
  const offer=text(row?.sku),product=text(row?.remoteId),price=Number(row?.price),currency=text(row?.currency);
  if(!/^[1-9]\d*$/.test(product)||!Number.isSafeInteger(Number(product))||!offer||offer.length>200||!Number.isFinite(price)||price<=0||price>1e12||Math.abs(price*100-Math.round(price*100))>.0001||!/^[A-Z]{3}$/.test(currency))throw Object.assign(Error('Проверьте артикул, цену защиты и валюту'),{status:400});
  return{offer,product,price,currency};
 });
 if(new Set(clean.map(p=>p.offer)).size!==clean.length||new Set(clean.map(p=>p.product)).size!==clean.length)throw Object.assign(Error('Повторяющиеся товары Ozon'),{status:400});
 return withOzonProtectionLock(account,async c=>{
  // Validate identities and currency against the server's Ozon snapshot, not client labels.
  const known=(await c.query('SELECT * FROM ozon_protection_catalog WHERE account=$1',[account])).rows;
  const previous=enabled?[]:await protectionRows(account,c);
  for(const p of clean)if(!known.some(r=>text(r.offer_id)===p.offer&&text(r.product_id)===p.product&&r.currency===p.currency&&now-Number(r.updated_at)<30*60000)&&!previous.some(r=>r.offer_id===p.offer))throw Object.assign(Error('Товар не найден в серверном снимке Ozon. Обновите данные.'),{status:409});
  await c.query('BEGIN');try{
   for(const p of clean)await c.query(`INSERT INTO ozon_price_protection(account,offer_id,product_id,enabled,protected_price,currency,status,message,checked_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,'',0,$8) ON CONFLICT(account,offer_id) DO UPDATE SET product_id=EXCLUDED.product_id,enabled=EXCLUDED.enabled,protected_price=EXCLUDED.protected_price,currency=EXCLUDED.currency,status=EXCLUDED.status,message='',checked_at=0,updated_at=EXCLUDED.updated_at`,[account,p.offer,p.product,enabled,p.price,p.currency,enabled?'pending':'off',now]);
   await c.query(`INSERT INTO ozon_protection_sync(account,next_at,job,last_error,updated_at) VALUES($1,0,'{}'::jsonb,'',$2) ON CONFLICT(account) DO UPDATE SET next_at=0,job='{}'::jsonb,last_error='',updated_at=EXCLUDED.updated_at`,[account,now]);await c.query('COMMIT');return{ok:true,enabled,count:clean.length};
  }catch(e){await c.query('ROLLBACK');throw e}
 },db);
}
let timer=null,running=false;
export function startOzonProtectionLoop(){if(timer)return;const run=async()=>{if(running||!config.writesEnabled)return;running=true;try{const accounts=(await pool.query("SELECT DISTINCT p.account FROM ozon_price_protection p JOIN marketplace_credentials c ON c.id=p.account WHERE p.enabled AND c.enabled=1 AND c.provider='OZON'")).rows;for(const a of accounts)try{await runOzonProtectionAccount(a.account)}catch(e){if(e.status!==409)console.error('Ozon protection unavailable',e.message)}}catch(e){console.error('Ozon protection loop unavailable',e.message)}finally{running=false}};timer=setInterval(run,STEP_DELAY);timer.unref();setTimeout(run,10000).unref()}

export async function rememberOzonCatalog(rows,db=pool){
 const valid=[...new Map(rows.filter(r=>!r.error&&r.accountId&&r.sku&&r.remoteId&&r.currency).map(r=>[r.accountId+'|'+r.sku,r])).values()];if(!valid.length)return;
 await db.query(`INSERT INTO ozon_protection_catalog(account,offer_id,product_id,currency,updated_at) SELECT item->>'accountId',item->>'sku',item->>'remoteId',item->>'currency',$2 FROM jsonb_array_elements($1::jsonb) item ON CONFLICT(account,offer_id) DO UPDATE SET product_id=EXCLUDED.product_id,currency=EXCLUDED.currency,updated_at=EXCLUDED.updated_at`,[JSON.stringify(valid.map(({accountId,sku,remoteId,currency})=>({accountId,sku,remoteId,currency}))),Date.now()]);
}
