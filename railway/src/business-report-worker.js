import {pool,withDatabaseReadClient} from './db.js';
import {config} from './config.js';
import {readBusinessProgress} from './business-dashboard-progress.js';
import {REPORT_HISTORY_FROM} from './report-history-range.js';
import {ensureCache,sourceRevision,validBusinessDay,BUSINESS_CACHE_VERSION} from './business-dashboard-cache.js';
import {ensureBusinessReportJobs,queueBusinessReports,REPORT_DAY,REPORT_MARKETS} from './business-report-jobs.js';
import {createBusinessReportRuntime} from './business-report-runtime.js';
import {readBusinessReportApi} from './business-report-reader.js';
import {hydrateWarehouseProducts} from './warehouse-products.js';
import {hydrateWarehousePurchases} from './warehouse-purchases.js';
import {hydrateWarehouseSales} from './warehouse-sales.js';
import {hydrateKaspiAdExpenses} from './warehouse-kaspi-ads.js';
const forecasts=new Map();
const midnight=t=>Math.floor((t+18000000)/REPORT_DAY)*REPORT_DAY-18000000;
export function businessOzonFeed(payload,products){
 const aliases=new Map();for(const p of products||[])for(const key of [p.ozon,...(Array.isArray(p.ozonAliases)?p.ozonAliases:[])].filter(Boolean)){const k=String(key),old=aliases.get(k);aliases.set(k,old===undefined?p.id:old===p.id?old:null)}
 const out=[];for(const a of payload.accounts||[])for(const posting of a.postings?.rows||[])for(const [i,p]of(posting.products||[]).entries()){
  const id=String(posting.posting_number||'');if(!id)continue;const sku=String(p.sku||p.offer_id||''),qty=Math.max(0,Number(p.quantity)||0),price=Number(p.price)||0;
  out.push({market:'Ozon',orderId:String(a.account||'')+':'+id,code:id,entryId:id+'_'+sku+'_'+i,sku,productName:String(p.name||p.offer_id||''),qty,unitPrice:price,totalPrice:qty*price,
   creationDate:Date.parse(posting.created_at||posting.in_process_at||'')||0,deliveredDate:Date.parse(posting.delivered_date||'')||0,status:String(posting.status||'new').toLowerCase(),productId:aliases.get(sku)||aliases.get(String(p.offer_id||''))||null});
 }
 return out;
}
export async function loadBusinessReportState(client){
 const row=(await client.query('SELECT payload FROM warehouse_state WHERE id=1')).rows[0];let state=typeof row?.payload==='string'?JSON.parse(row.payload):structuredClone(row?.payload||{});
 state=await hydrateWarehouseProducts(client,state);state=await hydrateWarehousePurchases(client,state);state=await hydrateWarehouseSales(client,state);state=await hydrateKaspiAdExpenses(client,state);
 state.settings||={};state.kaspiOrderFeed=[];state.wbOrderFeed=[];return state;
}
export async function calculateBusinessReportJob(job,{client,readApi=readBusinessReportApi,now=Date.now(),revision=null}={}){
 const state=await loadBusinessReportState(client),from=Number(job.range_from),to=Number(job.range_to),market=job.market;
 const result=market==='Ozon'?{orders:[]}:await readApi('/api/orders?market='+market+'&after='+from+'&before='+to+'&history=1&limit=15000');
 if(!Array.isArray(result.orders)||result.orders.length>=15000)throw Error('Слишком большой диапазон заказов');
 const orders=result.orders.filter(r=>Number(r.creationDate)>=from&&Number(r.creationDate)<to).map(r=>config.storeProfile==='WB3'?{...r,market:'WB',status:['RETURN','RETURNDEFECTIVE'].includes(String(r.status).toUpperCase())?'CANCELLED':r.status}:r);
 state.kaspiOrderFeed=orders.filter(r=>r.market==='Kaspi');state.wbOrderFeed=orders.filter(r=>r.market==='WB'||r.market==='WB2');
 const ozon=market==='Ozon'?await readApi('/api/ozon-fbo?compact=1'):{accounts:[]},feed=businessOzonFeed(ozon,state.products);
 const runtime=createBusinessReportRuntime({state,market,readApi,now,forecastMarkets:config.storeProfile==='WB3'?['WB']:REPORT_MARKETS}),key=revision?revision+':'+midnight(now):'uncached';
 let unitProfit=revision?forecasts.get(key):null;if(!unitProfit){unitProfit=await runtime.forecast();if(revision&&!unitProfit.incompleteSources?.length){forecasts.clear();forecasts.set(key,unitProfit)}}
 const days=await runtime.calculate({from,to,orders:[...orders,...feed],ozonFeed:feed,unitProfit});
 const history=await readBusinessProgress(client,market,now,{from,to}),financeKnown=history.sources.filter(s=>s.kind==='finance').every(s=>s.status==='ready');
 const liveHistory=config.storeProfile==='WB3'?result.sync?.find(s=>s.source==='statistics'&&Number(s.lastSuccessAt)>0&&!s.more):null;
 const coverage=result.historyCoverage?.find(x=>x.market===market)||(liveHistory?{from:midnight(now)-89*REPORT_DAY,gaps:[{from:Number(liveHistory.lastSuccessAt),to:now}]}:null),opening=state.settings.reportStoreStarts?.[market],opened=opening?Date.parse(opening+'T00:00:00+05:00'):0;
 for(const day of days){const start=day.bounds.start,end=day.bounds.end;
  if(opened&&end<=opened){day.beforeOpening=true;day.ordersPartialMarkets=[];continue}
  const missing=market==='Ozon'?(ozon.accounts||[]).some(a=>!(Date.parse(a.postings?.from||'')<=start&&Date.parse(a.postings?.to||'')>=Math.min(end,midnight(now)))):
   !coverage||!(Number(coverage.from)>0)||Number(coverage.from)>Math.max(start,opened)||[...(coverage.gaps||[]),...(coverage.repairs||[])].some(g=>g.from<end&&g.to>start);
  if(missing)day.ordersPartialMarkets=[market];
  if(!financeKnown&&!day.summary.missingMarkets?.includes(market)){day.summary.missingMarkets=[...(day.summary.missingMarkets||[]),market];day.summary.estimated=true;}
  if(!validBusinessDay(day))throw Error('Серверный расчёт вернул некорректную дневную основу');
 }
 return days;
}
let lastSeed=0;
export async function runBusinessReportWorker({clientPool=pool,now=Date.now(),calculate=calculateBusinessReportJob}={}){
 await ensureCache();await ensureBusinessReportJobs();
 const client=await clientPool.connect();let locked=false,job;
 try{
  locked=Boolean((await client.query('SELECT pg_try_advisory_lock(730150,1) AS locked')).rows[0]?.locked);if(!locked)return;
  job=(await client.query('SELECT * FROM business_report_jobs WHERE next_at<=$1 ORDER BY priority DESC,(started_at=0) DESC,started_at,range_to DESC LIMIT 1',[now])).rows[0];if(!job)return;
  await client.query('UPDATE business_report_jobs SET started_at=$2,next_at=$2::bigint+120000,last_error=\'\' WHERE job_key=$1',[job.job_key,now]);
  let days,revision;
  // The same database connection is inherited by existing report GET handlers.
  // Database READ ONLY is an additional guard against accidental inventory writes.
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try{await client.query("SET LOCAL statement_timeout='25s'");await withDatabaseReadClient(client,async()=>{revision=await sourceRevision();days=await calculate(job,{client,now,revision})});await client.query('COMMIT')}
  catch(error){await client.query('ROLLBACK');throw error}
  if(!Array.isArray(days)||days.length!==(Number(job.range_to)-Number(job.range_from))/REPORT_DAY||!days.every(validBusinessDay))throw Error('Неполный результат серверного расчёта');
  for(const day of days)day.serverPrepared=true;
  const at=Date.now(),rows=days.map(day=>({key:'base:'+day.bounds.start+':'+job.market,payload:day}));
  await client.query('BEGIN');
  try{
   // Persist the revision actually read, even if newer inputs have arrived. The
   // result remains explicitly stale and is retried automatically, never lost.
   await client.query(`INSERT INTO business_dashboard_cache(cache_key,version,source_revision,payload,generated_at)
    SELECT x->>'key',$2,$3,x->'payload',$4 FROM jsonb_array_elements($1::jsonb) x
    ON CONFLICT(cache_key) DO UPDATE SET version=excluded.version,source_revision=excluded.source_revision,payload=excluded.payload,generated_at=excluded.generated_at WHERE business_dashboard_cache.generated_at<=excluded.generated_at`,[JSON.stringify(rows),BUSINESS_CACHE_VERSION,revision,at]);
   const current=await withDatabaseReadClient(client,sourceRevision),partial=days.some(d=>d.ordersPartialMarkets?.length||d.summary?.missingMarkets?.length||d.pending);
   await client.query('UPDATE business_report_jobs SET completed_at=$2,next_at=$3,source_revision=$4,last_error=\'\',priority=CASE WHEN range_to-range_from<=172800000 AND range_to>$5 THEN 2 ELSE 0 END WHERE job_key=$1',[job.job_key,at,at+(current!==revision?15000:partial?300000:Number(job.range_to)>midnight(at)?60000:900000),revision,midnight(at)-REPORT_DAY]);
   await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error}
  console.info('BUSINESS_REPORT_PREPARED',JSON.stringify({market:job.market,from:Number(job.range_from),to:Number(job.range_to),days:days.length,at}));return{market:job.market,days:days.length,at};
 }catch(error){if(job)await client.query('UPDATE business_report_jobs SET last_error=$2,next_at=$3 WHERE job_key=$1',[job.job_key,String(error.message||'Расчёт временно недоступен').slice(0,200),Date.now()+60000]);console.warn('BUSINESS_REPORT_RETRY',JSON.stringify({market:job?.market,error:String(error.message).slice(0,200)}));return{error:String(error.message)}}
 finally{if(locked)await client.query('SELECT pg_advisory_unlock(730150,1)').catch(()=>{});client.release()}
}
let timer,running=false,warmed=false;
export function startBusinessReportLoop(){
 if(timer)return;
 const run=async()=>{if(running)return;running=true;try{
  await ensureCache();await ensureBusinessReportJobs();
  // Initialize the existing public cache table before entering READ ONLY.
  if(!warmed){if(config.storeProfile!=='WB3')await readBusinessReportApi('/api/ozon-fbo?compact=1');warmed=true;}
  const now=Date.now();if(now-lastSeed>15*60000){lastSeed=now;for(const market of config.storeProfile==='WB3'?['WB']:REPORT_MARKETS){await queueBusinessReports(market,midnight(now)-REPORT_DAY,midnight(now)+REPORT_DAY,{priority:2});await queueBusinessReports(market,REPORT_HISTORY_FROM,midnight(now)+REPORT_DAY,{priority:0})}}
  await runBusinessReportWorker();
 }catch(error){console.warn('BUSINESS_REPORT_LOOP',String(error.message).slice(0,200))}finally{running=false}};
 setTimeout(run,15000).unref();timer=setInterval(run,5000);timer.unref();
}
