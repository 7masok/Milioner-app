import crypto from 'node:crypto';
import {pool} from './db.js';
import {asyncRoute,requireTrustedOrigin} from './http.js';
export const BUSINESS_CACHE_VERSION='calendar-v2';
const DAY=86400000,OFFSET=18000000;
const midnight=t=>Math.floor((t+OFFSET)/DAY)*DAY-OFFSET;
let ready;
function ensureCache(){return ready ||= pool.query(`CREATE TABLE IF NOT EXISTS business_dashboard_cache (
 cache_key TEXT PRIMARY KEY,version TEXT NOT NULL,source_revision TEXT NOT NULL,payload JSONB NOT NULL,generated_at BIGINT NOT NULL
)`).catch(error=>{ready=null;throw error})}
export function businessCacheKey(period,start){
 start=Number(start);if(!['day','week','month','year'].includes(period)||!Number.isFinite(start)||start<1||start!==midnight(start)||start>midnight(Date.now()))return null;
 const d=new Date(start+OFFSET);if(period==='week'&&d.getUTCDay()!==1||period==='month'&&d.getUTCDate()!==1||period==='year'&&(d.getUTCMonth()!==0||d.getUTCDate()!==1))return null;
 if(start<midnight(Date.now())-(period==='year'?1200:400)*DAY)return null;return period+':'+start;
}
export function validBusinessSnapshot(model,period,start){
 if(!model||model.period!==period||Number(model.bounds?.start)!==Number(start)||!model.yesterday||!model.yesterdayCompare)return false;
 const finite=(o,fields)=>fields.every(k=>typeof o?.[k]==='number'&&Number.isFinite(o[k]));
 const size=JSON.stringify(model).length;if(size>500000)return false;
 function snapshot(x){return x&&Number.isFinite(x.bounds?.start)&&Number.isFinite(x.bounds?.end)&&x.bounds.end>x.bounds.start&&x.bounds.end-x.bounds.start<=(period==='year'?366:32)*DAY&&Array.isArray(x.buckets)&&x.buckets.length>0&&x.buckets.length<=31&&finite(x.orders,['amount','qty','profit','orderCount','coverage'])&&finite(x.summary,['revenue','qty'])&&(x.summary.profit===null||typeof x.summary.profit==='number'&&Number.isFinite(x.summary.profit))&&x.buckets.every(b=>Number.isFinite(b.start)&&Number.isFinite(b.end)&&b.end>b.start)}
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
 (SELECT MAX(last_success_at) FROM wb_sales_live_state) AS live`);
 return crypto.createHash('sha256').update(JSON.stringify(r.rows[0]||{})).digest('hex');
}
function dailyBounds(from,to){return Number.isFinite(from)&&Number.isFinite(to)&&from===midnight(from)&&to===midnight(to)&&from>0&&to>from&&to-from<=64*DAY&&to<=midnight(Date.now())+DAY&&from>=midnight(Date.now())-400*DAY}
export function validBusinessDay(day){return validBusinessSnapshot({...day,yesterday:day,yesterdayCompare:day},'day',day?.bounds?.start)}
export function registerBusinessDashboardCache(router){
 router.get('/business-dashboard-days',asyncRoute(async(req,res)=>{
  const from=Number(req.query.from),to=Number(req.query.to);if(!dailyBounds(from,to))return res.status(400).json({ok:false,error:'Некорректный дневной диапазон'});
  await ensureCache();const keys=[];for(let t=from;t<to;t+=DAY)keys.push('base:'+t);
  const [revision,result]=await Promise.all([sourceRevision(),pool.query('SELECT cache_key,version,source_revision,payload,generated_at FROM business_dashboard_cache WHERE cache_key=ANY($1::text[])',[keys])]);
  res.json({ok:true,version:BUSINESS_CACHE_VERSION,sourceRevision:revision,days:result.rows.filter(r=>r.version===BUSINESS_CACHE_VERSION&&validBusinessDay(r.payload)).map(r=>({day:r.payload,generatedAt:Number(r.generated_at),fresh:r.source_revision===revision&&Date.now()-Number(r.generated_at)<(r.payload.bounds.end>Date.now()?60000:15*60000)&&!(Number(r.generated_at)<r.payload.bounds.end&&r.payload.bounds.end<=Date.now())}))});
 }));
 router.put('/business-dashboard-days',requireTrustedOrigin,asyncRoute(async(req,res)=>{
  const {days,version,sourceRevision:revision}=req.body||{};
  if(version!==BUSINESS_CACHE_VERSION||!/^[a-f0-9]{64}$/.test(String(revision||''))||!Array.isArray(days)||!days.length||days.length>64||new Set(days.map(d=>d?.bounds?.start)).size!==days.length||JSON.stringify(days).length>2000000||!days.every(d=>businessCacheKey('day',d?.bounds?.start)&&validBusinessDay(d)))return res.status(400).json({ok:false,error:'Некорректная дневная основа'});
  await ensureCache();if(await sourceRevision()!==revision)return res.status(409).json({ok:false,error:'Данные обновились во время расчёта'});
  const at=Date.now(),rows=days.map(day=>({key:'base:'+day.bounds.start,payload:day}));
  await pool.query(`INSERT INTO business_dashboard_cache(cache_key,version,source_revision,payload,generated_at)
   SELECT x->>'key',$2,$3,x->'payload',$4 FROM jsonb_array_elements($1::jsonb) x
   ON CONFLICT(cache_key) DO UPDATE SET version=excluded.version,source_revision=excluded.source_revision,payload=excluded.payload,generated_at=excluded.generated_at`,[JSON.stringify(rows),version,revision,at]);
  await pool.query('DELETE FROM business_dashboard_cache WHERE cache_key NOT IN (SELECT cache_key FROM business_dashboard_cache ORDER BY generated_at DESC LIMIT 400)');
  res.json({ok:true,generatedAt:at});
 }));

 router.get('/business-dashboard-cache',asyncRoute(async(req,res)=>{
  const key=businessCacheKey(req.query.period,req.query.start);if(!key)return res.status(400).json({ok:false,error:'Некорректный период'});
  await ensureCache();const [revision,result]=await Promise.all([sourceRevision(),pool.query('SELECT version,source_revision,payload,generated_at FROM business_dashboard_cache WHERE cache_key=$1',[key])]);
  const row=result.rows[0],payload=row?.version===BUSINESS_CACHE_VERSION&&validBusinessSnapshot(row.payload,req.query.period,req.query.start)?row.payload:null;
  const at=Number(row?.generated_at)||0,current=Number(payload?.bounds?.end)>Date.now(),ttl=current?60000:15*60000;
  const stale=!payload||row.source_revision!==revision||Date.now()-at>ttl||current&&midnight(at)!==midnight(Date.now())||payload&&at<payload.bounds.end&&payload.bounds.end<=Date.now();
  res.json({ok:true,version:BUSINESS_CACHE_VERSION,sourceRevision:revision,snapshot:payload,generatedAt:at||null,stale});
 }));
 router.put('/business-dashboard-cache',requireTrustedOrigin,asyncRoute(async(req,res)=>{
  const {period,start,snapshot,sourceRevision:revision,version}=req.body||{},key=businessCacheKey(period,start);
  if(!key||version!==BUSINESS_CACHE_VERSION||!/^[a-f0-9]{64}$/.test(String(revision||''))||!validBusinessSnapshot(snapshot,period,start))return res.status(400).json({ok:false,error:'Некорректная сводка'});
  await ensureCache();const current=await sourceRevision();if(current!==revision)return res.status(409).json({ok:false,error:'Данные обновились во время расчёта'});
  const at=Date.now();await pool.query(`INSERT INTO business_dashboard_cache(cache_key,version,source_revision,payload,generated_at) VALUES($1,$2,$3,$4::jsonb,$5)
   ON CONFLICT(cache_key) DO UPDATE SET version=excluded.version,source_revision=excluded.source_revision,payload=excluded.payload,generated_at=excluded.generated_at`,[key,version,revision,JSON.stringify(snapshot),at]);
  await pool.query('DELETE FROM business_dashboard_cache WHERE cache_key NOT IN (SELECT cache_key FROM business_dashboard_cache ORDER BY generated_at DESC LIMIT 400)');
  res.json({ok:true,generatedAt:at});
 }));
}
