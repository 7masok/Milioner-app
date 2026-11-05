(function(){
'use strict';
let settled=false,blocked=false,box=null,recoveryTimer=null,lastProgress=Date.now();
const started=Date.now(),retryKey='warehouse_boot_retries_v2',bootFetch=window.fetch?.bind(window);
function pendingScript(){return Array.from(document.scripts||[]).find(s=>s.src&&!s.dataset.bootLoaded)}
function show(failed=false,reason='',code='BOOT_TIMEOUT'){
 if(settled)return;
 if(failed)try{const key='sklad_connection_attempts_v1',list=JSON.parse(localStorage.getItem(key)||'[]');list.push({path:'/',code,at:Date.now(),ms:Date.now()-started});localStorage.setItem(key,JSON.stringify(list.slice(-12)))}catch{}
 if(!box){
  box=document.createElement('section');box.id='warehouseBootStatus';box.setAttribute('role','status');
  box.style.cssText='position:fixed;inset:0;z-index:10000;background:#f5f6f8;color:#18232b;font:14px/1.6 system-ui;display:grid;place-items:center;padding:22px;overflow:auto';
  box.innerHTML='<div style="width:min(440px,100%);background:#fff;border:1px solid #e5e8eb;border-radius:24px;padding:26px"><b style="font-size:22px">Склад</b><h1 id="warehouseBootTitle" style="font-size:24px;line-height:1.25"></h1><p id="warehouseBootReason"></p><button type="button" id="warehouseBootRetry" style="font:600 15px system-ui;background:#172d3a;color:white;border:0;border-radius:12px;padding:14px;width:100%">Повторить подключение</button><details style="margin-top:16px;color:#67717a;font-size:12px"><summary>Подробности</summary><p id="warehouseBootResource" style="overflow-wrap:anywhere"></p><p id="warehouseBootTime"></p></details></div>';
  document.documentElement.appendChild(box);
  document.getElementById('warehouseBootRetry').onclick=()=>{try{sessionStorage.removeItem(retryKey)}catch{}location.reload()};
 }
 document.getElementById('warehouseBootTitle').textContent=failed?'Не удалось подключиться':'Загружаем склад';
 document.getElementById('warehouseBootReason').textContent=reason||(failed?'Проверяем соединение и попробуем снова автоматически.':'Подключение занимает больше времени. Загрузка продолжается.');
 const pending=pendingScript();
 document.getElementById('warehouseBootResource').textContent=pending?'Ожидаем модуль '+new URL(pending.src,location.href).pathname:'Проверка доступа или запуск интерфейса.';
 document.getElementById('warehouseBootTime').textContent=new Date(started).toLocaleString('ru-RU',{timeZone:'Asia/Almaty'})+' · Алматы';
}
function retryBudget(){try{const saved=JSON.parse(sessionStorage.getItem(retryKey)||'{}');return Date.now()-Number(saved.at)<5*60000?saved:{at:Date.now(),count:0}}catch{return {at:Date.now(),count:0}}}
async function available(url,page=false){
 if(!bootFetch)return false;
 const controller=new AbortController();let timer;
 try{return await Promise.race([(async()=>{const r=await bootFetch(url,{cache:'no-store',signal:controller.signal});if(!r.ok)return false;const body=await r.text();return page?body.includes('warehouse-boot-guard'):body.length>0})(),new Promise(resolve=>{timer=setTimeout(()=>{controller.abort();resolve(false)},8000)})])}catch{return false}finally{clearTimeout(timer)}
}
function scheduleRecovery(delay=10000){clearTimeout(recoveryTimer);if(!settled)recoveryTimer=setTimeout(recover,delay)}
async function recover(){
 if(settled)return;
 const pending=pendingScript(),progressAt=lastProgress;
 if(!blocked&&(!pending||Date.now()-lastProgress<30000)){scheduleRecovery();return}
 const budget=retryBudget();
 if(Number(budget.count)>=2){show(true,'Связь пока не восстановилась. Можно повторить подключение вручную.');scheduleRecovery(30000);return}
 const page=await available(location.href,true);
 if(settled)return;
 if(!blocked&&lastProgress!==progressAt){scheduleRecovery();return}
 const asset=page&&(!pending||await available(pending.src));
 if(settled)return;
 if(!blocked&&lastProgress!==progressAt){scheduleRecovery();return}
 if(page&&asset){
  try{sessionStorage.setItem(retryKey,JSON.stringify({at:budget.at,count:Number(budget.count||0)+1}))}catch{scheduleRecovery();return}
  location.reload();return;
 }
 show(true);scheduleRecovery();
}
const timer=setTimeout(()=>{if(!blocked)show()},10000);
scheduleRecovery(30000);
window.addEventListener('load',event=>{if(event.target?.tagName==='SCRIPT'){event.target.dataset.bootLoaded='1';lastProgress=Date.now();if(box&&!blocked)show()}},true);
window.addEventListener('error',event=>{
 if(settled)return;
 if(event.target?.tagName==='SCRIPT'){blocked=true;show(true,'Не удалось загрузить часть страницы. Проверяем соединение.','BOOT_SCRIPT');document.getElementById('warehouseBootResource').textContent=new URL(event.target.src,location.href).pathname;scheduleRecovery(3000)}
 else if(event.message){blocked=true;show(true,'Не удалось завершить запуск. Попробуем подключиться снова.','BOOT_ERROR');document.getElementById('warehouseBootResource').textContent=String(event.message).slice(0,180);scheduleRecovery(3000)}
},true);
window.warehouseBoot={canStart(){return !blocked},complete(){settled=true;clearTimeout(timer);clearTimeout(recoveryTimer);box?.remove();try{sessionStorage.removeItem(retryKey)}catch{}}};
})();
