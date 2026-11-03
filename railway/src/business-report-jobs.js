import {pool} from './db.js';
import {REPORT_HISTORY_FROM} from './report-history-range.js';
export const REPORT_DAY=86400000,REPORT_MARKETS=['Kaspi','WB','WB2','Ozon'];
let ready;
export function ensureBusinessReportJobs(){return ready ||= pool.query(`CREATE TABLE IF NOT EXISTS business_report_jobs (
 job_key TEXT PRIMARY KEY,market TEXT NOT NULL,range_from BIGINT NOT NULL,range_to BIGINT NOT NULL,
 priority INTEGER NOT NULL DEFAULT 0,next_at BIGINT NOT NULL DEFAULT 0,started_at BIGINT NOT NULL DEFAULT 0,
 completed_at BIGINT NOT NULL DEFAULT 0,source_revision TEXT NOT NULL DEFAULT '',last_error TEXT NOT NULL DEFAULT ''
)`).catch(e=>{ready=null;throw e})}
export async function queueBusinessReports(market,from,to,{client=pool,now=Date.now(),priority=1}={}){
 await ensureBusinessReportJobs();
 for(const m of market==='all'?REPORT_MARKETS:[market]){
  if(!REPORT_MARKETS.includes(m))continue;
  const first=priority<2?REPORT_HISTORY_FROM+Math.floor((from-REPORT_HISTORY_FROM)/(28*REPORT_DAY))*28*REPORT_DAY:from;
  for(let start=first;start<to;start+=28*REPORT_DAY){const end=Math.min(to,start+28*REPORT_DAY);
   await client.query(`INSERT INTO business_report_jobs(job_key,market,range_from,range_to,priority,next_at) VALUES($1,$2,$3,$4,$5,$6)
    ON CONFLICT(job_key) DO UPDATE SET range_to=GREATEST(business_report_jobs.range_to,excluded.range_to),priority=GREATEST(business_report_jobs.priority,excluded.priority),
    next_at=CASE WHEN business_report_jobs.completed_at<$6::bigint-60000 AND business_report_jobs.started_at<$6::bigint-60000 THEN LEAST(business_report_jobs.next_at,$6) ELSE business_report_jobs.next_at END`,[m+':'+start,m,start,end,priority,now]);
  }
 }
}
export async function readBusinessPreparation(client,market,range){
 await ensureBusinessReportJobs();
 const markets=market==='all'?REPORT_MARKETS:[market],from=range.from,to=range.to;
 const [jobs,records]=await Promise.all([
  client.query('SELECT range_from,range_to,completed_at,started_at,next_at,last_error FROM business_report_jobs WHERE market=ANY($1::text[]) AND range_from<$3 AND range_to>$2',[markets,from,to]),
  client.query(`SELECT payload->>'market' AS market,(payload->'bounds'->>'start')::bigint AS start,generated_at,
   (COALESCE((payload->>'ordersReady')::boolean,false) OR NOT COALESCE((payload->>'pending')::boolean,false)) AND jsonb_array_length(COALESCE(payload->'ordersPartialMarkets','[]'::jsonb))=0 AS orders_ready,
   NOT COALESCE((payload->>'pending')::boolean,false) AND jsonb_array_length(COALESCE(payload->'summary'->'missingMarkets','[]'::jsonb))=0 AND NOT COALESCE((payload->'summary'->>'partialOzonHistory')::boolean,false) AS finance_ready
   FROM business_dashboard_cache WHERE cache_key LIKE 'base:%' AND payload->>'serverPrepared'='true' AND payload->>'market'=ANY($1::text[]) AND (payload->'bounds'->>'start')::bigint >=$2 AND (payload->'bounds'->>'start')::bigint <$3`,[markets,from,to])
 ]);
 const byDay=new Map();for(const r of records.rows){const day=byDay.get(Number(r.start))||new Map();day.set(r.market,r);byDay.set(Number(r.start),day)}
 let saved=0,orders=0,finance=0;const savedDays=[],orderDays=[],financeDays=[];for(let start=from;start<to;start+=REPORT_DAY){const rows=markets.map(m=>byDay.get(start)?.get(m));if(rows.every(Boolean)){saved++;savedDays.push(start)}if(rows.every(r=>r?.orders_ready)){orders++;orderDays.push(start)}if(rows.every(r=>r?.finance_ready)){finance++;financeDays.push(start)}}
 const errors=jobs.rows.filter(j=>j.last_error),working=jobs.rows.some(j=>(!Number(j.started_at)||Number(j.started_at)>Number(j.completed_at))&&!j.last_error);
 return {serverManaged:true,from,to,total:Math.ceil((to-from)/REPORT_DAY),saved,savedDays,orders,finance,orderDays,financeDays,status:errors.length?'retry':working?'loading':orders<Math.ceil((to-from)/REPORT_DAY)||finance<Math.ceil((to-from)/REPORT_DAY)?'waiting':'ready',
  nextAt:jobs.rows.length?Math.min(...jobs.rows.map(j=>Number(j.next_at)||0)):0,error:errors.length?'Сервер повторит расчёт автоматически':'',
  revisions:jobs.rows.filter(j=>Number(j.completed_at)>0).map(j=>({from:Number(j.range_from),to:Number(j.range_to),at:Number(j.completed_at)})).sort((a,b)=>a.from-b.from||a.to-b.to||a.at-b.at)};
}
