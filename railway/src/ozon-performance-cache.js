// Exact-period snapshots. A failed refresh never replaces a successful SKU report.
export function createPerformanceCache({read,write,build,scope,now=Date.now,ttl=15*60*1000}) {
 const entries=new Map(),jobs=new Map();let chain=Promise.resolve();
 async function stored(key){
  if(entries.has(key))return entries.get(key);
  const task=Promise.resolve(read(key)).catch(()=>null).then(value=>value||{});
  entries.set(key,task);const value=await task;entries.set(key,value);return value;
 }
 async function save(key,value){entries.set(key,value);await write(key,value)}
 function start(key,from,to){
  if(jobs.has(key))return;
  const job=chain.catch(()=>{}).then(async()=>{
   const current=await stored(key),cooldown=await stored(scope()+':cooldown');
   if(Number(current.retryAt)>now()||Number(cooldown.retryAt)>now())return;
   try{
    const data=await build(from,to);
    if(data.error)throw Object.assign(new Error(data.error),{retryAt:data.retryAt,limited:data.limited});
    await save(key,{data:{...data,from,to,updatedAt:data.updatedAt||now()},at:now(),retryAt:0}).catch(()=>{});
   }catch(error){
    const retryAt=Math.max(now()+1000,Number(error.retryAt)||now()+5*60*1000),message=String(error.userMessage||error.message||error),limited=error.limited===true||['DAILY_LIMIT','RATE_LIMIT','COOLDOWN'].includes(error.code);
    const failure={...current,error:message,retryAt,limited};
    await save(key,failure).catch(()=>{});
    if(limited)await save(scope()+':cooldown',{error:message,retryAt,limited:true}).catch(()=>{});
   }
  }).finally(()=>jobs.delete(key));
  jobs.set(key,job);chain=job;
 }
 return {
  async get(from,to){
   const key=scope()+':'+from+':'+to,[entry,cooldown]=await Promise.all([stored(key),stored(scope()+':cooldown')]);
   const failure=Number(cooldown.retryAt)>now()?cooldown:Number(entry.retryAt)>now()?entry:null;
   const historical=to<new Date(now()-2*86400000).toISOString().slice(0,10),fresh=entry.data&&now()-Number(entry.at)<(historical?6*60*60*1000:ttl);
   if(!fresh&&!failure)start(key,from,to);
   if(entry.data)return {...entry.data,pending:false,stale:!fresh||Boolean(failure),refreshing:!fresh&&!failure,...(failure?{error:failure.error,retryAt:failure.retryAt,limited:failure.limited}:{}),cached:true};
   return {from,to,rows:[],totalSpent:0,pending:!failure,...(failure?{error:failure.error,retryAt:failure.retryAt,limited:failure.limited,source:'error'}:{})};
  },
  async settled(){await chain.catch(()=>{})}
 };
}
