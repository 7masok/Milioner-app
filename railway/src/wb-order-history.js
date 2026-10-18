import express from 'express';
import {pool} from './db.js';
import {config} from './config.js';
import {credentialFor} from './connections.js';
import {asyncRoute,requireTrustedOrigin} from './http.js';

const DAY=86400000,SLOT=60000,WB_ARCHIVE_OFFSET=3*3600000,API='https://marketplace-api.wildberries.ru';
const object=v=>{if(v&&typeof v==='object')return v;try{return JSON.parse(v||'{}')}catch{return {}}};
const text=v=>String(v??'').trim();
export function parseWbHistoryPage(body){
 // WB cursors are int64 and may exceed JavaScript's exact integer range.
 // Quote only the integer next field before JSON.parse can round its digits.
 return JSON.parse(body.replace(/("next"\s*:\s*)(-?\d{16,})(?=\s*[,}])/g,'$1"$2"'));
}
function pageCursor(value,current,count,scope){
 const raw=String(value),valid=(typeof value==='string'||(typeof value==='number'&&Number.isSafeInteger(value)))&&/^\d+$/.test(raw);
 if(!valid||BigInt(raw)>9223372036854775807n||(count&&BigInt(raw)!==0n&&BigInt(raw)<=BigInt(current))){
  const error=Error('WB вернул некорректный курсор '+scope);error.cursorInfo={type:typeof value,value:raw.slice(0,80),current:String(current),count};throw error;
 }
 return BigInt(raw)<=BigInt(Number.MAX_SAFE_INTEGER)?Number(raw):raw;
}
export function initialWbOrderHistory(now){
 const anchor=Math.floor(now/1000)*1000,goal=Math.floor((now+18000000)/DAY)*DAY-18000000-364*DAY;
 return {version:2,anchor,goal,coveredFrom:anchor,from:Math.max(goal,anchor-29*DAY),to:anchor,cursor:0,phase:'orders',pending:[],rows:0,complete:false,nextAllowedAt:0,lastError:''};
}
function compactOrder(raw){
 return Object.fromEntries(['id','orderUid','article','nmId','techSize','skus','createdAt','price','finalPrice','convertedPrice','convertedFinalPrice','currencyCode','convertedCurrencyCode'].map(k=>[k,raw[k]]).filter(([,v])=>v!==undefined));
}
export function historicalWbOrder(market,order,status){
 const id=text(order.id),at=Date.parse(order.createdAt),size=text(order.techSize),article=text(order.article),barcode=text(order.skus?.[0]);
 if(!/^[1-9]\d*$/.test(id)||!(at>0)||!text(status?.supplierStatus)||!text(status?.wbStatus))throw Error('WB не вернул заказ или его полный статус');
 const converted=String(order.convertedCurrencyCode)==='398',original=String(order.currencyCode)==='398';
 const cents=converted?(order.convertedFinalPrice??order.convertedPrice):original?(order.finalPrice??order.price):null;
 if(cents===null||cents===undefined||!Number.isFinite(Number(cents))||Number(cents)<0)throw Error('WB не вернул историческую цену в тенге');
 const variant=Boolean(size)&&!['0','00','ONE SIZE','ONESIZE','БЕЗ РАЗМЕРА'].includes(size.toUpperCase().replace(/\s+/g,' '));
 const sku=variant?(barcode||article||text(order.nmId)):(article||text(order.nmId)||barcode);
 if(!sku)throw Error('WB не вернул артикул исторического заказа');
 return {market,orderId:id,code:id,entryId:id,status:text(status.supplierStatus),state:text(status.wbStatus),creationDate:at,
  sku,productName:[article||text(order.nmId),size?'размер '+size:''].filter(Boolean).join(' · '),qty:1,unitPrice:Number(cents)/100,totalPrice:Number(cents)/100,
  sellerDeliveryCost:null,marketplaceFee:null,feeSource:'',historyOnly:true,currency:'KZT'};
}
function finishWindow(state,now){
 if(state.mode==='refresh'){
  state.anchor=state.to;state.complete=state.coveredFrom<=state.goal;delete state.mode;state.nextAllowedAt=now+DAY;
 }else{
  state.coveredFrom=state.from;state.complete=state.from<=state.goal;
  if(!state.complete){state.to=state.from;state.from=Math.max(state.goal,state.to-29*DAY)}
  else state.nextAllowedAt=now+DAY;
 }
 state.cursor=0;state.phase='orders';state.pending=[];delete state.archiveMonths;delete state.archiveIndex;delete state.archiveCursor;
}
function finishLiveWindow(state,now){
 // The ordinary endpoint only retains three months. Query the archive as well
 // for older windows, with an overlap so the moving retention edge is covered.
 if(state.from<now-60*DAY){
  // WB groups archive months by Moscow time, while createdAt is returned in UTC.
  // Use the same calendar for requested months and response validation.
  const first=new Date(state.from+WB_ARCHIVE_OFFSET),last=new Date(state.to+WB_ARCHIVE_OFFSET),months=[];
  for(let d=new Date(Date.UTC(first.getUTCFullYear(),first.getUTCMonth(),1));d<=last;d.setUTCMonth(d.getUTCMonth()+1))months.push({year:d.getUTCFullYear(),month:d.getUTCMonth()+1});
  state.archiveMonths=months;state.archiveIndex=0;state.archiveCursor=0;state.phase='archive';state.pending=[];
 }else finishWindow(state,now);
}
export async function stepWbOrderHistory(input,{market,fetchPage,fetchStatuses,fetchArchive,now}){
 const state=structuredClone(input),rows=[];state.nextAllowedAt=now+SLOT;
 if(state.complete&&!state.mode){
  // Daily refresh overlaps the previous scan and advances continuously after downtime.
  const end=Math.min(Math.floor(now/1000)*1000,state.anchor+28*DAY);
  state.mode='refresh';state.from=Math.max(state.goal,state.anchor-DAY);state.to=end;state.cursor=0;state.phase='orders';
 }
 // Older windows belong to the archive endpoint; do not send unsupported
 // dates to the ordinary endpoint or interpret its empty response as history.
 if(state.phase==='orders'&&state.to<now-93*DAY)finishLiveWindow(state,now);
 if(state.phase==='archive'){
  const month=state.archiveMonths[state.archiveIndex],data=await fetchArchive({...month,cursor:state.archiveCursor});
  if(!Array.isArray(data?.orders)||data.orders.length>1000)throw Error('WB вернул неполную страницу архива');
  const next=pageCursor(data.next,state.archiveCursor,data.orders.length,'архива');
  for(const raw of data.orders){
   const at=Date.parse(raw.createdAt),date=new Date(at+WB_ARCHIVE_OFFSET);
   if(!(at>0)||date.getUTCFullYear()!==month.year||date.getUTCMonth()+1!==month.month){
    const error=Error('WB вернул архивные заказы за пределами месяца');
    error.archiveDateInfo={year:month.year,month:month.month,type:typeof raw.createdAt,parsed:Number.isFinite(at)?new Date(at).toISOString():'invalid',value:/^[\dTtZz:+.\- ]{1,64}$/.test(String(raw.createdAt))?String(raw.createdAt):'invalid'};
    throw error;
   }
   if(at>=state.from&&at<=state.to)rows.push(historicalWbOrder(market,{...raw.product,...raw.priceInfo,id:raw.id,orderUid:raw.orderUid,createdAt:raw.createdAt},raw.status));
  }
  if(!data.orders.length||next===0){
   state.archiveIndex++;state.archiveCursor=0;
   if(state.archiveIndex>=state.archiveMonths.length)finishWindow(state,now);
  }else state.archiveCursor=next;
 }else if(state.phase==='orders'){
  const data=await fetchPage({from:state.from,to:state.to,cursor:state.cursor});
  if(!Array.isArray(data?.orders)||data.orders.length>1000)throw Error('WB вернул неполную страницу истории');
  const next=pageCursor(data.next,state.cursor,data.orders.length,'истории');
  const pending=data.orders.map(compactOrder);
  if(pending.some(o=>!Number.isSafeInteger(Number(o.id))||Number(o.id)<=0||!(Date.parse(o.createdAt)>=state.from&&Date.parse(o.createdAt)<=state.to)))throw Error('WB вернул заказы за пределами запрошенного периода');
  if(!pending.length)finishLiveWindow(state,now);
  else{state.pending=pending;state.pageNext=next;state.phase='statuses'}
 }else{
  const data=await fetchStatuses(state.pending.map(o=>Number(o.id)));
  if(!Array.isArray(data?.orders))throw Error('WB не вернул статусы истории');
  const statuses=new Map(data.orders.map(s=>[text(s.id),s]));
  for(const order of state.pending)rows.push(historicalWbOrder(market,order,statuses.get(text(order.id))));
  if(state.pageNext===0)finishLiveWindow(state,now);
  else{state.cursor=state.pageNext;state.pending=[];state.phase='orders'}
 }
 state.lastError='';return {state,rows};
}
export function wbOrderHistoryStatus(market,input){
 const s=object(input);return {market,status:!s.anchor?'pending':s.lastError?'retry':s.complete?'complete':'loading',
  from:Number(s.coveredFrom)||0,to:Number(s.anchor)||0,rows:Number(s.rows)||0,nextAllowedAt:Number(s.nextAllowedAt)||0,error:s.lastError||''};
}
function retryAt(headers,now){
 return Math.max(now+5*60000,...['retry-after','x-ratelimit-retry'].map(k=>{const v=headers?.get(k);return !v?0:Number.isFinite(Number(v))?now+Math.max(0,Number(v))*1000:Date.parse(v)||0}));
}
export async function syncWbOrderHistory(market,{client=pool,token,fetcher=fetch,now=Date.now()}={}){
 token=token??await credentialFor(market,market==='WB2'?config.wbToken2:config.wbToken);if(!token)return;
 const db=await client.connect();let locked=false,state,recovery;
 const persist=()=>db.query(`INSERT INTO wb_order_history_state(market,payload,updated_at) VALUES($1,$2::jsonb,$3)
  ON CONFLICT(market) DO UPDATE SET payload=EXCLUDED.payload,updated_at=EXCLUDED.updated_at`,[market,JSON.stringify(state),now]);
 try{
  locked=Boolean((await db.query('SELECT pg_try_advisory_lock(730146,hashtext($1)) AS locked',[market])).rows[0]?.locked);if(!locked)return;
  const old=(await db.query('SELECT payload FROM wb_order_history_state WHERE market=$1',[market])).rows[0];
  state=old?object(old.payload):initialWbOrderHistory(now);
  if(state.version!==2){const prior=state;state={...initialWbOrderHistory(now),rows:Number(prior.rows)||0,nextAllowedAt:Number(prior.nextAllowedAt)||0};}
  if(state.nextAllowedAt>now)return;
  state.nextAllowedAt=now+SLOT;await persist();recovery=structuredClone(state); // Reserve before upstream; survives a restart.
  const request=async(path,body)=>{
   const response=await fetcher(API+path,{method:body?'POST':'GET',headers:{Authorization:token,Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(25000)});
   if(!response.ok){const error=Error('WB история заказов: HTTP '+response.status);error.retryAt=retryAt(response.headers,now);throw error;}
   return parseWbHistoryPage(await response.text());
  };
  const result=await stepWbOrderHistory(state,{market,now,
   fetchPage:({from,to,cursor})=>request('/api/v3/orders?'+new URLSearchParams({limit:'1000',next:String(cursor),dateFrom:String(Math.floor(from/1000)),dateTo:String(Math.floor(to/1000))})),
   fetchStatuses:ids=>request('/api/v3/orders/status',{orders:ids}),
   fetchArchive:({year,month,cursor})=>request('/api/marketplace/v3/fbs/orders/archive?'+new URLSearchParams({year:String(year),month:String(month),limit:'1000',next:String(cursor)}))});
  await db.query('BEGIN');
  let inserted=0;
  for(const row of result.rows){
   const saved=await db.query(`INSERT INTO wb_order_history(market,order_id,creation_date,payload,updated_at) VALUES($1,$2,$3,$4::jsonb,$5)
    ON CONFLICT(market,order_id) DO UPDATE SET payload=EXCLUDED.payload,updated_at=EXCLUDED.updated_at RETURNING (xmax=0) AS inserted`,[market,row.orderId,row.creationDate,JSON.stringify(row),now]);
   if(saved.rows[0]?.inserted)inserted++;
  }
  state=result.state;state.rows+=inserted;await persist();await db.query('COMMIT');
  console.info('WB order history progress',JSON.stringify({market,...wbOrderHistoryStatus(market,state),phase:state.phase,inserted}));
 }catch(error){
  await db.query('ROLLBACK').catch(()=>{});
  state=recovery||state;
  if(state){state.lastError=/^WB /.test(error.message)?error.message:'Не удалось догрузить историю заказов WB';state.nextAllowedAt=Math.max(now+5*60000,Number(error.retryAt)||0);await persist();}
  console.warn('WB order history retry',JSON.stringify({market,error:state?.lastError||'Не удалось запустить архив заказов WB',nextAllowedAt:state?.nextAllowedAt||0,...(error.cursorInfo?{cursor:error.cursorInfo}:{}),...(error.archiveDateInfo?{archiveDate:error.archiveDateInfo}:{})}));
 }finally{if(locked)await db.query('SELECT pg_advisory_unlock(730146,hashtext($1))',[market]).catch(()=>{});db.release()}
}
export async function readWbOrderHistory(client,after,before,market,limit){
 const [archive,states]=await Promise.all([
  client.query(`SELECT a.payload,pl.product_id AS "productId" FROM wb_order_history a
   LEFT JOIN product_links pl ON pl.market=a.market AND pl.sku=a.payload->>'sku'
   WHERE a.creation_date >= $1 AND a.creation_date < $2 AND ($3::text IS NULL OR a.market=$3)
   ORDER BY a.creation_date DESC LIMIT $4`,[after,before,market||null,limit]),
  client.query('SELECT market,payload FROM wb_order_history_state')
 ]);
 return {rows:archive.rows.map(r=>({...object(r.payload),productId:r.productId||null,linkSource:r.productId?'sku-exact':null})),states:states.rows.map(r=>wbOrderHistoryStatus(r.market,r.payload))};
}
export function mergeReportingOrders(live,archive,limit){
 const byId=new Map(archive.map(row=>[row.market+'|'+row.orderId,row]));
 for(const row of live)byId.set(row.market+'|'+row.orderId,row); // Live statuses/prices win.
 return [...byId.values()].sort((a,b)=>b.creationDate-a.creationDate).slice(0,limit);
}
export const wbOrderHistoryRouter=express.Router();wbOrderHistoryRouter.use(requireTrustedOrigin);
wbOrderHistoryRouter.get('/wb-order-history',asyncRoute(async(req,res)=>{
 const result=await pool.query('SELECT market,payload FROM wb_order_history_state');
 return res.json({ok:true,markets:['WB','WB2'].map(m=>wbOrderHistoryStatus(m,result.rows.find(r=>r.market===m)?.payload))});
}));
let timer,running=false;
export function startWbOrderHistoryLoop(){
 if(timer)return;
 // Like the operational order worker, use configured credentials. The legacy
 // migration switch is not used by the live marketplace loops and can remain
 // false on an otherwise active warehouse. It must not silently stop this archive.
 const run=async()=>{
  if(running)return;running=true;
  try{for(const market of ['WB','WB2']){
   try{await syncWbOrderHistory(market)}catch{console.warn('WB order history worker failed',market)}
  }}finally{running=false}
 };
 console.info('WB order history worker started',JSON.stringify({legacySyncEnabled:config.marketSyncEnabled}));
 setTimeout(run,25000).unref();timer=setInterval(run,60000);timer.unref();
}
