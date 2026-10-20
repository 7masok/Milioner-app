import {pool} from './db.js';
import {reportHistoryGoal,historyBackfillWake} from './report-history-range.js';
import {config} from './config.js';
import {credentialFor} from './connections.js';

const DAY=86400000,API='https://kaspi.kz/shop/api/v2';
export const KASPI_HISTORY_STATES=['ARCHIVE','KASPI_DELIVERY','DELIVERY','PICKUP','SIGN_REQUIRED','NEW'];
const txt=v=>String(v??'').trim();
const object=v=>typeof v==='string'?JSON.parse(v):v;
const cancelled=new Set(['CANCELLED','CANCELLING','RETURNED','KASPI_DELIVERY_RETURN_REQUESTED']);
const statuses=new Set(['APPROVED_BY_BANK','ACCEPTED_BY_MERCHANT','COMPLETED','CANCELLED','CANCELLING','KASPI_DELIVERY_RETURN_REQUESTED','RETURNED']);
export function initialKaspiHistory(now,liveFrom=0){
 const anchor=Math.floor(now/1000)*1000,goal=reportHistoryGoal(now);
 const to=liveFrom>goal&&liveFrom<anchor?Math.min(anchor,liveFrom+DAY):anchor;
 return {version:1,anchor,goal,to,from:Math.max(goal,to-14*DAY+1),coveredFrom:liveFrom>0?Math.min(anchor,liveFrom):anchor,stateIndex:0,page:0,pending:[],pageCount:0,rows:0,complete:false,nextAllowedAt:0,lastError:''};
}
function resumeKaspiBackfill(state){
 state.complete=false;state.to=state.coveredFrom-1;state.from=Math.max(state.goal,state.to-14*DAY+1);state.stateIndex=0;state.page=0;state.pending=[];state.pageCount=0;
}
export function extendKaspiHistory(input,now){
 const state=structuredClone(input);state.goal=Math.min(Number(state.goal)||Infinity,reportHistoryGoal(now));
 if(state.complete&&!state.mode&&state.coveredFrom>state.goal){resumeKaspiBackfill(state);state.nextAllowedAt=historyBackfillWake(input,now,3000)}
 return state;
}
function compact(raw){
 const a=raw?.attributes||{},at=Number(a.creationDate);
 if(!txt(raw?.id)||!(at>0)||!Number.isSafeInteger(at)||!statuses.has(a.status)||!KASPI_HISTORY_STATES.includes(a.state))throw Error('Kaspi: некорректный заказ архива');
 if(a.totalPrice===null||a.totalPrice===undefined||a.totalPrice===''||!Number.isFinite(Number(a.totalPrice))||Number(a.totalPrice)<0)throw Error('Kaspi: неизвестная сумма заказа');
 return {id:txt(raw.id),code:txt(a.code)||txt(raw.id),status:a.status,state:a.state,creationDate:at,completionDate:Number.isSafeInteger(Number(a.completionDate))&&Number(a.completionDate)>0?Number(a.completionDate):0,approvedByBankDate:Number.isSafeInteger(Number(a.approvedByBankDate))?Number(a.approvedByBankDate):0,totalPrice:Number(a.totalPrice),deliveryCostForSeller:Number(a.deliveryCostForSeller)||0};
}
export function kaspiHistoryOrder(order,entries){
 if(!Array.isArray(entries)||(!entries.length&&!cancelled.has(order.status))||entries.length>1000)throw Error('Kaspi: состав заказа архива не получен');
 const seen=new Set();
 const rows=entries.map(e=>{
  const id=txt(e.entryId??e.id),qty=Number(e.qty??e.quantity),total=Number(e.totalPrice),sku=txt(e.sku??e.merchantCode);
  if(!id||seen.has(id)||!Number.isFinite(qty)||qty<=0||e.totalPrice===null||e.totalPrice===undefined||e.totalPrice===''||!Number.isFinite(total)||total<0)throw Error('Kaspi: некорректный состав архива');
  seen.add(id);
  return {market:'Kaspi',orderId:order.id,code:order.code,entryId:id,status:order.status,state:order.state,creationDate:order.creationDate,sku,productName:txt(e.productName),qty,totalPrice:total,unitPrice:total/qty,sellerDeliveryCost:null,marketplaceFee:null,historyOnly:true};
 });
 return {order:{...order,lines:rows.map(r=>({entryId:r.entryId,merchantCode:r.sku,productName:r.productName,quantity:r.qty,totalPrice:r.totalPrice,basePrice:r.unitPrice}))},rows};
}
function advancePage(s,now){
 s.pending=[];s.page++;
 if(s.page<s.pageCount)return;
 s.page=0;s.pageCount=0;s.stateIndex++;
 if(s.stateIndex<KASPI_HISTORY_STATES.length)return;
 s.stateIndex=0;s.coveredFrom=Math.min(s.coveredFrom,s.from);
 if(s.mode==='refresh'){s.anchor=s.to;s.complete=s.coveredFrom<=s.goal;delete s.mode;if(s.complete)s.nextAllowedAt=now+DAY;else{resumeKaspiBackfill(s);s.nextAllowedAt=now+3000}return;}
 if(s.from<=s.goal){s.complete=true;s.nextAllowedAt=now+DAY;return;}
 s.to=s.from-1;s.from=Math.max(s.goal,s.to-14*DAY+1);
}
export async function stepKaspiHistory(input,{now,fetchPage,fetchEntries}){
 const state=structuredClone(input),orders=[];state.nextAllowedAt=now+3000;
 if(state.complete){state.complete=false;state.mode='refresh';state.from=Math.max(state.goal,state.anchor-7*DAY);state.to=Math.min(now,state.anchor+7*DAY-1);state.stateIndex=0;state.page=0;state.pending=[];}
 if(!state.pending.length){
  const data=await fetchPage({from:state.from,to:state.to,state:KASPI_HISTORY_STATES[state.stateIndex],page:state.page});
  const count=Number(data?.meta?.pageCount??data?.meta?.totalPages);
  if(!Array.isArray(data?.data)||data.data.length>100||!Number.isInteger(count)||count<0||count>10000||(data.data.length&&count<=state.page))throw Error('Kaspi: неполная страница архива');
  if(!data.data.length&&count>state.page+1)throw Error('Kaspi: пустая страница внутри архива');
  state.pageCount=count;
  // Kaspi's state filter can use the state transition date. creationDate may
  // precede the requested interval; retain it unchanged for reporting.
  state.pending=data.data.map(compact);
  if(state.pending.some(o=>o.creationDate>state.anchor&&state.mode!=='refresh'))throw Error('Kaspi: заказ позднее границы архива');
  if(!state.pending.length)advancePage(state,now);
 }else{
  const batch=state.pending.slice(0,10);
  for(let i=0;i<batch.length;i+=2){
   const result=await Promise.all(batch.slice(i,i+2).map(async order=>{
    if(order.creationDate<state.goal)return null;
    return kaspiHistoryOrder(order,await fetchEntries(order));
   }));orders.push(...result.filter(Boolean));
  }
  state.pending.splice(0,batch.length);
  if(!state.pending.length)advancePage(state,now);
 }
 state.lastError='';return{state,orders};
}
export function kaspiHistoryStatus(s){return {market:'Kaspi',from:Number(s?.coveredFrom)||0,to:Number(s?.anchor)||0,targetFrom:Number(s?.goal)||0,rows:Number(s?.rows)||0,status:!s?'pending':s.lastError?'retry':s.complete?'complete':'loading',error:s?.lastError||'',nextAllowedAt:Number(s?.nextAllowedAt)||0};}
const productCache=new Map();let lastRequest=0;
export async function syncKaspiHistory({client=pool,token,fetcher=fetch,now=Date.now()}={}){
 token=token??await credentialFor('Kaspi',config.kaspiToken);if(!token)return;
 const db=await client.connect();let locked=false,state,recovery;
 const persist=()=>db.query('INSERT INTO kaspi_order_history_state(id,payload,updated_at) VALUES(1,$1::jsonb,$2) ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload,updated_at=EXCLUDED.updated_at',[JSON.stringify(state),now]);
 try{
  locked=Boolean((await db.query('SELECT pg_try_advisory_lock(730147,1) AS locked')).rows[0]?.locked);if(!locked)return;
  const found=(await db.query('SELECT payload FROM kaspi_order_history_state WHERE id=1')).rows[0];
  if(found)state=object(found.payload);
  else{const live=(await db.query("SELECT MIN(creation_date) AS first FROM marketplace_order_lines WHERE market='Kaspi' AND creation_date>0")).rows[0];state=initialKaspiHistory(now,Number(live?.first)||0);}
  state=extendKaspiHistory(state,now);
  if(state.nextAllowedAt>now)return;
  state.nextAllowedAt=now+60000;await persist();recovery=structuredClone(state);
  const request=async path=>{
   // A small paced queue belongs only to this reporting collector.
   const scheduled=Math.max(Date.now(),lastRequest+250);lastRequest=scheduled;
   if(scheduled>Date.now())await new Promise(r=>setTimeout(r,scheduled-Date.now()));
   const response=await fetcher(API+path,{headers:{Accept:'application/vnd.api+json','Content-Type':'application/vnd.api+json','X-Auth-Token':token},signal:AbortSignal.timeout(20000)});
   if(!response.ok){const error=Error('Kaspi: история HTTP '+response.status),v=response.headers?.get('retry-after');error.retryAt=Math.max(now+5*60000,Number(v)>0?Date.now()+Number(v)*1000:Date.parse(v)||0);throw error;}
   return response.json();
  };
  const live=new Map();if(state.pending.length){
   const ids=state.pending.slice(0,10).map(o=>o.id),data=await db.query("SELECT order_id,entry_id,sku,product_name,qty,total_price FROM marketplace_order_lines WHERE market='Kaspi' AND order_id=ANY($1::text[])",[ids]);
   for(const r of data.rows){const list=live.get(r.order_id)||[];list.push(r);live.set(r.order_id,list);}
  }
  const result=await stepKaspiHistory(state,{now,
   fetchPage:({from,to,state,page})=>request('/orders?'+new URLSearchParams({'page[number]':String(page),'page[size]':'100','filter[orders][state]':state,'filter[orders][creationDate][$ge]':String(from),'filter[orders][creationDate][$le]':String(to)})),
   fetchEntries:async order=>{
    const saved=live.get(order.id);
    if(saved?.length&&saved.every(r=>r.entry_id!=='__pending__'&&Number(r.qty)>0)&&Math.abs(saved.reduce((n,r)=>n+Number(r.total_price),0)-order.totalPrice)<.02)return saved.map(r=>({entryId:r.entry_id,sku:r.sku,productName:r.product_name,qty:r.qty,totalPrice:r.total_price}));
    let data;try{data=await request('/orders/'+encodeURIComponent(order.id)+'/entries')}catch(error){if(cancelled.has(order.status)&&/HTTP 404$/.test(error.message))return [];throw error;}
    if(!Array.isArray(data?.data))throw Error('Kaspi: состав архива недоступен');
    const out=[];
    for(const e of data.data){
     const a=e.attributes||{},master=txt(e.relationships?.product?.data?.id);let product=productCache.get(master);
     if(master&&!product){let p;try{p=await request('/masterproducts/'+encodeURIComponent(master)+'/merchantProduct')}catch(error){if(!/HTTP 404$/.test(error.message))throw error;}product={code:txt(p?.data?.attributes?.code),name:txt(p?.data?.attributes?.name)};if(productCache.size>1000)productCache.clear();productCache.set(master,product);}
     out.push({id:e.id,quantity:a.quantity,totalPrice:a.totalPrice,merchantCode:product?.code,productName:product?.name});
    }
    return out;
   }});
  await db.query('BEGIN');let inserted=0;
  for(const item of result.orders){const r=await db.query('INSERT INTO kaspi_order_history(order_id,creation_date,completion_date,payload,updated_at) VALUES($1,$2,$3,$4::jsonb,$5) ON CONFLICT(order_id) DO UPDATE SET completion_date=EXCLUDED.completion_date,payload=EXCLUDED.payload,updated_at=EXCLUDED.updated_at RETURNING (xmax=0) AS inserted',[item.order.id,item.order.creationDate,item.order.completionDate,JSON.stringify(item),now]);if(r.rows[0]?.inserted)inserted++;}
  state=result.state;state.rows+=inserted;await persist();await db.query('COMMIT');
  console.info('Kaspi order history progress',JSON.stringify({...kaspiHistoryStatus(state),phase:state.pending.length?'entries':'page',state:KASPI_HISTORY_STATES[state.stateIndex],page:state.page,inserted}));
 }catch(error){await db.query('ROLLBACK').catch(()=>{});state=recovery||state;if(state){state.lastError=/^Kaspi:/.test(error.message)?error.message:'Kaspi: не удалось сохранить историю';state.nextAllowedAt=Math.max(now+5*60000,Number(error.retryAt)||0);await persist();}console.warn('Kaspi order history retry',JSON.stringify(kaspiHistoryStatus(state)));}
 finally{if(locked)await db.query('SELECT pg_advisory_unlock(730147,1)').catch(()=>{});db.release();}
}
export async function readKaspiHistory(client,after,before,market,limit){
 const [data,states]=await Promise.all([
  market&&market!=='Kaspi'?Promise.resolve({rows:[]}):client.query(`SELECT line AS payload,pl.product_id AS "productId" FROM kaspi_order_history a CROSS JOIN LATERAL jsonb_array_elements(a.payload->'rows') line LEFT JOIN product_links pl ON pl.market='Kaspi' AND pl.sku=line->>'sku' WHERE a.creation_date >= $1 AND a.creation_date < $2 ORDER BY a.creation_date DESC LIMIT $3`,[after,before,limit]),
  client.query('SELECT payload FROM kaspi_order_history_state WHERE id=1')]);
 return {rows:data.rows.map(r=>({...r.payload,productId:r.productId||null,linkSource:r.productId?'sku-exact':null})),state:kaspiHistoryStatus(states.rows[0]?object(states.rows[0].payload):null)};
}
let timer,running=false;
export function startKaspiHistoryLoop(){
 if(timer)return;
 const run=async()=>{if(running)return;running=true;try{await syncKaspiHistory()}catch{console.warn('Kaspi order history worker failed')}finally{running=false}};
 setTimeout(run,12000).unref();timer=setInterval(run,3000);timer.unref();
}
