(function(){
'use strict';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function serverSnapshot(source){
  const input=source&&typeof source==='object'&&!Array.isArray(source)?source:{};
  const snapshot=JSON.parse(JSON.stringify(input));
  snapshot.products=Array.isArray(snapshot.products)?snapshot.products:[];
  snapshot.movements=Array.isArray(snapshot.movements)?snapshot.movements:[];
  snapshot.sales=Array.isArray(snapshot.sales)?snapshot.sales:[];
  snapshot.purchases=Array.isArray(snapshot.purchases)?snapshot.purchases:[];
  snapshot.reservations=Array.isArray(snapshot.reservations)?snapshot.reservations:[];
  snapshot.kaspiAdExpenses=Array.isArray(snapshot.kaspiAdExpenses)?snapshot.kaspiAdExpenses:[];
  snapshot.settings=snapshot.settings&&typeof snapshot.settings==='object'?snapshot.settings:{};
  for(const key of WAREHOUSE_VOLATILE_SETTINGS||[])delete snapshot.settings[key];
  return snapshot;
}

function snapshotText(source){return JSON.stringify(serverSnapshot(source));}

warehouseSnapshot=function(){return serverSnapshot(state)};
applyWarehouseSnapshot=function(remote){
  state=serverSnapshot(remote);
  state.purchases.forEach(item=>{
    item.status=['to_forwarder','to_me','at_warehouse','received'].includes(String(item.status||''))?String(item.status):'received';
    if(item.status==='received'){
      item.receivedAt=Number(item.receivedAt||item.date)||Date.now();
      item.remainingQty=Number.isFinite(Number(item.remainingQty))?Math.max(0,Number(item.remainingQty)):Math.max(0,Number(item.qty)||0);
      item.landedUnitCost=Number(item.landedUnitCost)||((Number(item.unitCost)||0)+((Number(item.delivery)||0)/Math.max(1,Number(item.qty)||1)));
    }
  });
  warehouseLastObservedSnapshot=normalizeWarehouseSnapshot(state);
};

// Business data is never written to localStorage. Old browser copies remain only
// as emergency pre-migration backups and are never read or uploaded.
saveLocalOnly=function(){};
markWarehouseDirty=function(){warehouseLocalDirty=true;cloudStatus('есть несохранённые изменения','warn')};
clearWarehouseDirty=function(){warehouseLocalDirty=false};

async function fetchServer(meta=false,retries=3){
  let lastError=null;
  for(let attempt=0;attempt<retries;attempt++){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),meta?20000:60000);
    try{
      const response=await fetch(MILLIONER_API+'/api/warehouse-state'+(meta?'?meta=1':''),{cache:'no-store',headers:{Accept:'application/json'},signal:controller.signal});
      let data={};try{data=await response.json()}catch{}
      if(!response.ok||data.ok===false)throw new Error(data.error||('HTTP '+response.status));
      return data;
    }catch(error){lastError=error;if(attempt+1<retries)await sleep(800*(attempt+1))}
    finally{clearTimeout(timer)}
  }
  throw lastError||new Error('Сервер не отвечает');
}

fetchWarehouseCloud=async function(){return fetchServer(false,3)};

scheduleWarehouseSave=function(delay=350){
  if(!warehouseRemoteReady)return;
  clearTimeout(warehouseSaveTimer);
  warehouseSaveTimer=setTimeout(()=>pushWarehouseToD1().catch(error=>{
    console.error('server warehouse save failed',error);cloudStatus('изменения не сохранены · повторяю','warn');
    if(warehouseLocalDirty)setTimeout(()=>scheduleWarehouseSave(0),3000);
  }),delay);
};

save=function(){
  if(!warehouseRemoteReady){cloudStatus('сервер ещё не загружен · изменение заблокировано','warn');return false}
  stampChangedWarehouseEntities();state.settings=state.settings||{};state.settings.serverUpdatedAt=Date.now();
  warehouseLastObservedSnapshot=normalizeWarehouseSnapshot(state);
  if(snapshotText(state)!==warehouseLastSyncedText){markWarehouseDirty();scheduleWarehouseSave()}
  return true;
};

pushWarehouseToD1=async function(){
  if(!warehouseRemoteReady||warehouseSaveInFlight||!warehouseLocalDirty)return false;
  warehouseSaveInFlight=true;cloudStatus('сохраняю на сервер…','warn');
  try{
    const sent=serverSnapshot(state),sentText=JSON.stringify(sent),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),45000);
    let response,data={};
    try{
      response=await fetch(MILLIONER_API+'/api/warehouse-state',{method:'PUT',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({baseRevision:warehouseRemoteRevision,state:sent}),signal:controller.signal});
      try{data=await response.json()}catch{}
    }finally{clearTimeout(timer)}
    if(response.status===409){
      const remote=await fetchServer(false,3);warehouseRemoteRevision=Number(remote.revision||0);warehouseRemoteUpdatedAt=Number(remote.updatedAt||0);
      warehouseLastCloudSnapshot=serverSnapshot(remote.state);warehouseLastSyncedText=snapshotText(remote.state);applyWarehouseSnapshot(remote.state);
      clearWarehouseDirty();render();cloudStatus('загружена более новая версия сервера','warn');
      alert('Данные уже были изменены на другом устройстве. Загружена последняя серверная версия; повторите своё изменение.');return false;
    }
    if(!response.ok||data.ok===false)throw new Error(data.error||('HTTP '+response.status));
    warehouseRemoteRevision=Number(data.revision||warehouseRemoteRevision);warehouseRemoteUpdatedAt=Number(data.updatedAt||Date.now());
    warehouseLastCloudSnapshot=sent;warehouseLastSyncedText=sentText;
    if(snapshotText(state)===sentText){clearWarehouseDirty();cloudStatus('сохранено на сервере','ok')}else{markWarehouseDirty();scheduleWarehouseSave(50)}
    return true;
  }finally{warehouseSaveInFlight=false}
};

pullWarehouseFromD1=async function({force=false}={}){
  if(warehousePullInFlight||warehouseSaveInFlight||warehouseLocalDirty)return false;
  warehousePullInFlight=true;if(force)cloudStatus('проверяю сервер…','warn');
  try{
    const meta=await fetchServer(true,2),revision=Number(meta.revision||0);
    if(!meta.exists||revision<=warehouseRemoteRevision){cloudStatus('сервер подключён','ok');return true}
    const remote=await fetchServer(false,3);warehouseRemoteRevision=Number(remote.revision||revision);warehouseRemoteUpdatedAt=Number(remote.updatedAt||0);
    warehouseRemoteReady=true;warehouseLastCloudSnapshot=serverSnapshot(remote.state);warehouseLastSyncedText=snapshotText(remote.state);
    applyWarehouseSnapshot(remote.state);clearWarehouseDirty();render();cloudStatus('обновлено с сервера','ok');return true;
  }catch(error){console.warn('server warehouse pull failed',error);cloudStatus('сервер временно недоступен','warn');return false}
  finally{warehousePullInFlight=false}
};

bootstrapWarehouseD1=async function(){
  warehouseRemoteReady=false;warehouseLocalDirty=false;cloudStatus('загружаю серверную базу…','warn');
  try{
    const remote=await fetchServer(false,4);if(!remote.exists)throw new Error('Серверная база склада пуста — запись заблокирована до завершения миграции');
    warehouseRemoteRevision=Number(remote.revision||0);warehouseRemoteUpdatedAt=Number(remote.updatedAt||0);
    warehouseLastCloudSnapshot=serverSnapshot(remote.state);warehouseLastSyncedText=snapshotText(remote.state);applyWarehouseSnapshot(remote.state);
    clearWarehouseDirty();warehouseRemoteReady=true;render();cloudStatus('сервер подключён','ok');return {mode:'server-authoritative',revision:warehouseRemoteRevision};
  }catch(error){warehouseRemoteReady=false;clearWarehouseDirty();console.error('server bootstrap failed',error);cloudStatus('нет связи с сервером · изменения заблокированы','warn');return {mode:'server-unavailable',error:String(error?.message||error)}}
};

startWarehouseCloudWatcher=function(){
  if(warehouseWatchStarted)return;warehouseWatchStarted=true;setInterval(()=>pullWarehouseFromD1(),5000);
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')pullWarehouseFromD1({force:true})});
  window.addEventListener('focus',()=>pullWarehouseFromD1({force:true}));window.addEventListener('online',()=>pullWarehouseFromD1({force:true}));
};
})();

