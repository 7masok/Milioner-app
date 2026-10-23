// Confirmed days remain readable even when the provider cannot refresh them.
const DAY=86400000;
const stamp=day=>Date.parse(day+'T00:00:00+05:00');
const date=t=>new Date(t+18000000).toISOString().slice(0,10);
export function createPerformanceDaily({scope,read,write,readDays,loadDay,settled,now=Date.now,schedule=setTimeout,cancel=clearTimeout,historyFrom='2025-01-01',enabled=()=>true,onProgress=()=>{}}){
 let state=null,initializing=null,timer=null,timerAt=Infinity,running=null,saveChain=Promise.resolve();
 const key=()=>scope()+':daily-plan-v1';
 async function init(){if(state)return state;return initializing||=(async()=>{const old=await read(key());state={requests:[],cursor:date(now()-DAY),...old};return state})().catch(error=>{initializing=null;throw error})}
 function save(){const value=structuredClone(state);saveChain=saveChain.catch(()=>{}).then(()=>write(key(),value));return saveChain}
 function usable(entry){return Boolean(entry?.data&&!entry.data.error&&Array.isArray(entry.data.rows))}
 function ready(entry,day){if(!usable(entry))return false;const end=stamp(day)+DAY,at=Number(entry.at)||0;if(now()>=end+2*DAY&&at>=end+2*DAY)return true;return now()-at<(day===date(now())?60:360)*60000}
 function wake(delay=0){const at=now()+Math.max(0,delay);if(timer!==null){if(timerAt<=at)return;cancel(timer)}timerAt=at;timer=schedule(()=>{timer=null;timerAt=Infinity;tick().catch(()=>wake(60000))},Math.max(0,delay));timer?.unref?.()}
 async function request(from,to){await init();if(!state.requests.some(r=>r.from===from&&r.to===to)){state.requests.unshift({from,to});state.requests=state.requests.slice(0,8);await save()}wake()}
 async function tick(){if(running)return running;running=(async()=>{
  if(!enabled())return;await init();const cooldown=await read(scope()+':cooldown');if(Number(cooldown?.retryAt)>now()){wake(Number(cooldown.retryAt)-now());return}
  let selected=null;const ranges=[];
  for(const range of state.requests){const days=await readDays(range.from,range.to);ranges.push({range,days});for(let t=stamp(range.to);t>=stamp(range.from);t-=DAY){const day=date(t);if(!usable(days.get(day))){selected={day,entry:days.get(day),archive:false};break}}if(selected)break}
  // Missing days take precedence over refreshing previously saved days.
  const today=date(now());
  if(!selected){const recent=await readDays(date(now()-2*DAY),today);for(let t=stamp(today);t>=stamp(today)-2*DAY;t-=DAY){const day=date(t);if(!usable(recent.get(day))){selected={day,entry:recent.get(day),archive:false};break}}}
  if(!selected){for(const {range,days}of ranges){for(let t=stamp(range.to);t>=stamp(range.from);t-=DAY){const day=date(t);if(!ready(days.get(day),day)){selected={day,entry:days.get(day),archive:false};break}}if(selected)break}if(!selected){state.requests=[];await save()}}
  if(!selected){const recent=await readDays(date(now()-2*DAY),today);for(let t=stamp(today);t>=stamp(today)-2*DAY;t-=DAY){const day=date(t);if(!ready(recent.get(day),day)){selected={day,entry:recent.get(day),archive:false};break}}}
  if(!selected){while(state.cursor>=historyFrom){const day=state.cursor,days=await readDays(day,day);if(!ready(days.get(day),day)){selected={day,entry:days.get(day),archive:true};break}state.cursor=date(stamp(day)-DAY)}await save()}
  if(!selected){wake(60000);return}
  const {day,entry,archive}=selected;await loadDay(day,{force:usable(entry)});await settled();
  // Read the committed result, rather than calling get again (which can enqueue
  // another refresh when the component cache TTL differs from the daily TTL).
  const saved=(await readDays(day,day)).get(day),failure=Number(saved?.retryAt)>now()?saved:null;
  if(!usable(saved)||failure){wake(Math.max(60000,(Number(failure?.retryAt)||0)-now()));return}
  onProgress({day,rows:saved.data.rows.length,archive});if(archive)state.cursor=date(stamp(day)-DAY);await save();wake(archive?60000:5000);
 })().finally(()=>{running=null});return running}
 function aggregate(from,to,days){const bySku=new Map(),daily=[];let at=Infinity,stale=false;for(let t=stamp(from);t<=stamp(to);t+=DAY){const day=date(t),entry=days.get(day);if(!usable(entry))return null;stale||=!ready(entry,day);at=Math.min(at,Number(entry.at));daily.push({day,totalSpent:entry.data.totalSpent});for(const row of entry.data.rows){const prev=bySku.get(row.sku)||{sku:row.sku,title:row.title||'',spent:0,orders:0};prev.spent+=Number(row.spent)||0;prev.orders+=Number(row.orders)||0;bySku.set(row.sku,prev)}}const rows=[...bySku.values()];return{from,to,rows,daily,totalSpent:rows.reduce((n,r)=>n+r.spent,0),pending:false,cached:true,stale,source:'daily-cache',updatedAt:at}}
 return{
  async get(from,to){await init();const days=await readDays(from,to),data=aggregate(from,to,days),cooldown=await read(scope()+':cooldown'),failure=Number(cooldown?.retryAt)>now()?cooldown:[...days.values()].find(entry=>Number(entry.retryAt)>now())||null,coveredDays=[...days.values()].filter(usable).length,totalDays=Math.round((stamp(to)-stamp(from))/DAY)+1;
   const progress={coveredDays,totalDays,...(failure?{error:failure.error,retryAt:failure.retryAt,limited:failure.limited}:{})};
   if(data){if(data.stale)await request(from,to);return{...data,...progress,stale:data.stale||Boolean(failure),refreshing:data.stale&&!failure}}
   await request(from,to);const old=await read(scope()+':'+from+':'+to);
   if(usable(old))return{...old.data,...progress,pending:false,cached:true,stale:true,refreshing:!failure};
   return{from,to,rows:[],totalSpent:0,...progress,pending:!failure,source:failure?'error':'daily-cache'};
  },
  async start(){await init();wake()},tick,
  stop(){if(timer!==null)cancel(timer);timer=null;timerAt=Infinity},ready
 };
}
