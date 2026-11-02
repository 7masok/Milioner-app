(function(){
'use strict';
const CACHE='milioner_server_snapshot_cache_v2';
let verifiedAt=0, failure=null, expanded=false, busy=false;
try{verifiedAt=Number(JSON.parse(localStorage.getItem(CACHE)||'null')?.verifiedAt||0)}catch{}
const fmt=value=>value?new Date(value).toLocaleString('ru-RU',{timeZone:'Asia/Almaty',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}):'ещё не было';
function describe(error){
 const status=Number(error?.status)||0;
 if(navigator.onLine===false)return {title:'Нет подключения к интернету',reason:'Браузер сообщил о потере сети. Связь с сервером пока не проверена.',code:'OFFLINE'};
 if(error?.code==='INVALID_RESPONSE')return {title:'Некорректный ответ сервера',reason:'Запрос склада завершился, но сервер не вернул ожидаемые данные. Изменения не подтверждены.',code:'INVALID_RESPONSE'};
 if(status===401||status===403)return {title:'Нужно войти снова',reason:'Сервер не подтвердил доступ. Введите код доступа на экране входа.',code:'HTTP '+status};
 if(status>=500)return {title:'Сервер временно недоступен',reason:'Сервер вернул ошибку. Причина на стороне приложения или хостинга пока не установлена.',code:'HTTP '+status};
 if(error?.name==='AbortError'||error?.name==='TimeoutError')return {title:'Сервер долго не отвечает',reason:'Время ожидания истекло. Это может быть задержка сервера или соединения.',code:'TIMEOUT'};
 if(status)return {title:'Не удалось обновить склад',reason:'Сервер отклонил запрос. Последние загруженные данные остаются на экране.',code:'HTTP '+status};
 return {title:'Потеряна связь со складом',reason:'Не удалось получить ответ. По этой ошибке нельзя определить, недоступен сервер или соединение до него.',code:'NETWORK'};
}
function paintHeader(){
 if(!failure)return false;
 const el=document.getElementById('cloudStatus');if(el){if(el.textContent!=='нет связи')el.textContent='нет связи';el.style.color='var(--warn)';el.title=failure.title}
 return true;
}
function paint(){
 let box=document.getElementById('warehouseConnectionPanel');
 if(!box){const header=document.querySelector('header');if(!header)return;box=document.createElement('section');box.id='warehouseConnectionPanel';box.className='connection-panel';box.setAttribute('aria-label','Связь со складом');box.innerHTML='<div class="connection-top"><span class="connection-symbol" aria-hidden="true">↻</span><div><strong id="connectionTitle"></strong><p id="connectionSummary"></p></div></div><div class="connection-actions"><button type="button" id="connectionRetry">Проверить связь</button><button type="button" id="connectionDetailsToggle" aria-expanded="false">Подробнее</button></div><div id="connectionDetails" hidden><p id="connectionReason"></p><p id="connectionTime"></p><p id="connectionSafety"></p><small id="connectionCode"></small><small id="connectionHistory"></small></div>';header.after(box);document.getElementById('connectionRetry').onclick=retry;document.getElementById('connectionDetailsToggle').onclick=()=>{expanded=!expanded;paint()}}
 box.hidden=!failure&&!expanded;if(box.hidden)return;
 const dirty=typeof warehouseLocalDirty!=='undefined'&&warehouseLocalDirty;
 document.getElementById('connectionTitle').textContent=failure?.title||'Связь восстановлена';
 document.getElementById('connectionSummary').textContent=dirty?'Есть изменения, ещё не подтверждённые сервером. Не закрывайте вкладку.':failure?'Показаны последние загруженные данные. Они могут быть неактуальны.':'Склад снова получает данные с сервера.';
 document.getElementById('connectionReason').textContent=failure?.reason||'Сервер успешно ответил на запрос склада.';
 document.getElementById('connectionTime').textContent='Последняя успешная связь: '+fmt(verifiedAt)+' · Алматы';
 document.getElementById('connectionSafety').textContent=dirty?'Подтверждение сохранения ожидается. Автоматический повтор включён.':'Новые данные появятся после восстановления связи. Повторная проверка выполняется автоматически.';
 document.getElementById('connectionCode').textContent=failure?'Код: '+failure.code+' · Проверка '+fmt(failure.at):'Ответ сервера получен';
 const history=document.getElementById('connectionHistory');if(history)try{history.textContent='Последние попытки: '+JSON.parse(localStorage.getItem('sklad_connection_attempts_v1')||'[]').slice(-3).map(x=>fmt(x.at)+' · '+x.code+' · '+x.ms+' мс').join('; ')}catch{}
 document.getElementById('connectionDetails').hidden=!expanded;
 document.getElementById('connectionDetailsToggle').setAttribute('aria-expanded',String(expanded));
 const button=document.getElementById('connectionRetry');button.disabled=busy;button.textContent=busy?'Проверяем…':'Проверить связь';paintHeader();
}
function fail(error){failure={...describe(error),at:Date.now()};expanded=true;paint()}
async function retry(){
 if(busy)return;busy=true;paint();
 try{if(typeof warehouseLocalDirty!=='undefined'&&warehouseLocalDirty)await pushWarehouseToServer();else await pullWarehouseFromServer({force:true})}finally{busy=false;paint()}
}
const previousFetch=window.fetch.bind(window);
window.fetch=async function(input,options){
 let target=false;
 try{const url=new URL(typeof input==='string'?input:input.url,location.href);target=url.origin===new URL(MILLIONER_API).origin&&url.pathname===new URL(MILLIONER_API+'/api/warehouse-state').pathname}catch{}
 if(!target)return previousFetch(input,options);
 const started=Date.now(),method=String(options?.method||input?.method||'GET').toUpperCase();
 const controller=new AbortController(),signal=options?.signal||input?.signal;
 const abort=()=>controller.abort();if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
 let timer;
 try{
  const response=await Promise.race([(async()=>{
   const response=await previousFetch(input,{...options,signal:controller.signal});
   if(response.ok){
    let data;try{data=await response.clone().json()}catch{throw Object.assign(new Error('Invalid warehouse response'),{code:'INVALID_RESPONSE'})}
    if(!data||data.ok===false)throw Object.assign(new Error('Invalid warehouse response'),{code:'INVALID_RESPONSE'});
   }
   return response;
  })(),new Promise((_,reject)=>{timer=setTimeout(()=>{reject(Object.assign(new Error('Warehouse request timed out'),{name:'TimeoutError'}));controller.abort()},method==='GET'?15000:45000)})]);
  if(response.ok){verifiedAt=Date.now();failure=null;expanded=false;paint()}else if(response.status!==409)fail({status:response.status});
  record(response.ok?'OK':'HTTP '+response.status,method,started);
  return response;
 }catch(error){record(describe(error).code,method,started);fail(error);throw error}
 finally{clearTimeout(timer);signal?.removeEventListener('abort',abort)}
};
let reporting=false;
async function flushDiagnostics(){
 if(reporting)return;reporting=true;
 try{
  const key='sklad_connection_attempts_v1',list=JSON.parse(localStorage.getItem(key)||'[]'),sent=Number(localStorage.getItem(key+'_sent')||0);
  const attempts=list.filter(x=>Number(x.at)>sent);
  if(!attempts.some(x=>x.code!=='OK'))return;
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),5000);
  try{const response=await previousFetch(MILLIONER_API+'/api/system/client-diagnostics',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({attempts}),signal:controller.signal});if(response.ok)localStorage.setItem(key+'_sent',String(Math.max(...attempts.map(x=>Number(x.at)||0))))}finally{clearTimeout(timer)}
 }catch{}finally{reporting=false}
}
function record(code,method,started){try{const key='sklad_connection_attempts_v1',list=JSON.parse(localStorage.getItem(key)||'[]');list.push({path:'/api/warehouse-state',method,code,at:Date.now(),ms:Date.now()-started});localStorage.setItem(key,JSON.stringify(list.slice(-12)))}catch{}if(code==='OK')void flushDiagnostics()}
window.warehouseConnection={paintHeader,fail};
window.addEventListener('offline',()=>fail({}));
window.addEventListener('online',()=>retry());
document.addEventListener('click',event=>{if(event.target?.closest?.('.compact-cloud')){expanded=!expanded;paint()}});
const style=document.createElement('style');style.textContent=`
.connection-panel{margin:12px 12px 0;padding:16px;background:#fffbef;border:1px solid #ead6a5;border-radius:18px;color:#48391f;box-shadow:0 4px 18px #33240b05}.connection-panel[hidden]{display:none}.connection-top{display:flex;gap:12px;align-items:flex-start}.connection-symbol{width:34px;height:34px;border-radius:50%;background:#f6e9c8;display:grid;place-items:center;font-size:23px;flex:none}.connection-panel strong{font-size:15px;line-height:1.4}.connection-panel p{font-size:13px;line-height:1.55;margin:5px 0 0}.connection-actions{display:flex;gap:8px;margin-top:14px;flex-wrap:wrap}.connection-actions button{font:600 13px system-ui;min-height:42px;padding:9px 14px;border-radius:11px;border:1px solid #ddc99d;background:transparent;color:#624921}.connection-actions button:first-child{background:#332b20;border-color:#332b20;color:white}.connection-actions button:disabled{opacity:.6}.connection-panel small{display:block;margin-top:10px;color:#76674f;font-size:11px}.compact-cloud{cursor:pointer}#connectionDetails{margin-top:12px;border-top:1px solid #ead6a5;padding-top:8px}@media(min-width:600px){.connection-panel{margin-left:16px;margin-right:16px}}`;
document.head.appendChild(style);
})();

