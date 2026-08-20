(function(){
'use strict';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const SERVER_MANAGED_CACHE_KEYS=['kaspiOrderFeed','wbOrderFeed','ozonOrderFeed','kaspiOrders','marketOrderState','marketplaceLiveSince'];
let reportPeriodUiPendingServerSave=false;

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
  delete snapshot.settings.serverUpdatedAt;
  for(const key of SERVER_MANAGED_CACHE_KEYS)delete snapshot[key];
  return snapshot;
}
function snapshotText(source){return JSON.stringify(serverSnapshot(source));}
warehouseSnapshot=function(){return serverSnapshot(state)};
applyWarehouseSnapshot=function(remote){
  state=serverSnapshot(remote);
  const persistedReportPeriod=Number(state.settings?.reportPeriodPreset);
  const serverReportPeriodUpdatedAt=Number(state.settings?.reportPeriodUpdatedAt||0);
  const localReportPeriodUpdatedAt=Number(reportPeriodUiPreference?.updatedAt||0);
  const keepNewerUiPreference=[-1,0,1,7,30].includes(Number(reportPeriodUiPreference?.preset))&&localReportPeriodUpdatedAt>serverReportPeriodUpdatedAt;
  if(keepNewerUiPreference){
    reportPeriodPreset=Number(reportPeriodUiPreference.preset);reportPeriod=reportPeriodPreset===0?0:reportPeriodPreset;
    reportCustomFrom=String(reportPeriodUiPreference.from||'');reportCustomTo=String(reportPeriodUiPreference.to||'');
  }else if([-1,0,1,7,30].includes(persistedReportPeriod)){
    reportPeriodPreset=persistedReportPeriod;reportPeriod=reportPeriodPreset===0?0:reportPeriodPreset;
    reportCustomFrom=String(state.settings?.reportCustomFrom||'');reportCustomTo=String(state.settings?.reportCustomTo||'');
  }
  rememberReportPeriodUiPreference?.();
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
  if(!warehouseRemoteReady)return false;
  stampChangedWarehouseEntities();warehouseLastObservedSnapshot=normalizeWarehouseSnapshot(state);
  if(snapshotText(state)!==warehouseLastSyncedText){state.settings=state.settings||{};state.settings.serverUpdatedAt=Date.now();markWarehouseDirty();scheduleWarehouseSave()}
  return true;
};
pushWarehouseToD1=async function(){
  if(!warehouseRemoteReady||warehouseSaveInFlight||!warehouseLocalDirty)return false;
  warehouseSaveInFlight=true;cloudStatus('сохраняю на сервер…','warn');
  try{
    const sent=serverSnapshot(state),sentText=JSON.stringify(sent),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),45000);
    let response,data={};
    try{response=await fetch(MILLIONER_API+'/api/warehouse-state',{method:'PUT',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({baseRevision:warehouseRemoteRevision,state:sent}),signal:controller.signal});try{data=await response.json()}catch{}}
    finally{clearTimeout(timer)}
    if(response.status===409){
      const remote=await fetchServer(false,3);warehouseRemoteRevision=Number(remote.revision||0);warehouseRemoteUpdatedAt=Number(remote.updatedAt||0);
      warehouseLastCloudSnapshot=serverSnapshot(remote.state);warehouseLastSyncedText=snapshotText(remote.state);applyWarehouseSnapshot(remote.state);
      clearWarehouseDirty();render();cloudStatus('обновлено с сервера','ok');return false;
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
    applyWarehouseSnapshot(remote.state);clearWarehouseDirty();render();cloudStatus('обновлено с сервера','ok');setTimeout(restoreOrderMarketUi,0);return true;
  }catch(error){console.warn('server warehouse pull failed',error);cloudStatus('сервер временно недоступен','warn');return false}
  finally{warehousePullInFlight=false}
};
bootstrapWarehouseD1=async function(){
  warehouseRemoteReady=false;warehouseLocalDirty=false;cloudStatus('загружаю серверную базу…','warn');
  try{
    const remote=await fetchServer(false,4);if(!remote.exists)throw new Error('Серверная база склада пуста — запись заблокирована до завершения миграции');
    warehouseRemoteRevision=Number(remote.revision||0);warehouseRemoteUpdatedAt=Number(remote.updatedAt||0);
    warehouseLastCloudSnapshot=serverSnapshot(remote.state);warehouseLastSyncedText=snapshotText(remote.state);applyWarehouseSnapshot(remote.state);
    clearWarehouseDirty();warehouseRemoteReady=true;reportPeriodUiPendingServerSave=false;
    render();setTimeout(restoreOrderMarketUi,0);cloudStatus('сервер подключён','ok');return {mode:'server-authoritative',revision:warehouseRemoteRevision};
  }catch(error){warehouseRemoteReady=false;clearWarehouseDirty();console.error('server bootstrap failed',error);cloudStatus('нет связи с сервером · изменения заблокированы','warn');return {mode:'server-unavailable',error:String(error?.message||error)}}
};
startWarehouseCloudWatcher=function(){
  if(warehouseWatchStarted)return;warehouseWatchStarted=true;setInterval(()=>pullWarehouseFromD1(),5000);
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')pullWarehouseFromD1({force:true})});
  window.addEventListener('focus',()=>pullWarehouseFromD1({force:true}));window.addEventListener('online',()=>pullWarehouseFromD1({force:true}));
};

const ORDER_PERIOD_UI_KEY='milioner_order_period_ui_v1';
function readOrderPeriodUi(){try{return JSON.parse(localStorage.getItem(ORDER_PERIOD_UI_KEY)||'{}')||{}}catch{return {}}}
function rememberOrderPeriodUi(mode){try{const current=readOrderPeriodUi();localStorage.setItem(ORDER_PERIOD_UI_KEY,JSON.stringify({mode:mode||current.mode||'today',from:document.getElementById('orderDateFrom')?.value||current.from||'',to:document.getElementById('orderDateTo')?.value||current.to||''}))}catch{}}
const originalSetOrderPeriod=window.setOrderPeriod;
if(typeof originalSetOrderPeriod==='function')window.setOrderPeriod=function(mode){const result=originalSetOrderPeriod(mode);rememberOrderPeriodUi(mode);return result};
const originalSetOrderCustomDate=window.setOrderCustomDate;
if(typeof originalSetOrderCustomDate==='function')window.setOrderCustomDate=function(which,value){const result=originalSetOrderCustomDate(which,value);rememberOrderPeriodUi('custom');return result};
const savedOrderPeriodUi=readOrderPeriodUi();
if(['today','yesterday','week','month','custom'].includes(savedOrderPeriodUi.mode)){orderPeriodMode=savedOrderPeriodUi.mode;if(savedOrderPeriodUi.from)orderCustomFrom=savedOrderPeriodUi.from;if(savedOrderPeriodUi.to)orderCustomTo=savedOrderPeriodUi.to;renderOrderPeriodControls?.()}

const ORDER_MARKET_UI_KEY='milioner_order_market_ui_v2';
function readOrderMarketUi(){try{return JSON.parse(localStorage.getItem(ORDER_MARKET_UI_KEY)||'{}')||{}}catch{return {}}}
function rememberOrderMarketUi(next={}){
  try{const current=readOrderMarketUi();localStorage.setItem(ORDER_MARKET_UI_KEY,JSON.stringify({market:next.market||current.market||'Kaspi',wbAccount:next.wbAccount||current.wbAccount||'all',updatedAt:Date.now()}))}catch{}
}
document.addEventListener('click',event=>{
  const marketBtn=event.target?.closest?.('[data-market]');
  if(marketBtn){const market=String(marketBtn.dataset.market||'');if(['Kaspi','WB','Ozon'].includes(market))rememberOrderMarketUi({market})}
  const wbBtn=event.target?.closest?.('[data-wb-account]');
  if(wbBtn){const wbAccount=String(wbBtn.dataset.wbAccount||'');if(['all','WB','WB2'].includes(wbAccount))rememberOrderMarketUi({market:'WB',wbAccount})}
},true);
function restoreOrderMarketUi(){
  const saved=readOrderMarketUi();
  if(!['Kaspi','WB','Ozon'].includes(saved.market))return;
  const marketBtn=document.querySelector(`[data-market="${saved.market}"]`);
  if(marketBtn&&!marketBtn.classList.contains('active'))marketBtn.click();
  if(saved.market==='WB'&&['all','WB','WB2'].includes(saved.wbAccount)){
    const wbBtn=document.querySelector(`[data-wb-account="${saved.wbAccount}"]`);
    if(wbBtn&&!wbBtn.classList.contains('active'))wbBtn.click();
  }
}
window.addEventListener('load',()=>{[0,250,800,1800,3500].forEach(ms=>setTimeout(restoreOrderMarketUi,ms))});

function syncLabel(ts){
  const value=Number(ts)||0;if(!value)return '—';const d=new Date(value),now=new Date();const time=d.toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'});
  const same=d.getFullYear()===now.getFullYear()&&d.getMonth()===now.getMonth()&&d.getDate()===now.getDate();const y=new Date(now);y.setDate(now.getDate()-1);
  const yesterday=d.getFullYear()===y.getFullYear()&&d.getMonth()===y.getMonth()&&d.getDate()===y.getDate();
  return same?time:yesterday?'вчера '+time:d.toLocaleDateString('ru-RU',{day:'2-digit',month:'2-digit'})+' '+time;
}
function showMarketSyncTimes(){
  const status=state.settings?.serverMarketStatus||{};
  const kaspi=document.getElementById('lastSync');if(kaspi)kaspi.textContent=syncLabel(status.Kaspi?.lastSuccessAt);
  const wb=document.getElementById('wbStockStatus');if(wb){const t=Math.max(Number(status.WB?.lastSuccessAt||0),Number(status.WB2?.lastSuccessAt||0));wb.textContent=t?syncLabel(t):'—'}
}
const originalLoadSharedOrderCache=window.loadSharedOrderCache;
if(typeof originalLoadSharedOrderCache==='function'){
  window.loadSharedOrderCache=async function(options){
    for(let waited=0;!warehouseRemoteReady&&waited<15000;waited+=50)await sleep(50);
    if(!warehouseRemoteReady)return {error:new Error('warehouse-not-ready')};
    const result=await originalLoadSharedOrderCache(options);showMarketSyncTimes();restoreOrderMarketUi();setTimeout(restoreOrderMarketUi,100);return result;
  };
}
window.syncNow=async function(){
  const btn=document.querySelector('header .btn'),old=btn?.textContent;if(btn){btn.disabled=true;btn.textContent='…'}
  try{
    cloudStatus('обновляю маркетплейсы…','warn');
    const results=await Promise.allSettled([
      fetch(MILLIONER_API+'/api/kaspi-sync-now',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({days:2}),cache:'no-store'}).then(async r=>{const d=await r.json().catch(()=>({}));if(!r.ok||d?.ok===false)throw new Error(d?.error||('Kaspi HTTP '+r.status));return d}),
      fetch(MILLIONER_API+'/api/wb-sync-now',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({days:2}),cache:'no-store'}).then(async r=>{const d=await r.json().catch(()=>({}));if(!r.ok||d?.ok===false)throw new Error(d?.error||('WB HTTP '+r.status));return d})
    ]);
    await window.loadSharedOrderCache?.({silent:false});showMarketSyncTimes();restoreOrderMarketUi();
    const failed=results.filter(x=>x.status==='rejected');if(failed.length)console.warn('market sync partial failure',failed);
    cloudStatus('сервер подключён','ok');
  }catch(e){await window.loadSharedOrderCache?.({silent:true}).catch(()=>{});showMarketSyncTimes();cloudStatus('сервер подключён · ошибка синхронизации','warn')}
  finally{if(btn){btn.disabled=false;btn.textContent=old||'↻'}}
};
setTimeout(showMarketSyncTimes,0);
})();
