import {reportStoreStartDate} from './report-history-range.js';
const DAY=86400000,OFFSET=18000000;
const time=value=>value===null||value===undefined||value===''||value===0||value==='0'?0:Number.isFinite(Number(value))&&Number(value)>0?Number(value):Date.parse(value)||0;
const object=value=>{try{return typeof value==='string'?JSON.parse(value):value||{}}catch{return{}}};
export function historyProgress({from=0,to=0,goal=0,complete=false,error='',nextAt=0,updatedAt=0,requiredTo=0},now=Date.now()){
 from=time(from);to=time(to);goal=time(goal);nextAt=time(nextAt);updatedAt=time(updatedAt);
 const covered=Boolean(from&&from<=goal&&to>=(time(requiredTo)||Math.floor((now+OFFSET)/DAY)*DAY-OFFSET));
 // A recent heartbeat proves work, not complete history. A silent worker must
 // never leave an animated "loading" label behind indefinitely.
 const status=covered&&complete?'ready':error?'paused':nextAt>now+180000?'waiting':updatedAt&&now-updatedAt<180000?'loading':'unknown';
 return {status,from:from||null,to:to||null,targetFrom:goal||null,nextAt:nextAt>now?nextAt:null,updatedAt:updatedAt||null,error:String(error||'').slice(0,220)};
}
export async function readBusinessProgress(client,market,now=Date.now(),range=null){
 const markets=market==='all'?['Kaspi','WB','WB2','Ozon']:[market],wb=markets.filter(m=>m==='WB'||m==='WB2');
 const [warehouse,orders,kaspi,finance,ozon]=await Promise.all([
  client.query('SELECT payload FROM warehouse_state WHERE id=1'),
  wb.length?client.query('SELECT market,payload,updated_at FROM wb_order_history_state WHERE market=ANY($1::text[])',[wb]):{rows:[]},
  markets.includes('Kaspi')?client.query('SELECT payload,updated_at FROM kaspi_order_history_state WHERE id=1'):{rows:[]},
  wb.length?client.query('SELECT market,state FROM wb_finance_history WHERE market=ANY($1::text[])',[wb]):{rows:[]},
  markets.includes('Ozon')?client.query(`SELECT account,updated_at,
   payload->'postings'->>'from' AS orders_from,payload->'postings'->>'to' AS orders_to,
   payload->'postings'->>'updatedAt' AS orders_at,payload->>'historyRetryAt' AS orders_retry,
   payload->'errors'->>'postings' AS orders_error,
   payload->'finance'->>'from' AS finance_from,payload->'finance'->>'to' AS finance_to,
   payload->'finance'->>'updatedAt' AS finance_at,payload->>'financeRetryAt' AS finance_retry,
   payload->'errors'->>'finance' AS finance_error FROM ozon_fbo_cache`):{rows:[]}
 ]);
 const sources=[],floor=range?.from||Math.floor((now+OFFSET)/DAY)*DAY-OFFSET-364*DAY,requiredTo=range?Math.min(range.to,Math.floor((now+OFFSET)/DAY)*DAY-OFFSET):0;
 for(const m of markets){
  const start=reportStoreStartDate(warehouse.rows[0]?.payload,m),goal=Math.max(floor,start?Date.parse(start+'T00:00:00+05:00'):0);
  if(range&&goal>=range.to){for(const kind of ['orders','finance'])sources.push({market:m,kind,status:'ready',beforeOpening:true,from:goal,to:range.to,targetFrom:goal,nextAt:null,updatedAt:null,error:''});continue}
  if(m==='Ozon'){
   if(!ozon.rows.length){sources.push({market:m,kind:'orders',...historyProgress({goal,requiredTo},now)},{market:m,kind:'finance',...historyProgress({goal,requiredTo},now)});continue}
   for(const row of ozon.rows)for(const kind of ['orders','finance'])sources.push({market:m,kind,...historyProgress({goal,requiredTo,from:row[kind+'_from'],to:row[kind+'_to'],updatedAt:row[kind+'_at'],nextAt:row[kind+'_retry'],error:row[kind+'_error'],complete:true},now)});
  }else{
   const row=m==='Kaspi'?kaspi.rows[0]:orders.rows.find(r=>r.market===m),state=object(row?.payload),base={goal,requiredTo,from:state.coveredFrom,to:state.anchor,updatedAt:row?.updated_at,nextAt:state.nextAllowedAt,error:state.lastError,complete:state.complete};
   sources.push({market:m,kind:'orders',...historyProgress(base,now)});
   if(m==='Kaspi')sources.push({market:m,kind:'finance',...historyProgress(base,now)});
   else{const f=object(finance.rows.find(r=>r.market===m)?.state),archive=f.archive||{};sources.push({market:m,kind:'finance',...historyProgress({goal,requiredTo,from:archive.complete?Date.parse(archive.dateFrom+'T00:00:00+03:00'):0,to:archive.dateTo?Date.parse(archive.dateTo+'T00:00:00+03:00')+DAY:0,complete:archive.complete,updatedAt:f.updatedAt,nextAt:f.nextAllowedAt,error:f.lastError},now)})}
  }
 }
 return {ok:true,market,checkedAt:now,sources};
}
