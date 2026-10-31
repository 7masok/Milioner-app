import express from 'express';
import {requireConfiguredSession} from './auth.js';
import {createHash} from 'node:crypto';
import {asyncRoute,requireTrustedOrigin,noStore} from './http.js';
import {queryDay,shiftDay,queryRule,queryVerdict,queryWindows,normalizeQueryStats} from './wb-query-history-model.js';
const API='https://advert-api.wildberries.ru',SLOT=12*60*1000+5000;
const identifier=value=>{const n=Number(value);if(!Number.isSafeInteger(n)||n<1)throw Object.assign(Error('Неверный идентификатор'),{status:400});return n;};
const marketId=value=>{if(!['WB','WB2'].includes(String(value)))throw Object.assign(Error('Неверный магазин'),{status:400});return String(value);};
export async function replaceQueryWindow(db,job,rows,now){
 await db.query('DELETE FROM wb_query_stats WHERE market=$1 AND campaign_id=$2 AND nm_id=$3 AND date_from=$4',[job.market,job.campaign_id,job.nm_id,job.date_from]);
 for(const r of rows)await db.query(`INSERT INTO wb_query_stats(market,campaign_id,nm_id,date_from,query,views,clicks,cart_adds,orders,spend,currency) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[job.market,job.campaign_id,job.nm_id,job.date_from,r.query,r.views,r.clicks,r.cartAdds,r.orders,r.spend,r.currency]);
 await db.query('UPDATE wb_query_windows SET synced_at=$5,last_error=\'\',attempted_at=$5 WHERE market=$1 AND campaign_id=$2 AND nm_id=$3 AND date_from=$4',[job.market,job.campaign_id,job.nm_id,job.date_from,now]);
}
export const QUERY_TOTALS_SQL=`SELECT s.nm_id::text AS "nmId",s.query,
 CASE WHEN COUNT(s.views)=COUNT(*) THEN SUM(s.views)::float8 END AS views,
 CASE WHEN COUNT(s.clicks)=COUNT(*) THEN SUM(s.clicks)::float8 END AS clicks,
 CASE WHEN COUNT(s.cart_adds)=COUNT(*) THEN SUM(s.cart_adds)::float8 END AS "cartAdds",
 CASE WHEN COUNT(s.orders)=COUNT(*) THEN SUM(s.orders)::float8 END AS orders,
 CASE WHEN COUNT(s.spend)=COUNT(*) AND COUNT(DISTINCT s.currency)=1 THEN SUM(s.spend)::float8 END AS spend,
 CASE WHEN COUNT(DISTINCT s.currency)=1 THEN MIN(s.currency) ELSE '' END AS currency,
 MIN(s.date_from)::text AS "dateFrom",MAX(w.synced_at)::float8 AS "updatedAt"
 FROM wb_query_stats s JOIN wb_query_windows w USING(market,campaign_id,nm_id,date_from)
 WHERE s.market=$1 AND s.campaign_id=$2 GROUP BY s.nm_id,s.query`;
export function createWbQueryHistory({db,tokenFor,request,snapshot,clock=Date.now,schedule=fn=>{const timer=setTimeout(fn,0);timer.unref();}}){
 const router=express.Router();router.use(noStore,requireConfiguredSession,requireTrustedOrigin);let busy=false,timer;
 async function transaction(fn){const c=await db.connect();try{await c.query('BEGIN');const r=await fn(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
 async function wbCall(market,path,body){
  const token=await tokenFor(market);if(!token)throw Error('Не настроен токен WB');
  const scope=createHash('sha256').update(token).digest('hex')+':'+path,now=clock();
  const claim=await db.query(`INSERT INTO wb_query_cooldowns(scope,next_at) VALUES($1,$2) ON CONFLICT(scope) DO UPDATE SET next_at=EXCLUDED.next_at WHERE wb_query_cooldowns.next_at<=$3 RETURNING next_at`,[scope,now+SLOT,now]);
  if(!claim.rows.length)throw Object.assign(Error('Ожидает следующего разрешённого запроса WB'),{cooldown:true});
  try{return await request(API+path,token,{method:'POST',body});}catch(e){if(e.retryAt)await db.query('UPDATE wb_query_cooldowns SET next_at=GREATEST(next_at,$2) WHERE scope=$1',[scope,Number(e.retryAt)]);throw e;}
 }
 async function campaign(market,id){const s=await snapshot(market);const c=s?.campaigns?.find(x=>Number(x.id)===id);if(!c)throw Object.assign(Error('Кампания не найдена в сохранённых данных WB'),{status:404});return c;}
 async function track(market,id){const c=await campaign(market,id);if(!Array.isArray(c.nmIds)||!c.nmIds.length)throw Object.assign(Error('WB ещё не вернул артикулы кампании. Дождитесь обновления рекламы.'),{status:409});const today=queryDay(clock());for(const nm of c.nmIds||[]){const n=identifier(nm);await db.query(`INSERT INTO wb_query_sources(market,campaign_id,nm_id,first_day) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[market,id,n,shiftDay(today,-29)]);}return c;}
 async function totals(market,id){return (await db.query(QUERY_TOTALS_SQL,[market,id])).rows;}
 async function getRule(market,id){const r=await db.query('SELECT rule FROM wb_query_rules WHERE market=$1 AND campaign_id=$2',[market,id]);return queryRule(r.rows[0]?.rule);}
 async function list(market,id,search=''){
  const rule=await getRule(market,id),all=await totals(market,id);
  const exclusions=(await db.query('SELECT nm_id::text AS "nmId",query,state,last_error AS "lastError" FROM wb_query_exclusions WHERE market=$1 AND campaign_id=$2',[market,id])).rows;
  const rows=all.map(r=>({...r,...queryVerdict(r,rule),exclusion:exclusions.find(e=>e.nmId===r.nmId&&e.query===r.query)||null}));
  rows.sort((a,b)=>({poor:0,collecting:1,good:2,unknown:3}[a.state]-{poor:0,collecting:1,good:2,unknown:3}[b.state])||(Number(b[rule.basis])-Number(a[rule.basis]))||a.query.localeCompare(b.query,'ru'));
  const windows=(await db.query('SELECT MIN(date_from)::text AS "dateFrom",MIN(synced_at)::float8 AS "syncedAt",MAX(last_error) AS error,COUNT(*)::int AS windows,COUNT(*) FILTER(WHERE synced_at=0)::int AS pending FROM wb_query_windows WHERE market=$1 AND campaign_id=$2',[market,id])).rows[0];
  const filtered=rows.filter(r=>!search||r.query.toLocaleLowerCase('ru').includes(search.toLocaleLowerCase('ru')));
  return {ok:true,market,campaignId:id,rule,rows:filtered.slice(0,200),total:filtered.length,history:windows||{},tracked:(await db.query('SELECT 1 FROM wb_query_sources WHERE market=$1 AND campaign_id=$2 LIMIT 1',[market,id])).rows.length>0};
 }
 router.get('/:market/:id',asyncRoute(async(req,res)=>res.json(await list(marketId(req.params.market),identifier(req.params.id),String(req.query.q||'').slice(0,200)))));
 router.post('/:market/:id/collect',asyncRoute(async(req,res)=>{const m=marketId(req.params.market),id=identifier(req.params.id);await track(m,id);const data=await list(m,id);schedule(()=>collectNow(m));res.json(data);}));
 router.put('/:market/:id',requireTrustedOrigin,asyncRoute(async(req,res)=>{const m=marketId(req.params.market),id=identifier(req.params.id),rule=queryRule(req.body);await track(m,id);await db.query(`INSERT INTO wb_query_rules(market,campaign_id,rule,updated_at) VALUES($1,$2,$3::jsonb,$4) ON CONFLICT(market,campaign_id) DO UPDATE SET rule=EXCLUDED.rule,updated_at=EXCLUDED.updated_at`,[m,id,JSON.stringify(rule),clock()]);if(!rule.autoExclude)await db.query("UPDATE wb_query_exclusions SET state='cancelled',updated_at=$3 WHERE market=$1 AND campaign_id=$2 AND source='auto' AND state='pending'",[m,id,clock()]);res.json(await list(m,id));}));
 router.post('/:market/:id/exclude',requireTrustedOrigin,asyncRoute(async(req,res)=>{const m=marketId(req.params.market),id=identifier(req.params.id),nm=identifier(req.body.nmId),query=String(req.body.query||'');await campaign(m,id);const exists=await db.query('SELECT 1 FROM wb_query_stats WHERE market=$1 AND campaign_id=$2 AND nm_id=$3 AND query=$4 LIMIT 1',[m,id,nm,query]);if(!exists.rows.length)throw Object.assign(Error('Запрос не найден в сохранённой статистике'),{status:400});await queueExclusion(m,id,nm,query);res.json({ok:true,state:'pending'});}));
 async function queueExclusion(m,id,nm,query,source='manual'){
  const conflict=source==='manual'?"DO UPDATE SET state='pending',source='manual',last_error='',updated_at=EXCLUDED.updated_at WHERE wb_query_exclusions.state IN ('error','cancelled')":"DO NOTHING";
  await db.query(`INSERT INTO wb_query_exclusions(market,campaign_id,nm_id,query,state,source,updated_at) VALUES($1,$2,$3,$4,'pending',$5,$6) ON CONFLICT(market,campaign_id,nm_id,query) ${conflict}`,[m,id,nm,query,source,clock()]);
 }

 async function syncOne(market){
  const today=queryDay(clock()),earliest=shiftDay(today,-29);const sources=(await db.query('SELECT * FROM wb_query_sources WHERE market=$1',[market])).rows;
  const saved=(await db.query('SELECT campaign_id,nm_id,date_from::text AS f,date_to::text AS t FROM wb_query_windows WHERE market=$1',[market])).rows;const known=new Map(saved.map(w=>[[w.campaign_id,w.nm_id,w.f].join(':'),w.t]));
  for(const source of sources){const first=String(source.first_day instanceof Date?source.first_day.toISOString():source.first_day).slice(0,10);for(const w of queryWindows(first,today)){
   if(known.get([source.campaign_id,source.nm_id,w.from].join(':'))===w.to)continue;
   await db.query(`INSERT INTO wb_query_windows(market,campaign_id,nm_id,date_from,date_to) VALUES($1,$2,$3,$4,$5) ON CONFLICT(market,campaign_id,nm_id,date_from) DO UPDATE SET date_to=EXCLUDED.date_to`,[market,source.campaign_id,source.nm_id,w.from,w.to]);
  }}
  // Expired segments stay frozen; never replace a full segment with a partial WB horizon.
  const job=(await db.query(`SELECT *,date_from::text AS date_from,date_to::text AS date_to FROM wb_query_windows WHERE market=$1 AND date_from >= $2 AND (attempted_at=0 OR attempted_at<$3) ORDER BY synced_at ASC,attempted_at ASC,wb_query_windows.date_from DESC,campaign_id,nm_id LIMIT 1`,[market,earliest,clock()-60*60*1000])).rows[0];
  if(!job)return;
  try{
   const jobs=(await db.query(`SELECT *,date_from::text AS date_from,date_to::text AS date_to FROM wb_query_windows WHERE market=$1 AND date_from=$2 AND date_to=$3 AND (attempted_at=0 OR attempted_at<$4) ORDER BY campaign_id,nm_id LIMIT 100`,[market,job.date_from,job.date_to,clock()-60*60*1000])).rows;
   const data=await wbCall(market,'/adv/v0/normquery/stats',{from:job.date_from,to:job.date_to,items:jobs.map(j=>({advert_id:Number(j.campaign_id),nm_id:Number(j.nm_id)}))});
   for(const j of jobs){try{const rows=normalizeQueryStats(data,j.campaign_id,j.nm_id);await transaction(c=>replaceQueryWindow(c,j,rows,clock()));}catch(e){await db.query('UPDATE wb_query_windows SET last_error=$5,attempted_at=$6 WHERE market=$1 AND campaign_id=$2 AND nm_id=$3 AND date_from=$4',[market,j.campaign_id,j.nm_id,j.date_from,String(e.message).slice(0,500),clock()]);}}
  }catch(e){if(!e.cooldown)await db.query('UPDATE wb_query_windows SET last_error=$5,attempted_at=$6 WHERE market=$1 AND campaign_id=$2 AND nm_id=$3 AND date_from=$4',[market,job.campaign_id,job.nm_id,job.date_from,String(e.message).slice(0,500),clock()]);}
 }
 async function exclusionsOne(market){
  const pending=(await db.query(`SELECT * FROM wb_query_exclusions WHERE market=$1 AND state IN ('pending','checking') ORDER BY updated_at LIMIT 1`,[market])).rows[0];if(!pending)return;
  const {campaign_id:id,nm_id:nm,query}=pending;
  if(pending.source==='auto'&&pending.state==='pending'){
   const rule=await getRule(market,Number(id)),row=(await totals(market,Number(id))).find(x=>Number(x.nmId)===Number(nm)&&x.query===query);
   if(!rule.autoExclude||!row||queryVerdict(row,rule).state!=='poor'||row.orders===null||Number(row.orders)!==0){await db.query("UPDATE wb_query_exclusions SET state='cancelled',updated_at=$5 WHERE market=$1 AND campaign_id=$2 AND nm_id=$3 AND query=$4",[market,id,nm,query,clock()]);return;}
  }
  try{
   const data=await wbCall(market,'/adv/v0/normquery/get-minus',{items:[{advert_id:Number(id),nm_id:Number(nm)}]});
   const group=data?.items?.find(x=>Number(x.advert_id)===Number(id)&&Number(x.nm_id)===Number(nm));
   if(!group||!Array.isArray(group.norm_queries)||group.norm_queries.some(x=>typeof x!=='string'))throw Error('WB не подтвердил текущий список минус-фраз');
   if(group.norm_queries.includes(query)){await db.query(`UPDATE wb_query_exclusions SET state='confirmed',updated_at=$5,last_error='' WHERE market=$1 AND campaign_id=$2 AND nm_id=$3 AND query=$4`,[market,id,nm,query,clock()]);return;}
   if(pending.state==='checking')throw Error('WB не подтвердил исключение. Повторите после проверки списка в кабинете.');
   if(group.norm_queries.length>=1000)throw Error('Достигнут лимит 1000 минус-фраз WB');
   await wbCall(market,'/adv/v0/normquery/set-minus',{advert_id:Number(id),nm_id:Number(nm),norm_queries:[...group.norm_queries,query]});
   await db.query(`UPDATE wb_query_exclusions SET state='checking',updated_at=$5,last_error='' WHERE market=$1 AND campaign_id=$2 AND nm_id=$3 AND query=$4`,[market,id,nm,query,clock()]);
  }catch(e){if(!e.cooldown)await db.query(`UPDATE wb_query_exclusions SET state='error',updated_at=$5,last_error=$6 WHERE market=$1 AND campaign_id=$2 AND nm_id=$3 AND query=$4`,[market,id,nm,query,clock(),String(e.message).slice(0,500)]);}
 }
 async function autoQueue(market){
  const rules=(await db.query("SELECT campaign_id,rule FROM wb_query_rules WHERE market=$1 AND rule->>'autoExclude'='true'",[market])).rows;
  for(const r of rules){const id=Number(r.campaign_id),rule=queryRule(r.rule);const health=(await db.query('SELECT MIN(synced_at)::float8 AS last,COUNT(*) FILTER(WHERE synced_at=0 OR last_error<>\'\')::int AS pending FROM wb_query_windows WHERE market=$1 AND campaign_id=$2 AND date_to >= $3',[market,id,shiftDay(queryDay(clock()),-29)])).rows[0];
   if(!health?.last||Number(health.pending)>0||clock()-Number(health.last)>24*60*60*1000)continue;
   for(const row of await totals(market,id))if(queryVerdict(row,rule).state==='poor'&&row.orders!==null&&Number(row.orders)===0)await queueExclusion(market,id,Number(row.nmId),row.query,'auto');
  }
 }
 async function collectNow(market){if(busy)return;busy=true;try{await syncOne(market);}catch(e){console.warn('WB query collection',market,e.message);}finally{busy=false;}}
 async function tick(){if(busy)return;busy=true;try{for(const m of ['WB','WB2']){try{await syncOne(m);await autoQueue(m);await exclusionsOne(m);}catch(e){console.warn('WB query history',m,e.message);}}}finally{busy=false;}}
 return {router,tick,start(){if(timer)return;timer=setInterval(()=>void tick(),60*1000);timer.unref();const start=setTimeout(()=>void tick(),120000);start.unref();}};
}
