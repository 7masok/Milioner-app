import crypto from 'node:crypto';
import {reportStoreStartDate} from './report-history-range.js';
import {readBusinessProgress} from './business-dashboard-progress.js';
import {pool} from './db.js';
import {asyncRoute,requireTrustedOrigin} from './http.js';
export const BUSINESS_CACHE_VERSION='calendar-v2';
const DAY=86400000,OFFSET=18000000;
function cacheMarket(value){return value===undefined||value==='all'?'all':['Kaspi','WB','WB2','Ozon'].includes(value)?value:null}
function scopedKey(key,market){return market==='all'?key:key+':'+market}
function partialSnapshot(model){return Boolean(model?.ordersPartialMarkets?.length||model?.summary?.missingMarkets?.length)}
export function reusableBusinessSnapshot(model,at,now=Date.now()){
 return Boolean(model&&Number(at)>=model.bounds.end+2*DAY&&model.bounds.end+2*DAY<=now&&!model.pending&&!model.unavailable&&!model.yearPartial&&!partialSnapshot(model)&&!model.summary?.partialOzonHistory);
}
function validScope(model,market){return (!model?.market||model.market===market)&&(market==='all'||[...(model?.ordersPartialMarkets||[]),...(model?.summary?.missingMarkets||[]),...Object.keys(model?.summary?.sources||{})].every(m=>m===market))}
const midnight=t=>Math.floor((t+OFFSET)/DAY)*DAY-OFFSET;
let ready;
function ensureCache(){return ready ||= pool.query(`CREATE TABLE IF NOT EXISTS business_dashboard_cache (
 cache_key TEXT PRIMARY KEY,version TEXT NOT NULL,source_revision TEXT NOT NULL,payload JSONB NOT NULL,generated_at BIGINT NOT NULL
)`).catch(error=>{ready=null;throw error})}
export function businessCacheKey(period,start){
 start=Number(start);if(!['day','week','month','year'].includes(period)||!Number.isFinite(start)||start<1||start!==midnight(start)||start>midnight(Date.now()))return null;
 const d=new Date(start+OFFSET);if(period==='week'&&d.getUTCDay()!==1||period==='month'&&d.getUTCDate()!==1||period==='year'&&(d.getUTCMonth()!==0||d.getUTCDate()!==1))return null;
 return period+':'+start;
}
export function validBusinessSnapshot(model,period,start){
 if(!model||model.period!==period||Number(model.bounds?.start)!==Number(start)||!model.yesterday||!model.yesterdayCompare)return false;
 const finite=(o,fields)=>fields.every(k=>typeof o?.[k]==='number'&&Number.isFinite(o[k]));
 const size=JSON.stringify(model).length;if(size>500000)return false;
 function snapshot(x){return x&&Number.isFinite(x.bounds?.start)&&Number.isFinite(x.bounds?.end)&&x.bounds.end>x.bounds.start&&x.bounds.end-x.bounds.start<=(period==='year'?366:32)*DAY&&Array.isArray(x.buckets)&&x.buckets.length>0&&x.buckets.length<=31&&finite(x.orders,['amount','qty','profit','orderCount','coverage'])&&(finite(x.summary,['revenue','qty'])||x.pending===true&&x.ordersReady===true&&x.summary?.revenue===null&&x.summary?.qty===null)&&(x.summary.profit===null||typeof x.summary.profit==='number'&&Number.isFinite(x.summary.profit))&&x.buckets.every(b=>Number.isFinite(b.start)&&Number.isFinite(b.end)&&b.end>b.start)}
 if(![model,model.yesterday,model.yesterdayCompare].every(snapshot))return false;
 const expected=period==='year'?12:period==='day'?24:period==='week'?7:new Date(new Date(Number(start)+OFFSET).getUTCFullYear(),new Date(Number(start)+OFFSET).getUTCMonth()+1,0).getDate();
 if(model.buckets.length!==expected)return false;
 let nodes=0;function safe(v){if(++nodes>100000)return false;if(v===null||typeof v==='boolean')return true;if(typeof v==='number')return Number.isFinite(v);if(typeof v==='string')return v.length<500&&!/[<>&]/.test(v);if(Array.isArray(v))return v.length<5000&&v.every(safe);if(v&&typeof v==='object')return Object.entries(v).every(([k,x])=>!['__proto__','prototype','constructor'].includes(k)&&safe(x));return false}
 return safe(model);
}
async function sourceRevision(){
 // Only revision markers: do not read/recalculate finance rows for a cache hit.
 const r=await pool.query(`SELECT
 (SELECT revision FROM warehouse_state WHERE id=1) AS warehouse,
 (SELECT MAX(finished_at) FROM sync_runs WHERE ok=1) AS orders,
 (SELECT MAX(finished_at) FROM wb_finance_sync_runs WHERE finance_ok=1) AS finance,
 (SELECT MAX(updated_at) FROM wb_ad_costs) AS advertising,
 (SELECT MAX(updated_at) FROM warehouse_sales) AS sales,
 (SELECT MAX(updated_at) FROM product_links) AS links,
 (SELECT MAX(updated_at) FROM ozon_fbo_cache) AS ozon,
 (SELECT MAX(last_success_at) FROM wb_sales_live_state) AS live,
 (SELECT MAX(updated_at) FROM wb_order_history_state) AS order_history,
 (SELECT MAX(updated_at) FROM kaspi_order_history_state) AS kaspi_history`);
 return crypto.createHash('sha256').update(JSON.stringify(r.rows[0]||{})).digest('hex');
}
function dailyBounds(from,to){return Number.isFinite(from)&&Number.isFinite(to)&&from===midnight(from)&&to===midnight(to)&&from>0&&to>from&&to-from<=366*DAY&&to<=midnight(Date.now())+DAY}
export function validBusinessDay(day){return validBusinessSnapshot({...day,yesterday:day,yesterdayCompare:day},'day',day?.bounds?.start)}
// Compose only persisted per-store days. No marketplace calls or business writes.
const MARKETS=['Kaspi','WB','WB2','Ozon'];
const ORDER_FIELDS=['amount','qty','profit','orderCount','coveredAmount','coveredQty'];
const BUCKET_FIELDS=['orders','orderQty','orderProfit','buyouts','buyoutQty','buyoutBaseProfit','buyoutProfit','coreBuyouts','coreBuyoutQty','coreBuyoutBaseProfit','coreBuyoutProfit','ozonBuyouts','ozonBuyoutQty','ozonBuyoutBaseProfit','ozonBuyoutProfit','netProfit'];
function openingSignature(payload,markets){return JSON.stringify(Object.fromEntries(markets.map(m=>[m,reportStoreStartDate(payload,m)]).filter(([,v])=>v)))}
function matchesOpening(day,payload,market){
 if(!day.storeStarts)return false;
 try{const saved=typeof day.storeStarts==='string'?JSON.parse(day.storeStarts):day.storeStarts;
  return openingSignature({settings:{reportStoreStarts:saved}},market==='all'?MARKETS:[market])===openingSignature(payload,market==='all'?MARKETS:[market]);
 }catch{return false}
}
function dayQuality(day){return ((day.ordersReady===true||!day.pending)&&!day.ordersPartialMarkets?.length?2:0)+(!day.pending&&!partialSnapshot(day)&&!day.summary?.partialOzonHistory?1:0)}
export function composeBusinessDays(rows,from,to,warehouse,revision,now=Date.now()){
 const byKey=new Map(rows.filter(r=>r.version===BUSINESS_CACHE_VERSION).map(r=>[r.cache_key,r])),out=[];
 for(let t=from;t<to;t+=DAY){
  const parts=[],times=[],revisions=[];let missing=false;
  for(const market of MARKETS){
   const opening=reportStoreStartDate(warehouse,market),before=opening&&t+DAY<=Date.parse(opening+'T00:00:00+05:00');
   if(before){parts.push({market,beforeOpening:true});continue}
   const row=byKey.get(scopedKey('base:'+t,market)),day=row?.payload;
   if(!row||!validBusinessDay(day)||!validScope(day,market)||day.bounds.start!==t||day.bounds.end!==t+DAY||!matchesOpening(day,warehouse,market)||!Number.isFinite(Number(row.generated_at))||Number(row.generated_at)<=0){missing=true;break}
   parts.push({...day,market});times.push(Number(row.generated_at));revisions.push(row.source_revision);
  }
  const old=byKey.get('base:'+t),oldDay=old?.payload,validOld=old&&validBusinessDay(oldDay)&&oldDay.bounds.start===t&&oldDay.bounds.end===t+DAY&&validScope(oldDay,'all')&&(!oldDay.storeStarts||matchesOpening(oldDay,warehouse,'all'));
  let chosen=validOld?old:null,composed=false;
  if(!missing){
   const active=parts.filter(p=>!p.beforeOpening),first=active[0],orders=Object.fromEntries(ORDER_FIELDS.map(f=>[f,0])),events=new Map();
   for(const p of active){for(const f of ORDER_FIELDS)orders[f]+=Number(p.orders[f]??(f==='coveredAmount'?p.orders.amount*p.orders.coverage:f==='coveredQty'?p.orders.qty*p.orders.coverage:0))||0;
    for(const e of p.events||[]){const row=events.get(e[0])||[e[0],0,0,0,0,0,0];for(let i=1;i<7;i++)row[i]+=Number(e[i])||0;events.set(e[0],row)}
   }
   orders.coverage=orders.amount>0?orders.coveredAmount/orders.amount:1;
   const buckets=Array.from({length:24},(_,i)=>{const bucket={...(first?.buckets[i]||{}),start:t+i*3600000,end:t+(i+1)*3600000,label:first?.buckets[i]?.label||String(i)};for(const f of BUCKET_FIELDS)bucket[f]=active.reduce((n,p)=>n+(Number(p.buckets[i][f])||0),0);return bucket});
   const summary={estimated:active.some(p=>p.summary.estimated),missingMarkets:[...new Set(active.flatMap(p=>p.summary.missingMarkets||[]))],partialOzonHistory:active.some(p=>p.summary.partialOzonHistory),sources:Object.fromEntries(active.map(p=>[p.market,p.summary]))};
   for(const f of ['revenue','qty','profit'])summary[f]=active.some(p=>p.summary[f]===null||p.summary[f]===undefined)?null:active.reduce((n,p)=>n+p.summary[f],0);
   summary.estimated=summary.estimated||summary.profit===null;
   const day={market:'all',storeStarts:openingSignature(warehouse,MARKETS),period:'day',bounds:first?.bounds||{start:t,end:t+DAY},buckets,orders,events:[...events.values()].sort((a,b)=>a[0]-b[0]),local:null,summary,netProfit:summary.profit,hourly:{ozonHourlyComplete:active.every(p=>p.hourly?.ozonHourlyComplete!==false)},pending:active.some(p=>p.pending)||summary.revenue===null||summary.qty===null,ordersReady:active.every(p=>p.ordersReady===true||!p.pending),ordersPartialMarkets:[...new Set(active.flatMap(p=>p.ordersPartialMarkets||[]))],beforeOpening:active.length===0};
   const at=times.length?Math.min(...times):now;
   if(validBusinessDay(day)&&(!chosen||dayQuality(day)>dayQuality(oldDay)||dayQuality(day)===dayQuality(oldDay)&&Math.max(...times,0)>=Number(old.generated_at))){chosen={payload:day,generated_at:at,source_revision:revisions.every(r=>r===revision)?revision:null};composed=true}
  }
  if(chosen)out.push({day:chosen.payload,generatedAt:Number(chosen.generated_at),reusable:reusableBusinessSnapshot(chosen.payload,Number(chosen.generated_at),now),fresh:!partialSnapshot(chosen.payload)&&!chosen.payload.pending&&chosen.source_revision===revision&&now-Number(chosen.generated_at)<(t+DAY>now?60000:15*60000)&&!(Number(chosen.generated_at)<t+DAY&&t+DAY<=now),...(composed?{composed:true}:{})});
 }
 return out;
}
export function registerBusinessDashboardCache(router){
 router.get('/business-dashboard-progress',asyncRoute(async(req,res)=>{
  const market=cacheMarket(req.query.market);if(!market)return res.status(400).json({ok:false,error:'Некорректный магазин'});
  const hasRange=req.query.from!==undefined||req.query.to!==undefined,from=Number(req.query.from),to=Number(req.query.to);
  if(hasRange&&!dailyBounds(from,to))return res.status(400).json({ok:false,error:'Некорректный диапазон прогресса'});
  res.json(await readBusinessProgress(pool,market,Date.now(),hasRange?{from,to}:null));
 }));
 router.get('/business-dashboard-months',asyncRoute(async(req,res)=>{
  const market=cacheMarket(req.query.market);if(!market)return res.status(400).json({ok:false,error:'Некорректный магазин'});
  const from=Number(req.query.from),to=Number(req.query.to);
  if(!businessCacheKey('year',from)||!Number.isFinite(to)||to<=from||to-from>732*DAY||new Date(to+OFFSET).getUTCMonth()!==0||new Date(to+OFFSET).getUTCDate()!==1||to!==midnight(to))return res.status(400).json({ok:false,error:'Некорректный диапазон месяцев'});
  const keys=[];for(let t=from;t<to;){keys.push(scopedKey('month:'+t,market));const d=new Date(t+OFFSET);t=Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,1)-OFFSET}
  await ensureCache();const [revision,result]=await Promise.all([sourceRevision(),pool.query('SELECT cache_key,version,source_revision,payload,generated_at FROM business_dashboard_cache WHERE cache_key=ANY($1::text[])',[keys])]);
  const months=new Map();
  for(const row of result.rows){const at=Number(row.generated_at),model=row.payload;if(row.version!==BUSINESS_CACHE_VERSION||!validBusinessSnapshot(model,'month',Number(row.cache_key.split(':')[1]))||!validScope(model,market))continue;
   for(const candidate of [model,model.yesterday]){if(candidate?.period!=='month'||candidate.pending&&!candidate.ordersReady||candidate.unavailable||candidate.bounds.start<from||candidate.bounds.start>=to)continue;const prior=months.get(candidate.bounds.start);if(prior&&prior.generatedAt>=at)continue;
    const {period,bounds,buckets,orders,summary,netProfit,hourly,pending,ordersReady,ordersPartialMarkets,market:store,storeStarts,beforeOpening}=candidate;
    months.set(bounds.start,{month:{...(store?{market:store}:{}),...(storeStarts?{storeStarts}:{}),beforeOpening:Boolean(beforeOpening),ordersPartialMarkets:ordersPartialMarkets||[],period,bounds,buckets,orders,summary,netProfit,hourly,pending:Boolean(pending),ordersReady:ordersReady===true||!pending},generatedAt:at,fresh:!partialSnapshot(candidate)&&row.source_revision===revision&&Date.now()-at<(bounds.end>Date.now()?60000:15*60000)&&!(at<bounds.end&&bounds.end<=Date.now())});
   }
  }
  res.json({ok:true,version:BUSINESS_CACHE_VERSION,sourceRevision:revision,months:[...months.values()]});
 }));
 router.get('/business-dashboard-days',asyncRoute(async(req,res)=>{
  const market=cacheMarket(req.query.market);if(!market)return res.status(400).json({ok:false,error:'Некорректный магазин'});
  const from=Number(req.query.from),to=Number(req.query.to);if(!dailyBounds(from,to))return res.status(400).json({ok:false,error:'Некорректный дневной диапазон'});
  await ensureCache();const keys=[];for(let t=from;t<to;t+=DAY){keys.push(scopedKey('base:'+t,market));if(market==='all')for(const m of MARKETS)keys.push(scopedKey('base:'+t,m))}
  const [revision,result,warehouse]=await Promise.all([sourceRevision(),pool.query('SELECT cache_key,version,source_revision,payload,generated_at FROM business_dashboard_cache WHERE cache_key=ANY($1::text[])',[keys]),market==='all'?pool.query('SELECT payload FROM warehouse_state WHERE id=1'):Promise.resolve({rows:[]})]);
  const days=market==='all'?composeBusinessDays(result.rows,from,to,warehouse.rows[0]?.payload,revision):result.rows.filter(r=>r.version===BUSINESS_CACHE_VERSION&&validBusinessDay(r.payload)&&validScope(r.payload,market)).map(r=>({day:r.payload,generatedAt:Number(r.generated_at),reusable:reusableBusinessSnapshot(r.payload,Number(r.generated_at)),fresh:!partialSnapshot(r.payload)&&!r.payload.pending&&r.source_revision===revision&&Date.now()-Number(r.generated_at)<(r.payload.bounds.end>Date.now()?60000:15*60000)&&!(Number(r.generated_at)<r.payload.bounds.end&&r.payload.bounds.end<=Date.now())}));
  res.json({ok:true,version:BUSINESS_CACHE_VERSION,sourceRevision:revision,days});
 }));
 router.put('/business-dashboard-days',requireTrustedOrigin,asyncRoute(async(req,res)=>{
  const market=cacheMarket(req.body?.market);if(!market)return res.status(400).json({ok:false,error:'Некорректный магазин'});
  const {days,version,sourceRevision:revision}=req.body||{};
  if(version!==BUSINESS_CACHE_VERSION||!/^[a-f0-9]{64}$/.test(String(revision||''))||!Array.isArray(days)||!days.length||days.length>64||new Set(days.map(d=>d?.bounds?.start)).size!==days.length||JSON.stringify(days).length>2000000||!days.every(d=>businessCacheKey('day',d?.bounds?.start)&&validBusinessDay(d)&&validScope(d,market)))return res.status(400).json({ok:false,error:'Некорректная дневная основа'});
  await ensureCache();if(await sourceRevision()!==revision)return res.status(409).json({ok:false,error:'Данные обновились во время расчёта'});
  const at=Date.now(),rows=days.map(day=>({key:scopedKey('base:'+day.bounds.start,market),payload:day}));
  await pool.query(`INSERT INTO business_dashboard_cache(cache_key,version,source_revision,payload,generated_at)
   SELECT x->>'key',$2,$3,x->'payload',$4 FROM jsonb_array_elements($1::jsonb) x
   ON CONFLICT(cache_key) DO UPDATE SET version=excluded.version,source_revision=excluded.source_revision,payload=excluded.payload,generated_at=excluded.generated_at`,[JSON.stringify(rows),version,revision,at]);
  await pool.query('DELETE FROM business_dashboard_cache WHERE cache_key NOT IN (SELECT cache_key FROM business_dashboard_cache ORDER BY generated_at DESC LIMIT 5000)');
  res.json({ok:true,generatedAt:at});
 }));

 router.get('/business-dashboard-cache',asyncRoute(async(req,res)=>{
  const market=cacheMarket(req.query.market),base=businessCacheKey(req.query.period,req.query.start),key=market&&base?scopedKey(base,market):null;if(!key)return res.status(400).json({ok:false,error:'Некорректный период'});
  await ensureCache();const [revision,result]=await Promise.all([sourceRevision(),pool.query('SELECT version,source_revision,payload,generated_at FROM business_dashboard_cache WHERE cache_key=$1',[key])]);
  const row=result.rows[0],payload=row?.version===BUSINESS_CACHE_VERSION&&validBusinessSnapshot(row.payload,req.query.period,req.query.start)&&validScope(row.payload,market)?row.payload:null;
  const at=Number(row?.generated_at)||0,current=Number(payload?.bounds?.end)>Date.now(),ttl=current?60000:15*60000;
  const stale=!payload||partialSnapshot(payload)||payload.pending===true||row.source_revision!==revision||Date.now()-at>ttl||current&&midnight(at)!==midnight(Date.now())||payload&&at<payload.bounds.end&&payload.bounds.end<=Date.now();
  res.json({ok:true,version:BUSINESS_CACHE_VERSION,sourceRevision:revision,snapshot:payload,generatedAt:at||null,reusable:reusableBusinessSnapshot(payload,at),stale});
 }));
 router.put('/business-dashboard-cache',requireTrustedOrigin,asyncRoute(async(req,res)=>{
  const {period,start,snapshot,sourceRevision:revision,version}=req.body||{},market=cacheMarket(req.body?.market),base=businessCacheKey(period,start),key=market&&base?scopedKey(base,market):null;
  if(!key||version!==BUSINESS_CACHE_VERSION||!/^[a-f0-9]{64}$/.test(String(revision||''))||!validBusinessSnapshot(snapshot,period,start)||!validScope(snapshot,market))return res.status(400).json({ok:false,error:'Некорректная сводка'});
  await ensureCache();const current=await sourceRevision();if(current!==revision)return res.status(409).json({ok:false,error:'Данные обновились во время расчёта'});
  const at=Date.now();await pool.query(`INSERT INTO business_dashboard_cache(cache_key,version,source_revision,payload,generated_at) VALUES($1,$2,$3,$4::jsonb,$5)
   ON CONFLICT(cache_key) DO UPDATE SET version=excluded.version,source_revision=excluded.source_revision,payload=excluded.payload,generated_at=excluded.generated_at`,[key,version,revision,JSON.stringify(snapshot),at]);
  await pool.query('DELETE FROM business_dashboard_cache WHERE cache_key NOT IN (SELECT cache_key FROM business_dashboard_cache ORDER BY generated_at DESC LIMIT 5000)');
  res.json({ok:true,generatedAt:at});
 }));
}
