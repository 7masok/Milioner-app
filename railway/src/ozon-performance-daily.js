// Reuse confirmed daily SKU reports across every overlapping screen range.
// The worker uses the existing serial provider queue, persisted UUIDs and cooldown.
const DAY=86400000;
const stamp=day=>Date.parse(day+'T00:00:00+05:00');
const date=t=>new Date(t+18000000).toISOString().slice(0,10);
export function createPerformanceDaily({scope,read,write,readDays,loadDay,settled,now=Date.now,schedule=setTimeout,cancel=clearTimeout,historyFrom='2025-01-01',enabled=()=>true,onProgress=()=>{}}){
 let state=null,initializing=null,timer=null,running=null,saveChain=Promise.resolve();
 const key=()=>scope()+':daily-plan-v1';
 async function init(){if(state)return state;return initializing||=(async()=>{const old=await read(key());state={requests:[],cursor:date(now()-DAY),...old};return state})().catch(error=>{initializing=null;throw error})}
 function save(){const value=structuredClone(state);saveChain=saveChain.catch(()=>{}).then(()=>write(key(),value));return saveChain}
 function ready(entry,day){if(!entry?.data||entry.data.error||!Array.isArray(entry.data.rows))return false;const end=stamp(day)+DAY,at=Number(entry.at)||0;return now()>=end+2*DAY&&at>=end+2*DAY||now()-at<15*60000}
 function wake(delay=0){if(timer!==null)return;timer=schedule(()=>{timer=null;tick().catch(()=>wake(60000))},Math.max(0,delay));timer?.unref?.()}
 async function request(from,to){await init();if(!state.requests.some(r=>r.from===from&&r.to===to)){state.requests.unshift({from,to});state.requests=state.requests.slice(0,8);await save()}wake()}
 async function tick(){if(running)return running;running=(async()=>{
  if(!enabled())return;await init();let selected=null;
  while(state.requests.length){const range=state.requests[0],days=await readDays(range.from,range.to);for(let t=stamp(range.to);t>=stamp(range.from);t-=DAY){const day=date(t);if(!ready(days.get(day),day)){selected={day,entry:days.get(day),archive:false};break}}if(selected)break;state.requests.shift();await save()}
  // Refresh the recent daily basis, then walk the historical archive backwards.
  if(!selected){const today=date(now()),recent=await readDays(date(now()-2*DAY),today);for(let t=stamp(today);t>=stamp(today)-2*DAY;t-=DAY){const day=date(t);if(!ready(recent.get(day),day)){selected={day,entry:recent.get(day),archive:false};break}}}
  if(!selected){while(state.cursor>=historyFrom){const day=state.cursor,days=await readDays(day,day);if(!ready(days.get(day),day)){selected={day,entry:days.get(day),archive:true};break}state.cursor=date(stamp(day)-DAY)}await save()}
  if(!selected){wake(60000);return}
  const {day,entry,archive}=selected;await loadDay(day,{force:Boolean(entry?.data)});await settled();const result=await loadDay(day);
  if(result.error||result.pending||result.refreshing){wake(Math.max(60000,(Number(result.retryAt)||0)-now()));return}
  onProgress({day,rows:result.rows?.length||0,archive});if(archive)state.cursor=date(stamp(day)-DAY);await save();wake(5000);
 })().finally(()=>{running=null});return running}
 function aggregate(from,to,days){const bySku=new Map(),daily=[];let at=Infinity;for(let t=stamp(from);t<=stamp(to);t+=DAY){const day=date(t),entry=days.get(day);if(!ready(entry,day))return null;at=Math.min(at,Number(entry.at));daily.push({day,totalSpent:entry.data.totalSpent});for(const row of entry.data.rows){const prev=bySku.get(row.sku)||{sku:row.sku,title:row.title||'',spent:0,orders:0};prev.spent+=Number(row.spent)||0;prev.orders+=Number(row.orders)||0;bySku.set(row.sku,prev)}}const rows=[...bySku.values()];return{from,to,rows,daily,totalSpent:rows.reduce((n,r)=>n+r.spent,0),pending:false,cached:true,source:'daily-cache',updatedAt:at}}
 return{
  async get(from,to){await init();const days=await readDays(from,to),data=aggregate(from,to,days);if(data)return data;await request(from,to);const old=await read(scope()+':'+from+':'+to),cooldown=await read(scope()+':cooldown'),failure=Number(cooldown?.retryAt)>now()?cooldown:[...days.values()].find(entry=>Number(entry.retryAt)>now())||null,coveredDays=[...days].filter(([day,entry])=>ready(entry,day)).length,totalDays=Math.round((stamp(to)-stamp(from))/DAY)+1;
   const progress={coveredDays,totalDays,...(failure?{error:failure.error,retryAt:failure.retryAt,limited:failure.limited}:{})};
   if(old?.data)return{...old.data,...progress,pending:false,cached:true,stale:true,refreshing:!failure};
   return{from,to,rows:[],totalSpent:0,...progress,pending:!failure,source:failure?'error':'daily-cache'};
  },
  async start(){await init();wake()},
  tick,
  stop(){if(timer!==null)cancel(timer);timer=null},
  ready
 };
}
