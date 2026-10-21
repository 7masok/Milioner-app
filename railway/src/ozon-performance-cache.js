// Exact-period snapshots. A failed refresh never replaces a successful SKU report.
export function createPerformanceCache({read,write,build,scope,now=Date.now,ttl=15*60*1000,schedule=setTimeout,cancel=clearTimeout,maxEntries=64}) {
 const entries=new Map(),jobs=new Map();let chain=Promise.resolve();
 const retries=new Map();let timer=null;
 function remember(key,value){entries.delete(key);entries.set(key,value);while(entries.size>maxEntries){const victim=[...entries.keys()].find(k=>k!==key&&!k.endsWith(':cooldown')&&!jobs.has(k));if(!victim)break;entries.delete(victim)}}
 function arm(){
  if(timer!==null)cancel(timer);timer=null;
  if(!retries.size)return;
  const at=Math.min(...[...retries.values()].map(x=>x.at));
  timer=schedule(()=>{
   timer=null;
   for(const [key,request]of retries)if(request.at<=now()){retries.delete(key);start(key,request.from,request.to)}
   arm();
  },Math.max(1000,Math.min(2147483647,at-now())));timer?.unref?.();
 }
 function retry(key,from,to,at){
  retries.delete(key);retries.set(key,{from,to,at});
  // Keep only the eight most recently requested ranges; upstream jobs remain serial.
  while(retries.size>8)retries.delete(retries.keys().next().value);
  arm();
 }
 async function stored(key){
  if(entries.has(key))return entries.get(key);
  const task=Promise.resolve(read(key)).catch(()=>null).then(value=>value||{});
  remember(key,task);const value=await task;remember(key,value);return value;
 }
 async function save(key,value){remember(key,value);await write(key,value)}
 function start(key,from,to){
  if(jobs.has(key))return;
  const job=chain.catch(()=>{}).then(async()=>{
   const current=await stored(key),cooldown=await stored(scope()+':cooldown');
   const blockedUntil=Math.max(Number(current.retryAt)||0,Number(cooldown.retryAt)||0);
   if(blockedUntil>now()){retry(key,from,to,blockedUntil);return;}
   try{
    const data=await build(from,to);
    if(data.error)throw Object.assign(new Error(data.error),{retryAt:data.retryAt,limited:data.limited});
    await save(key,{data:{...data,from,to,updatedAt:data.updatedAt||now()},at:now(),retryAt:0}).catch(()=>{});
   }catch(error){
    const retryAt=Math.max(now()+1000,Number(error.retryAt)||now()+5*60*1000),message=String(error.userMessage||error.message||error),limited=error.limited===true||['DAILY_LIMIT','RATE_LIMIT','COOLDOWN'].includes(error.code);
    const failure={...current,error:message,retryAt,limited};
    await save(key,failure).catch(()=>{});
    if(limited)await save(scope()+':cooldown',{error:message,retryAt,limited:true}).catch(()=>{});
    retry(key,from,to,retryAt);
   }
  }).finally(()=>jobs.delete(key));
  jobs.set(key,job);chain=job;
 }
 return {
  async get(from,to,{force=false}={}){
   const key=scope()+':'+from+':'+to,[entry,cooldown]=await Promise.all([stored(key),stored(scope()+':cooldown')]);
   const failure=Number(cooldown.retryAt)>now()?cooldown:Number(entry.retryAt)>now()?entry:null;
   const historical=to<new Date(now()-2*86400000).toISOString().slice(0,10),fresh=!force&&entry.data&&now()-Number(entry.at)<(historical?6*60*60*1000:ttl);
   if(!fresh&&!failure)start(key,from,to);
   if(!fresh&&failure)retry(key,from,to,Number(failure.retryAt));
   if(entry.data)return {...entry.data,pending:false,stale:!fresh||Boolean(failure),refreshing:!fresh&&!failure,...(failure?{error:failure.error,retryAt:failure.retryAt,limited:failure.limited}:{}),cached:true};
   return {from,to,rows:[],totalSpent:0,pending:!failure,...(failure?{error:failure.error,retryAt:failure.retryAt,limited:failure.limited,source:'error'}:{})};
  },
  async settled(){await chain.catch(()=>{})}
 };
}
