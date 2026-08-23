(function(){
'use strict';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const SERVER_MANAGED_CACHE_KEYS=['kaspiOrderFeed','wbOrderFeed','ozonOrderFeed','kaspiOrders','marketOrderState','marketplaceLiveSince'];
const FAST_CACHE_KEY='milioner_server_snapshot_cache_v2';
let reportPeriodUiPendingServerSave=false;
let showingReadOnlyCache=false;

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
function readFastCache(){try{return JSON.parse(localStorage.getItem(FAST_CACHE_KEY)||'null')}catch{return null}}
function writeFastCache(source,revision,updatedAt){
  try{
    const snap=serverSnapshot(source);
    if(!snap.products.length)return;
    localStorage.setItem(FAST_CACHE_KEY,JSON.stringify({state:snap,revision:Number(revision||0),updatedAt:Number(updatedAt||Date.now())}));
  }catch{}
}
function setReadOnlyCache(on){
  showingReadOnlyCache=Boolean(on);
  document.documentElement?.toggleAttribute('data-warehouse-readonly-cache',showingReadOnlyCache);
}
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

// Safe instant start: show only a previously server-confirmed snapshot.
// It is display-only until the current server revision has been fetched.
const fastCached=readFastCache();
if(fastCached?.state?.products?.length){
  applyWarehouseSnapshot(fastCached.state);
  warehouseRemoteRevision=0;
  warehouseRemoteUpdatedAt=Number(fastCached.updatedAt||0);
  warehouseLastCloudSnapshot=serverSnapshot(fastCached.state);
  warehouseLastSyncedText=snapshotText(fastCached.state);
  warehouseLocalDirty=false;
  setReadOnlyCache(true);
  try{render()}catch{}
  cloudStatus('последние данные · подключаюсь…','warn');
}

saveLocalOnly=function(){};
markWarehouseDirty=function(){
  if(!warehouseRemoteReady||showingReadOnlyCache){warehouseLocalDirty=false;cloudStatus('только просмотр · подключаюсь…','warn');return false}
  warehouseLocalDirty=true;cloudStatus('есть несохранённые изменения','warn');return true;
};
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
  if(!warehouseRemoteReady||showingReadOnlyCache)return;
  clearTimeout(warehouseSaveTimer);
  warehouseSaveTimer=setTimeout(()=>pushWarehouseToServer().catch(error=>{
    console.error('server warehouse save failed',error);cloudStatus('изменения не сохранены · повторяю','warn');
    if(warehouseLocalDirty)setTimeout(()=>scheduleWarehouseSave(0),3000);
  }),delay);
};
save=function(){
  if(!warehouseRemoteReady||showingReadOnlyCache){cloudStatus('только просмотр · подключаюсь…','warn');return false}
  stampChangedWarehouseEntities();warehouseLastObservedSnapshot=normalizeWarehouseSnapshot(state);
  if(snapshotText(state)!==warehouseLastSyncedText){state.settings=state.settings||{};state.settings.serverUpdatedAt=Date.now();markWarehouseDirty();scheduleWarehouseSave()}
  return true;
};
pushWarehouseToServer=async function(){
  if(!warehouseRemoteReady||showingReadOnlyCache||warehouseSaveInFlight||!warehouseLocalDirty)return false;
  warehouseSaveInFlight=true;cloudStatus('сохраняю на сервер…','warn');
  try{
    const sent=serverSnapshot(state),sentText=JSON.stringify(sent),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),45000);
    let response,data={};
    try{response=await fetch(MILLIONER_API+'/api/warehouse-state',{method:'PUT',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({baseRevision:warehouseRemoteRevision,state:sent}),signal:controller.signal});try{data=await response.json()}catch{}}
    finally{clearTimeout(timer)}
    if(response.status===409){
      const remote=await fetchServer(false,3);warehouseRemoteRevision=Number(remote.revision||0);warehouseRemoteUpdatedAt=Number(remote.updatedAt||0);
      warehouseLastCloudSnapshot=serverSnapshot(remote.state);warehouseLastSyncedText=snapshotText(remote.state);applyWarehouseSnapshot(remote.state);
      clearWarehouseDirty();setReadOnlyCache(false);writeFastCache(remote.state,warehouseRemoteRevision,warehouseRemoteUpdatedAt);render();cloudStatus('обновлено с сервера','ok');return false;
    }
    if(!response.ok||data.ok===false)throw new Error(data.error||('HTTP '+response.status));
    warehouseRemoteRevision=Number(data.revision||warehouseRemoteRevision);warehouseRemoteUpdatedAt=Number(data.updatedAt||Date.now());
    warehouseLastCloudSnapshot=sent;warehouseLastSyncedText=sentText;writeFastCache(sent,warehouseRemoteRevision,warehouseRemoteUpdatedAt);
    if(snapshotText(state)===sentText){clearWarehouseDirty();cloudStatus('сохранено на сервере','ok')}else{markWarehouseDirty();scheduleWarehouseSave(50)}
    return true;
  }finally{warehouseSaveInFlight=false}
};
pullWarehouseFromServer=async function({force=false}={}){
  if(warehousePullInFlight||warehouseSaveInFlight||warehouseLocalDirty)return false;
  warehousePullInFlight=true;if(force)cloudStatus('проверяю сервер…','warn');
  try{
    const meta=await fetchServer(true,2),revision=Number(meta.revision||0);
    if(!meta.exists){cloudStatus('серверная база недоступна · показаны последние данные','warn');return false}
    if(revision<=warehouseRemoteRevision&&warehouseRemoteReady){setReadOnlyCache(false);cloudStatus('сервер подключён','ok');return true}
    const remote=await fetchServer(false,3);warehouseRemoteRevision=Number(remote.revision||revision);warehouseRemoteUpdatedAt=Number(remote.updatedAt||0);
    warehouseRemoteReady=true;warehouseLastCloudSnapshot=serverSnapshot(remote.state);warehouseLastSyncedText=snapshotText(remote.state);
    applyWarehouseSnapshot(remote.state);clearWarehouseDirty();setReadOnlyCache(false);writeFastCache(remote.state,warehouseRemoteRevision,warehouseRemoteUpdatedAt);render();cloudStatus('обновлено с сервера','ok');setTimeout(restoreOrderMarketUi,0);return true;
  }catch(error){console.warn('server warehouse pull failed',error);cloudStatus(fastCached?.state?'сервер недоступен · показаны последние данные':'сервер временно недоступен','warn');return false}
  finally{warehousePullInFlight=false}
};
bootstrapWarehouseFromServer=async function(){
  warehouseRemoteReady=false;warehouseLocalDirty=false;cloudStatus(fastCached?.state?'последние данные · подключаюсь…':'загружаю серверную базу…','warn');
  try{
    const remote=await fetchServer(false,4);if(!remote.exists)throw new Error('Серверная база склада пуста — запись заблокирована до завершения миграции');
    warehouseRemoteRevision=Number(remote.revision||0);warehouseRemoteUpdatedAt=Number(remote.updatedAt||0);
    warehouseLastCloudSnapshot=serverSnapshot(remote.state);warehouseLastSyncedText=snapshotText(remote.state);applyWarehouseSnapshot(remote.state);
    clearWarehouseDirty();warehouseRemoteReady=true;setReadOnlyCache(false);reportPeriodUiPendingServerSave=false;
    writeFastCache(remote.state,warehouseRemoteRevision,warehouseRemoteUpdatedAt);
    render();setTimeout(restoreOrderMarketUi,0);cloudStatus('сервер подключён','ok');return {mode:'server-authoritative',revision:warehouseRemoteRevision};
  }catch(error){warehouseRemoteReady=false;clearWarehouseDirty();setReadOnlyCache(Boolean(fastCached?.state));console.error('server bootstrap failed',error);cloudStatus(fastCached?.state?'сервер недоступен · показаны последние данные':'нет связи с сервером · изменения заблокированы','warn');return {mode:'server-unavailable',error:String(error?.message||error)}}
};
startWarehouseServerWatcher=function(){
  if(warehouseWatchStarted)return;warehouseWatchStarted=true;setInterval(()=>pullWarehouseFromServer(),5000);
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')pullWarehouseFromServer({force:true})});
  window.addEventListener('focus',()=>pullWarehouseFromServer({force:true}));window.addEventListener('online',()=>pullWarehouseFromServer({force:true}));
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
  if(marketBtn){const market=String(marketBtn.dataset.market||'');if(['all','Kaspi','WB','Ozon'].includes(market))rememberOrderMarketUi({market})}
  const wbBtn=event.target?.closest?.('[data-wb-account]');
  if(wbBtn){const wbAccount=String(wbBtn.dataset.wbAccount||'');if(['all','WB','WB2'].includes(wbAccount))rememberOrderMarketUi({market:'WB',wbAccount})}
},true);
function restoreOrderMarketUi(){
  const saved=readOrderMarketUi();
  if(!['all','Kaspi','WB','Ozon'].includes(saved.market))return;
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
function ensureWbDot(){
  let dot=document.getElementById('dotWB');
  if(dot)return dot;
  const value=document.getElementById('wbStockStatus');
  if(!value||!value.parentNode)return null;
  dot=document.createElement('span');dot.id='dotWB';dot.className='dot off';dot.style.cursor='pointer';dot.title='WB: статус синхронизации';
  value.parentNode.insertBefore(dot,value);
  dot.addEventListener('click',showWbDiagnostics);
  return dot;
}
function wbHealth(){
  const status=state.settings?.serverMarketStatus||{},a=status.WB||{},b=status.WB2||{};
  const last=Math.max(Number(a.lastSuccessAt||0),Number(b.lastSuccessAt||0));
  const latest=[a.latest,b.latest].filter(Boolean).sort((x,y)=>Number(y.started_at||0)-Number(x.started_at||0))[0]||null;
  const age=last?Date.now()-last:Infinity;
  const failed=latest&&Number(latest.ok)!==1&&Number(latest.finished_at||0)>0&&Number(latest.started_at||0)>=last;
  if(failed)return {cls:'bad',label:'ошибка',last,a,b,latest};
  if(age<=10*60*1000)return {cls:'',label:'синхронизация есть',last,a,b,latest};
  if(age<=30*60*1000)return {cls:'warn',label:'синхронизация задерживается',last,a,b,latest};
  if(last)return {cls:'bad',label:'нет свежей синхронизации',last,a,b,latest};
  return {cls:'off',label:'нет данных о синхронизации',last,a,b,latest};
}
async function showWbDiagnostics(){
  let detail=wbHealth();
  try{
    const r=await fetch(MILLIONER_API+'/api/wb-sync-status',{cache:'no-store',headers:{Accept:'application/json'}});const data=await r.json().catch(()=>({}));
    if(r.ok&&data?.ok){
      const latest=(data.latest||[]).map(x=>`${x.market}: ${Number(x.ok)===1?'OK':'ОШИБКА'}${x.error?' · '+x.error:''}`).join('\n');
      const newest=(data.newestOrders||[]).map(x=>`${x.market}: последний заказ ${syncLabel(x.newest_order_at)}`).join('\n');
      return alert(`WB: ${detail.label}\nПоследний успех: ${syncLabel(detail.last)}\n${latest||'Последних попыток нет'}${newest?'\n'+newest:''}`);
    }
  }catch{}
  const err=detail.latest?.error?`\nОшибка: ${String(detail.latest.error).slice(0,300)}`:'';
  alert(`WB: ${detail.label}\nПоследний успех: ${syncLabel(detail.last)}${err}`);
}
function showMarketSyncTimes(){
  const status=state.settings?.serverMarketStatus||{};
  const kaspi=document.getElementById('lastSync');if(kaspi)kaspi.textContent=syncLabel(status.Kaspi?.lastSuccessAt);
  const wb=document.getElementById('wbStockStatus'),dot=ensureWbDot(),health=wbHealth();
  if(wb)wb.textContent=health.last?syncLabel(health.last):'—';
  if(dot){dot.className='dot'+(health.cls?' '+health.cls:'');dot.title='WB: '+health.label+' · нажмите для деталей'}
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
    const syncRequest=async(path,body,label)=>{
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),35000);
      try{
        const r=await fetch(MILLIONER_API+path,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(body),cache:'no-store',signal:controller.signal});
        const d=await r.json().catch(()=>({}));if(!r.ok||d?.ok===false)throw new Error(d?.error||(label+' HTTP '+r.status));return d;
      }finally{clearTimeout(timer)}
    };
    const results=await Promise.allSettled([
      syncRequest('/api/kaspi-sync-now',{days:2},'Kaspi'),
      syncRequest('/api/wb-sync-now',{days:2},'WB')
    ]);
    await window.loadSharedOrderCache?.({silent:false});showMarketSyncTimes();restoreOrderMarketUi();
    const failed=results.filter(x=>x.status==='rejected');if(failed.length)console.warn('market sync partial failure',failed);
    cloudStatus('сервер подключён','ok');
  }catch(e){await window.loadSharedOrderCache?.({silent:true}).catch(()=>{});showMarketSyncTimes();cloudStatus('сервер подключён · ошибка синхронизации','warn')}
  finally{if(btn){btn.disabled=false;btn.textContent=old||'↻'}}
};
setInterval(()=>showMarketSyncTimes(),30000);
setTimeout(showMarketSyncTimes,0);
})();

/* compact marketplace status rows */
(function(){
'use strict';
function addCompactStyles(){
  if(document.getElementById('compactMarketStatusStyle'))return;
  const style=document.createElement('style');style.id='compactMarketStatusStyle';style.textContent=`
  .sync.sync-compact{margin-top:7px;display:flex;align-items:flex-start;justify-content:space-between;gap:12px;font-size:12px;color:var(--muted)}
  .compact-cloud{display:flex;align-items:center;gap:5px;white-space:nowrap;min-width:0;padding-top:1px}
  .compact-cloud-label{color:var(--muted)}
  #cloudStatus{font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:120px}
  .compact-market-stack{display:flex;flex-direction:column;align-items:flex-start;gap:2px;min-width:138px}
  .compact-market-row{appearance:none;border:0;background:transparent;padding:1px 0;color:var(--muted);display:grid;grid-template-columns:11px 38px auto;align-items:center;gap:3px;font-size:11px;line-height:1.35;text-align:left;white-space:nowrap}
  .compact-market-row b{color:var(--text);font-size:11px}.compact-market-time{font-variant-numeric:tabular-nums;color:var(--muted)}
  .compact-market-row .dot{margin:0;width:7px;height:7px}.compact-market-row:active{opacity:.65}
  @media(max-width:380px){.sync.sync-compact{gap:7px}.compact-cloud{font-size:11px}#cloudStatus{max-width:92px}.compact-market-stack{min-width:124px}.compact-market-row{grid-template-columns:10px 34px auto;font-size:10px}.compact-market-row b{font-size:10px}}
  `;document.head.appendChild(style);
}
function buildCompactStatus(){
  addCompactStyles();
  const sync=document.querySelector('header .sync');if(!sync)return false;
  if(sync.dataset.compactBuilt==='1')return true;
  const cloud=document.getElementById('cloudStatus');
  const cloudText=cloud?.textContent||'…';
  sync.classList.add('sync-compact');
  sync.innerHTML=`<div class="compact-market-stack">
    <button class="compact-market-row" id="kaspiStatusRow" type="button"><span id="dotKaspi" class="dot warn"></span><b>Kaspi</b><span id="lastSync" class="compact-market-time">—</span></button>
    <button class="compact-market-row" id="wb1StatusRow" type="button"><span id="dotWB1" class="dot off"></span><b>WB1</b><span id="wb1Sync" class="compact-market-time">—</span></button>
    <button class="compact-market-row" id="wb2StatusRow" type="button"><span id="dotWB2" class="dot off"></span><b>WB2</b><span id="wb2Sync" class="compact-market-time">—</span></button>
  </div><div class="compact-cloud"><span class="compact-cloud-label">Облако</span><span id="cloudStatus">${cloudText}</span></div><span id="dotWB" class="dot off" style="display:none"></span><span id="wbStockStatus" style="display:none">—</span>`;
  sync.dataset.compactBuilt='1';
  return true;
}
function fmt(ts){
  const value=Number(ts)||0;if(!value)return '—';const d=new Date(value),now=new Date(),time=d.toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'});
  const same=d.getFullYear()===now.getFullYear()&&d.getMonth()===now.getMonth()&&d.getDate()===now.getDate(),y=new Date(now);y.setDate(now.getDate()-1);
  const yesterday=d.getFullYear()===y.getFullYear()&&d.getMonth()===y.getMonth()&&d.getDate()===y.getDate();
  return same?time:yesterday?'вчера '+time:d.toLocaleDateString('ru-RU',{day:'2-digit',month:'2-digit'})+' '+time;
}
function health(name){
  const item=state?.settings?.serverMarketStatus?.[name]||{},last=Number(item.lastSuccessAt||0),latest=item.latest||null,age=last?Date.now()-last:Infinity;
  const failed=latest&&Number(latest.ok)!==1&&Number(latest.finished_at||0)>0&&Number(latest.started_at||0)>=last;
  if(failed)return {cls:'bad',label:'ошибка',last,latest};if(age<=10*60*1000)return {cls:'',label:'есть связь',last,latest};if(age<=30*60*1000)return {cls:'warn',label:'задержка',last,latest};if(last)return {cls:'bad',label:'нет свежей связи',last,latest};return {cls:'off',label:'нет данных',last,latest};
}
function paint(name,dotId,timeId){const h=health(name),dot=document.getElementById(dotId),time=document.getElementById(timeId);if(dot){dot.className='dot'+(h.cls?' '+h.cls:'');dot.title=(name==='WB'?'WB1':name)+': '+h.label}if(time)time.textContent=fmt(h.last);return h}
function compactCloudText(){const el=document.getElementById('cloudStatus');if(!el)return;const raw=String(el.textContent||'').trim().toLowerCase();let short='';if(/сохраня|отправля/.test(raw))short='сохранение…';else if(/подключ|сохранено|обновлено|сервер подключён/.test(raw))short='онлайн';else if(/последние данные/.test(raw))short='кэш';else if(/только просмотр/.test(raw))short='только просмотр';else if(/загружа|проверя/.test(raw))short='…';else if(/ошиб|нет связи|недоступ/.test(raw))short='ошибка';if(short&&el.textContent!==short)el.textContent=short}
function refresh(){if(!buildCompactStatus())return;paint('Kaspi','dotKaspi','lastSync');paint('WB','dotWB1','wb1Sync');paint('WB2','dotWB2','wb2Sync');compactCloudText()}
async function details(name){
  const label=name==='WB2'?'WB2':'WB1',h=health(name);let extra='';
  try{const r=await fetch(MILLIONER_API+'/api/wb-sync-status',{cache:'no-store',headers:{Accept:'application/json'}}),data=await r.json().catch(()=>({}));if(r.ok&&data?.ok){const latest=(data.latest||[]).find(x=>String(x.market)===name),newest=(data.newestOrders||[]).find(x=>String(x.market)===name);if(latest){extra+=`\nПоследняя попытка: ${Number(latest.ok)===1?'OK':'ОШИБКА'}`;if(latest.error)extra+=`\n${String(latest.error).slice(0,350)}`}if(newest?.newest_order_at)extra+=`\nПоследний заказ: ${fmt(newest.newest_order_at)}`}}catch{extra+='\nДиагностика недоступна'}
  alert(`${label}: ${h.label}\nПоследний успех: ${fmt(h.last)}${extra}`);
}
function bind(){if(!buildCompactStatus())return;const wb1=document.getElementById('wb1StatusRow'),wb2=document.getElementById('wb2StatusRow');if(wb1&&!wb1.dataset.bound){wb1.dataset.bound='1';wb1.addEventListener('click',()=>details('WB'))}if(wb2&&!wb2.dataset.bound){wb2.dataset.bound='1';wb2.addEventListener('click',()=>details('WB2'))}const cloud=document.getElementById('cloudStatus');if(cloud&&!cloud.dataset.compactObserver){cloud.dataset.compactObserver='1';new MutationObserver(compactCloudText).observe(cloud,{childList:true,characterData:true,subtree:true})}refresh()}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bind,{once:true});else bind();
window.addEventListener('load',()=>{bind();setTimeout(refresh,300);setTimeout(refresh,1200)});
setInterval(refresh,15000);
})();