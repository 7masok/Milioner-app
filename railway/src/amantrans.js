import express from 'express';
import crypto from 'node:crypto';
import {readAmanAccess,saveAmanAccess} from './connections.js';
import {requireConfiguredSession} from './auth.js';
import {requireTrustedOrigin,requireWritesEnabled} from './http.js';
import {config} from './config.js';

const ORIGIN='https://api.amantrans.com.kz',TTL=5*60000;
const fail=(message,status=400)=>Object.assign(Error(message),{status});
const num=value=>value!==null&&value!==''&&value!==undefined&&Number.isFinite(Number(value))?Number(value):null;
const text=(value,max=200)=>String(value??'').trim().slice(0,max);
export function amanIdentity(token){
 let value;try{value=JSON.parse(Buffer.from(String(token).split('.')[1],'base64url').toString());}catch{throw fail('Aman Trans не вернул клиентскую сессию',502);}
 if(value.role!=='RoleClient'||!/^\d{1,20}$/.test(String(value.id))||!Number.isSafeInteger(Number(value.id))||Number(value.id)<=0)throw fail('Подключите клиентский аккаунт Aman Trans',403);
 return {accountId:String(value.id),expiresAt:Number(value.exp||0)*1000};
}
export function amanOrder(row){
 const id=text(row.id,30);if(!/^\d{1,30}$/.test(id)||!Number.isSafeInteger(Number(id))||Number(id)<=0)throw fail('Некорректный ID отправления Aman Trans',502);
 const box=num(row.box_price),delivery=num(row.delivery_price),usd=num(row.usd);
 const result={id,name:text(row.name),track:text(row.track_code,100),amount:num(row.amount),priceUsd:num(row.price),weight:num(row.weight),tariffUsd:num(row.tariff_price),boxUsd:box,deliveryUsd:delivery,exchangeRate:usd,totalKzt:box!==null&&delivery!==null&&usd!==null?(box+delivery)*usd:null,createdAt:typeof row.created_at==='number'?row.created_at:text(row.created_at,60),status:text(row.status?.name,50),statusLabel:text(row.status?.name_ru||row.status?.name,100),shippingMethod:text(row.shipping_method||'Avto',30)};
 result.fingerprint=crypto.createHash('sha256').update(JSON.stringify(result)).digest('hex');return result;
}
export function amanEdit(body,create=false){
 const allowed=new Set(['name','track','priceUsd','amount',...(create?['shippingMethod']:[])]);
 if(!body||Object.keys(body).some(k=>!allowed.has(k)))throw fail('Можно менять только название, трек, стоимость и количество');
 const name=text(body.name),track=text(body.track,100),price=Number(body.priceUsd),amount=Number(body.amount);
 if(!name||!track||/[<>\x00-\x1f]/.test(name+track)||String(body.name).length>200||String(body.track).length>100||body.priceUsd==null||body.priceUsd===''||!Number.isFinite(price)||price<0||price>1e9||!Number.isSafeInteger(amount)||amount<1||amount>10000000)throw fail('Проверьте название, трек, стоимость и целое количество');
 if(create&&!['Avto','Avia'].includes(body.shippingMethod))throw fail('Выберите способ доставки');
 return {name,track_code:track,price,amount,...(create?{shipping_method:body.shippingMethod}:{})};
}
export function createAmanService({read=readAmanAccess,write=saveAmanAccess,fetchImpl=fetch,now=Date.now}={}){
 let tail=Promise.resolve();
 const locked=fn=>{const job=tail.catch(()=>{}).then(fn);tail=job;return job;};
 async function call(path,{token,method='GET',body,timeout=20000}={}){
  let response;
  try{response=await fetchImpl(ORIGIN+path,{method,redirect:'error',signal:AbortSignal.timeout(timeout),headers:{Accept:'application/json','Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})});}
  catch{throw fail(method==='GET'?'Aman Trans не ответил. Последние данные сохранены.':'Ответ Aman Trans не получен. Проверьте список перед повторной отправкой.',504);}
  if(!response.ok){const error=fail('Aman Trans: HTTP '+response.status+(response.status===401?' · войдите заново':response.status===403?' · действие не разрешено аккаунту':''),response.status===401?409:response.status===403?403:502),retry=response.headers.get('retry-after');if(retry)error.retryAt=/^\d+$/.test(retry)?now()+Number(retry)*1000:Date.parse(retry)||0;throw error;}
  const raw=await response.text();if(raw.length>4000000)throw fail('Слишком большой ответ Aman Trans',502);
  if(!raw)return null;try{return JSON.parse(raw);}catch{throw fail('Не удалось прочитать ответ Aman Trans',502);}
 }
 async function login(phone,password){
  const data=await call('/auth/sign-in-client',{method:'POST',body:{phone,password,clientType:'client'}});
  const token=data?.token;if(typeof token!=='string'||token.length>12000)throw fail('Aman Trans не подтвердил вход',409);
  return {token,...amanIdentity(token)};
 }
 async function session(data){
  if(!data?.phone||!data?.password)throw fail('Подключите Aman Trans в настройках',409);
  if(!data.token||data.expiresAt&&data.expiresAt<now()+60000){const fresh=await login(data.phone,data.password);if(data.accountId&&data.accountId!==fresh.accountId)throw fail('Аккаунт Aman Trans изменился. Подключите заново',409);Object.assign(data,fresh);await write(data);}
  return data;
 }
 async function list(data,search=''){
  const deadline=now()+30000,result=[],seen=new Set(),until=new Date(now()+86400000).toISOString().slice(0,10),from=new Date(now());from.setUTCMonth(from.getUTCMonth()-100);
  for(let page=0;page<50;page++){
   const query=new URLSearchParams({dateFrom:from.toISOString().slice(0,10),dateTo:until,cityId:'',filialId:'',forSearch:search,status:'',page:String(page),size:'100'});
   if(now()>=deadline)throw fail('Aman Trans отвечает дольше обычного. Последний полный снимок сохранён',504);
   const response=await call('/amantrans/orders?'+query,{token:data.token,timeout:Math.min(12000,Math.max(1,deadline-now()))});
   if(!Array.isArray(response?.content)||!Number.isInteger(response.totalPages)||response.totalPages<0)throw fail('Не удалось получить полный список отправлений',502);
   for(const row of response.content){if(row.customer?.id!=null&&String(row.customer.id)!==data.accountId)throw fail('Aman Trans вернул другой аккаунт',502);const order=amanOrder(row);if(!seen.has(order.id)){seen.add(order.id);result.push(order);}}
   if(page+1>=response.totalPages)return result;
  }
  throw fail('Список Aman Trans превышает 5000 отправлений. Уточните поиск',502);
 }
 function view(data){return {ok:true,connected:Boolean(data?.phone&&data?.password),accountId:data?.accountId||'',phoneHint:data?.phone?'•••'+data.phone.slice(-4):'',fetchedAt:data?.fetchedAt||0,lastError:data?.lastError||'',nextAttemptAt:data?.nextAttemptAt||0,orders:(data?.orders||[]).map(row=>({...row,hidden:Boolean(data.hidden?.[row.id])})),purchaseLinks:Object.fromEntries(Object.values(data?.operations||{}).filter(x=>x.purchaseKey&&x.orderId&&x.state==='done'&&!x.trackEdit).map(x=>[x.purchaseKey,{id:x.orderId,track:x.lastTrack||x.fields?.track_code||''}])),deleteSupported:false};}
 async function freshOrder(data,id){const old=data.orders?.find(x=>x.id===id);if(!old)throw fail('Сначала обновите список и выберите отправление',404);const rows=await list(data,old.track);const current=rows.find(x=>x.id===id);if(!current)throw fail('Отправление изменилось или больше недоступно. Обновите список',409);return current;}
 async function refresh(data,persistFailure=true){try{await session(data);const orders=await list(data);data.orders=orders;data.fetchedAt=now();data.nextAttemptAt=now()+TTL;data.lastError='';await write(data);}catch(error){if(data&&persistFailure){data.lastError=error.message;data.nextAttemptAt=Math.max(now()+TTL,Number(error.retryAt)||0);await write(data);}throw error;}return view(data);}
 async function sendOrder(id,body,purchaseKey=''){
   const fields=amanEdit(body?.fields,!id),op=purchaseKey?'paid_'+crypto.createHash('sha256').update(purchaseKey).digest('hex'):text(body?.operationId,80);if(!/^[a-zA-Z0-9_-]{12,80}$/.test(op))throw fail('Откройте форму отправки заново');
   const data=await session(await read());data.operations||={};
   const digest=crypto.createHash('sha256').update(JSON.stringify({id,fields})).digest('hex'),receipt=data.operations[op];
   async function resolveCreated(entry){
    if(!entry.purchaseKey||entry.orderId)return;
    const orders=await list(data,entry.fields.track_code),matches=orders.filter(row=>!entry.beforeIds.includes(row.id)&&row.track===entry.fields.track_code&&row.name===entry.fields.name&&row.amount===entry.fields.amount&&row.priceUsd===entry.fields.price);
    if(matches.length===1){entry.orderId=matches[0].id;const ids=new Set(orders.map(x=>x.id));data.orders=[...(data.orders||[]).filter(x=>!ids.has(x.id)),...orders];await write(data);}
   }
   if(receipt){if(receipt.digest!==digest)throw fail('Эта закупка уже отправлялась с другими данными. Откройте её доставку для проверки и изменения.',409);if(receipt.state==='done'){await resolveCreated(receipt).catch(()=>{});return {...view(data),sent:true,createdOrderId:receipt.orderId||null,refreshNeeded:!data.fetchedAt};}throw fail('Результат предыдущей отправки требует проверки. Обновите список Aman Trans; автоматически запрос не повторён.',409);}
   let current;if(id){current=await freshOrder(data,id);if(current.fingerprint!==body.fingerprint)throw fail('Запись Aman Trans изменилась. Обновите и проверьте форму',409);}
   const before=purchaseKey?await list(data,fields.track_code):[];
   const ops=Object.entries(data.operations);if(ops.length>=200){for(const [key,value]of ops)if(!value.purchaseKey&&value.state==='done'&&now()-value.at>30*86400000)delete data.operations[key];if(Object.keys(data.operations).length>=200)throw fail('Очередь отправок заполнена. Неотправленные запросы требуют проверки',409);}
   data.operations[op]={digest,state:'pending',at:now(),...(purchaseKey?{purchaseKey,fields,beforeIds:before.map(x=>x.id)}:{})};await write(data);
   let sent;try{sent=await call(id?'/amantrans/orders/update':'/amantrans/orders/create',{token:data.token,method:id?'PUT':'POST',body:id?{id:Number(id),...fields}:{...fields,customer_id:Number(data.accountId)}});}
   catch(error){data.operations[op].error=error.status;await write(data);throw error;}
   data.operations[op].state='done';if(purchaseKey&&Number.isSafeInteger(Number(sent?.id))&&Number(sent.id)>0)data.operations[op].orderId=String(sent.id);data.fetchedAt=0;await write(data);
   await resolveCreated(data.operations[op]).catch(()=>{});
   return {...view(data),sent:true,createdOrderId:data.operations[op].orderId||null,refreshNeeded:true};
 }
 async function syncPurchase(body){
  const key=String(body?.purchaseKey||'');if(!key||key.length>200||/[\x00-\x1f]/.test(key))throw fail('Закупка не найдена');
  const fields=amanEdit(body.fields,true),data=await session(await read()),op='paid_'+crypto.createHash('sha256').update(key).digest('hex');data.operations||={};let receipt=data.operations[op];
  if(body.accountId&&String(body.accountId)!==data.accountId)throw fail('Закупка подключена к другому аккаунту Aman Trans',409);
  if(!receipt&&body.orderId){
   const id=String(body.orderId),current=await freshOrder(data,id);
   if(!body.accountId||String(body.accountId)!==data.accountId)throw fail('Проверьте аккаунт закупки',409);
   receipt=data.operations[op]={purchaseKey:key,orderId:id,state:'done',at:now(),fields:{name:current.name,track_code:current.track,price:current.priceUsd,amount:current.amount,shipping_method:current.shippingMethod},lastTrack:current.track};await write(data);
  }
  if(!receipt)return sendOrder(null,{fields:body.fields},key);
  if(!receipt.orderId){
   const candidates=await list(data,receipt.fields.track_code),matches=candidates.filter(row=>!(receipt.beforeIds||[]).includes(row.id)&&row.track===receipt.fields.track_code&&row.name===receipt.fields.name&&row.amount===receipt.fields.amount&&row.priceUsd===receipt.fields.price);
   if(matches.length!==1)throw fail('Проверяем результат создания в Aman Trans. Новая запись повторно не отправляется.',409);
   receipt.orderId=matches[0].id;receipt.state='done';const ids=new Set(candidates.map(x=>x.id));data.orders=[...(data.orders||[]).filter(x=>!ids.has(x.id)),...candidates];await write(data);
  }
  const id=receipt.orderId;if(body.orderId&&String(body.orderId)!==id)throw fail('ID отправления закупки изменился. Обновите склад',409);
  const lastTrack=receipt.lastTrack||receipt.fields.track_code;
  if(fields.track_code===lastTrack)return {...view(data),sent:true,createdOrderId:id,syncedTrack:lastTrack};
  const edit=text(body.editOperationId,80);if(!/^[a-zA-Z0-9_-]{12,80}$/.test(edit))throw fail('Сохраните изменение трека ещё раз',409);
  const editKey='track_'+crypto.createHash('sha256').update(key+'|'+edit).digest('hex'),previous=data.operations[editKey];
  if(previous&&(previous.orderId!==id||previous.track!==fields.track_code))throw fail('Изменение трека уже сохранено с другими данными',409);
  let current=(await list(data,lastTrack)).find(x=>x.id===id);
  if(!current)current=(await list(data,fields.track_code)).find(x=>x.id===id);
  if(!current)throw fail('Отправление Aman Trans временно не найдено. Изменение трека сохранено в складе.',409);
  if(current.track!==fields.track_code){
   if(previous)throw fail('Результат смены трека проверяется. Запрос повторно не отправляется.',409);
   if(body.previousTrack&&current.track!==String(body.previousTrack))throw fail('Трек изменился в Aman Trans. Обновите данные перед исправлением.',409);
   if(current.track!==lastTrack)throw fail('Трек изменился в Aman Trans. Автоматическая перезапись остановлена.',409);
   const patch=amanEdit({name:current.name,track:fields.track_code,priceUsd:current.priceUsd,amount:current.amount});
   data.operations[editKey]={trackEdit:true,purchaseKey:key,orderId:id,track:fields.track_code,state:'pending',at:now()};await write(data);
   try{await call('/amantrans/orders/update',{token:data.token,method:'PUT',body:{id:Number(id),...patch}});}catch(error){data.operations[editKey].error=error.status;await write(data);throw error;}
   current={...current,track:fields.track_code};const {fingerprint,...value}=current;current.fingerprint=crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }
  if(data.operations[editKey])data.operations[editKey].state='done';receipt.lastTrack=fields.track_code;data.orders=[...(data.orders||[]).filter(x=>x.id!==id),current];data.fetchedAt=0;await write(data);
  return {...view(data),sent:true,createdOrderId:id,syncedTrack:fields.track_code};
 }
 return {
  get:()=>locked(async()=>view(await read())),
  connect:body=>locked(async()=>{const phone=String(body?.phone||'').replace(/\D/g,''),password=String(body?.password||'');if(!/^7\d{10}$/.test(phone)||password.length<6||password.length>200)throw fail('Проверьте телефон и пароль');const auth=await login(phone,password),old=await read(),same=old?.accountId===auth.accountId,data={...(same?old:{}),phone,password,...auth,orders:same?old.orders:[],hidden:same?old.hidden:{},operations:same?old.operations:{}};await refresh(data,false);return view(data);}),
  disconnect:()=>locked(async()=>{const data=await read();if(data){delete data.phone;delete data.password;delete data.token;delete data.expiresAt;await write(data);}return view(data);}),
  sync:()=>locked(async()=>{const data=await read();if(data?.lastError&&data.nextAttemptAt>now())throw fail(data.lastError+' · следующая попытка '+new Date(data.nextAttemptAt).toLocaleTimeString('ru-RU',{timeZone:'Asia/Almaty'}),429);return refresh(data);}),
  syncIfDue:()=>locked(async()=>{const data=await read();if(data?.phone&&data?.password&&now()>=Number(data.nextAttemptAt||0)&&now()-Number(data.fetchedAt||0)>TTL)await refresh(data);}),
  hide:(id,hidden)=>locked(async()=>{const data=await read();if(!data?.orders?.some(x=>x.id===id))throw fail('Отправление не найдено',404);data.hidden||={};if(hidden)data.hidden[id]=true;else delete data.hidden[id];await write(data);return view(data);}),
  history:id=>locked(async()=>{const data=await session(await read());if(!data.orders?.some(x=>x.id===id))throw fail('Отправление не найдено',404);const rows=await call('/amantrans/order_turkey/get-status-info?'+new URLSearchParams({id,country:'China'}),{token:data.token});if(!Array.isArray(rows))throw fail('История недоступна',502);return {ok:true,history:rows.map(x=>({at:x.update_date,status:x.status_to?.name_ru||x.status_to?.name||''}))};}),
  send:(id,body)=>locked(()=>sendOrder(id,body)),
  registerPurchase:body=>locked(()=>syncPurchase(body))
 };
}
export const amanService=createAmanService();
export const amanRouter=express.Router();
amanRouter.use(requireConfiguredSession,requireTrustedOrigin);
const route=fn=>async(req,res)=>{try{res.json(await fn(req));}catch(error){res.status(error.status||502).json({ok:false,error:error.status?error.message:'Не удалось выполнить запрос Aman Trans'});}};
amanRouter.get('/state',route(()=>amanService.get()));
amanRouter.get('/orders/:id/history',route(req=>amanService.history(String(req.params.id))));
amanRouter.post('/connect',requireWritesEnabled,route(req=>amanService.connect(req.body)));
amanRouter.post('/disconnect',requireWritesEnabled,route(()=>amanService.disconnect()));
amanRouter.post('/sync',requireWritesEnabled,route(()=>amanService.sync()));
amanRouter.post('/orders',requireWritesEnabled,route(req=>amanService.send(null,req.body)));
amanRouter.post('/purchases/register',requireWritesEnabled,route(req=>amanService.registerPurchase(req.body)));
amanRouter.patch('/orders/:id',requireWritesEnabled,route(req=>amanService.send(String(req.params.id),req.body)));
amanRouter.post('/orders/:id/visibility',requireWritesEnabled,route(req=>{if(typeof req.body?.hidden!=='boolean')throw fail('Укажите видимость отправления');return amanService.hide(String(req.params.id),req.body.hidden);}));
export function startAmanLoop(){if(config.storeProfile==='WB3'||!config.writesEnabled)return;const timer=setInterval(()=>{void amanService.syncIfDue().catch(()=>{});},60000);timer.unref();}
