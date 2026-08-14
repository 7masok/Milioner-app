(function(){
'use strict';
const CLOUD_V3_KEY=KEY+'_cloud_sync_v3_migrated';
const CLOUD_FIELDS=['products','movements','sales','purchases','kaspiAdExpenses'];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function coreSnapshot(src){
  src=src&&typeof src==='object'?src:{};
  const settings={...(src.settings||{})};
  for(const k of WAREHOUSE_VOLATILE_SETTINGS)delete settings[k];
  return {
    products:Array.isArray(src.products)?src.products:[],
    movements:Array.isArray(src.movements)?src.movements.filter(m=>!['резерв','отмена резерва'].includes(String(m?.type||''))):[],
    sales:Array.isArray(src.sales)?src.sales:[],
    purchases:Array.isArray(src.purchases)?src.purchases:[],
    kaspiAdExpenses:Array.isArray(src.kaspiAdExpenses)?src.kaspiAdExpenses:[],
    settings,
    marketplaceLiveSince:src.marketplaceLiveSince&&typeof src.marketplaceLiveSince==='object'?src.marketplaceLiveSince:{},
    kaspiBaselineAt:src.kaspiBaselineAt||null
  };
}
function coreText(x){return JSON.stringify(coreSnapshot(x));}
function coreHasData(x){x=coreSnapshot(x);return !!(x.products.length+x.movements.length+x.sales.length+x.purchases.length+x.kaspiAdExpenses.length)}
function mergeCore(base,remote,local,remoteUpdated=0,localUpdated=0){return coreSnapshot(mergeWarehouseSnapshots(coreSnapshot(base),coreSnapshot(remote),coreSnapshot(local),remoteUpdated,localUpdated))}
function mergeDirtyPreferLocal(remote,local){
  remote=coreSnapshot(remote);local=coreSnapshot(local);const out=coreSnapshot(remote);
  for(const field of CLOUD_FIELDS){const map=new Map((out[field]||[]).map(x=>[warehouseKey(field,x),x]).filter(x=>x[0]));for(const x of(local[field]||[])){const k=warehouseKey(field,x);if(k)map.set(k,x)}out[field]=[...map.values()]}
  out.settings={...(remote.settings||{}),...(local.settings||{})};
  out.marketplaceLiveSince={...(remote.marketplaceLiveSince||{}),...(local.marketplaceLiveSince||{})};
  const times=[Number(remote.kaspiBaselineAt||0),Number(local.kaspiBaselineAt||0)].filter(Boolean);out.kaspiBaselineAt=times.length?Math.min(...times):null;
  return out;
}
function mergeUniquePreferRemote(remote,local){
  remote=coreSnapshot(remote);local=coreSnapshot(local);const out=coreSnapshot(remote);
  for(const field of CLOUD_FIELDS){const seen=new Set((out[field]||[]).map(x=>warehouseKey(field,x)).filter(Boolean));for(const x of(local[field]||[])){const k=warehouseKey(field,x);if(k&&!seen.has(k)){out[field].push(x);seen.add(k)}}}
  out.settings={...(local.settings||{}),...(remote.settings||{})};
  out.marketplaceLiveSince={...(local.marketplaceLiveSince||{}),...(remote.marketplaceLiveSince||{})};
  const times=[Number(remote.kaspiBaselineAt||0),Number(local.kaspiBaselineAt||0)].filter(Boolean);out.kaspiBaselineAt=times.length?Math.min(...times):null;
  return out;
}

warehouseSnapshot=function(){return coreSnapshot(state)};
applyWarehouseSnapshot=function(remote){
  const snap=coreSnapshot(remote),feeds={kaspiOrderFeed:state.kaspiOrderFeed||[],wbOrderFeed:state.wbOrderFeed||[],ozonOrderFeed:state.ozonOrderFeed||[],kaspiOrders:state.kaspiOrders||{}},derived={reservations:state.reservations||[],marketOrderState:state.marketOrderState||{}},localSettings={...(state.settings||{})};
  state={...state,...snap,...feeds,...derived};
  state.settings={...snap.settings,...localSettings};
  state.purchases.forEach(x=>{x.status=['to_forwarder','to_me','at_warehouse','received'].includes(String(x.status||''))?String(x.status):'received';if(x.status==='received'){x.receivedAt=Number(x.receivedAt||x.date)||Date.now();x.remainingQty=Number.isFinite(Number(x.remainingQty))?Math.max(0,Number(x.remainingQty)):Math.max(0,Number(x.qty)||0);x.landedUnitCost=Number(x.landedUnitCost)||((Number(x.unitCost)||0)+((Number(x.delivery)||0)/(Math.max(1,Number(x.qty)||1))))}else{x.receivedAt=Number(x.receivedAt)||0;x.remainingQty=0;x.landedUnitCost=Number(x.landedUnitCost)||0}});
  warehouseLastObservedSnapshot=normalizeWarehouseSnapshot({...snap,reservations:state.reservations,marketOrderState:state.marketOrderState});
};

async function fetchCloudJson(meta=false,retries=3){
  let last=null;
  for(let i=0;i<retries;i++){
    const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),meta?12000:35000);
    try{
      const r=await fetch(MILLIONER_API+'/api/warehouse-state'+(meta?'?meta=1':''),{cache:'no-store',signal:ctrl.signal});
      let data={};try{data=await r.json()}catch{}
      if(!r.ok||data.ok===false)throw new Error(data.error||('HTTP '+r.status));
      clearTimeout(timer);return data;
    }catch(e){clearTimeout(timer);last=e;if(i+1<retries)await sleep(1200*(i+1));}
  }
  throw last||new Error('Облако не отвечает');
}
fetchWarehouseCloud=async function(){return fetchCloudJson(false,3)};

scheduleWarehouseSave=function(delay=700){
  if(!warehouseRemoteReady)return;
  clearTimeout(warehouseSaveTimer);
  warehouseSaveTimer=setTimeout(()=>pushWarehouseToD1().catch(e=>{console.warn('D1 warehouse save failed',e);cloudStatus('подключено · повтор сохранения','warn');if(warehouseLocalDirty)setTimeout(()=>scheduleWarehouseSave(0),5000)}),delay);
};
save=function(){
  stampChangedWarehouseEntities();state.settings.localWarehouseUpdatedAt=Date.now();saveLocalOnly();
  const snap=coreSnapshot(state),text=JSON.stringify(snap);warehouseLastObservedSnapshot=normalizeWarehouseSnapshot({...snap,reservations:state.reservations,marketOrderState:state.marketOrderState});
  if(text!==warehouseLastSyncedText){markWarehouseDirty();scheduleWarehouseSave();}
};

pushWarehouseToD1=async function(){
  if(!warehouseRemoteReady||warehouseSaveInFlight||!warehouseLocalDirty)return false;
  warehouseSaveInFlight=true;cloudStatus('сохраняю…','warn');
  try{
    for(let attempt=0;attempt<4;attempt++){
      const localSnap=coreSnapshot(state),sentText=JSON.stringify(localSnap);
      let r,data={};
      try{
        const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),35000);
        r=await fetch(MILLIONER_API+'/api/warehouse-state',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({baseRevision:warehouseRemoteRevision,state:localSnap}),signal:ctrl.signal});
        clearTimeout(timer);try{data=await r.json()}catch{}
      }catch(e){if(attempt<3){await sleep(1500*(attempt+1));continue}throw e}
      if(r.status===409){
        const remoteData=await fetchCloudJson(false,3),remoteSnap=coreSnapshot(remoteData.state),merged=mergeCore(warehouseLastCloudSnapshot,remoteSnap,localSnap,Number(remoteData.updatedAt||0),Number(state.settings.localWarehouseUpdatedAt||Date.now()));
        warehouseRemoteRevision=Number(remoteData.revision||0);warehouseRemoteUpdatedAt=Number(remoteData.updatedAt||0);warehouseLastCloudSnapshot=remoteSnap;warehouseLastSyncedText=coreText(remoteSnap);applyWarehouseSnapshot(merged);saveLocalOnly();markWarehouseDirty();continue;
      }
      if(!r.ok||data.ok===false)throw new Error(data.error||('HTTP '+r.status));
      warehouseRemoteRevision=Number(data.revision||warehouseRemoteRevision);warehouseRemoteUpdatedAt=Number(data.updatedAt||Date.now());warehouseLastCloudSnapshot=localSnap;warehouseLastSyncedText=sentText;
      state.settings.d1WarehouseRevision=warehouseRemoteRevision;state.settings.d1WarehouseUpdatedAt=warehouseRemoteUpdatedAt;state.settings.d1MigratedAt=state.settings.d1MigratedAt||Date.now();saveLocalOnly();
      if(coreText(state)===sentText){clearWarehouseDirty();cloudStatus('синхронизировано','ok')}else{markWarehouseDirty();scheduleWarehouseSave(100)}
      return true;
    }
    throw new Error('Не удалось разрешить конфликт версий');
  }finally{warehouseSaveInFlight=false;}
};

pullWarehouseFromD1=async function({force=false}={}){
  if(warehousePullInFlight||warehouseSaveInFlight)return false;
  if(!navigator.onLine){cloudStatus('нет сети · локальная копия','warn');return false;}
  warehousePullInFlight=true;if(force)cloudStatus('проверяю…','warn');
  try{
    const meta=await fetchCloudJson(true,2);
    if(!meta.exists){warehouseRemoteRevision=0;warehouseRemoteUpdatedAt=0;warehouseRemoteReady=true;warehouseLastCloudSnapshot=coreSnapshot({});warehouseLastSyncedText=coreText({});markWarehouseDirty();scheduleWarehouseSave(0);return true;}
    const remoteRevision=Number(meta.revision||0),remoteUpdated=Number(meta.updatedAt||0),needFull=!warehouseRemoteReady||remoteRevision>warehouseRemoteRevision;
    if(needFull){
      const data=await fetchCloudJson(false,3),remoteSnap=coreSnapshot(data.state),rev=Number(data.revision||remoteRevision),upd=Number(data.updatedAt||remoteUpdated);
      if(warehouseLocalDirty){const merged=mergeCore(warehouseLastCloudSnapshot,remoteSnap,coreSnapshot(state),upd,Number(state.settings.localWarehouseUpdatedAt||0));warehouseRemoteRevision=rev;warehouseRemoteUpdatedAt=upd;warehouseRemoteReady=true;warehouseLastCloudSnapshot=remoteSnap;warehouseLastSyncedText=coreText(remoteSnap);applyWarehouseSnapshot(merged);saveLocalOnly();markWarehouseDirty();scheduleWarehouseSave(0);render();}
      else{warehouseRemoteRevision=rev;warehouseRemoteUpdatedAt=upd;warehouseRemoteReady=true;warehouseLastCloudSnapshot=remoteSnap;warehouseLastSyncedText=coreText(remoteSnap);applyWarehouseSnapshot(remoteSnap);clearWarehouseDirty();state.settings.d1WarehouseRevision=rev;state.settings.d1WarehouseUpdatedAt=upd;saveLocalOnly();render();cloudStatus('синхронизировано','ok');}
    }else if(warehouseLocalDirty){scheduleWarehouseSave(0);cloudStatus('подключено · сохраняю изменения','warn');}
    else cloudStatus('синхронизировано','ok');
    return true;
  }catch(e){console.warn('D1 warehouse pull failed',e);cloudStatus(warehouseRemoteReady?'временная ошибка связи':'нет связи с облаком','warn');return false;}
  finally{warehousePullInFlight=false;}
};

bootstrapWarehouseD1=async function(){
  const rawLocal=localStorage.getItem(KEY);if(rawLocal&&!localStorage.getItem(KEY+'_pre_d1'))localStorage.setItem(KEY+'_pre_d1',rawLocal);if(rawLocal&&!localStorage.getItem(KEY+'_pre_cloud_v3'))localStorage.setItem(KEY+'_pre_cloud_v3',rawLocal);
  const localSnap=coreSnapshot(state),localUpdated=Number(state.settings.localWarehouseUpdatedAt||0);cloudStatus('подключение…','warn');
  try{
    const data=await fetchCloudJson(false,3);warehouseRemoteRevision=Number(data.revision||0);warehouseRemoteUpdatedAt=Number(data.updatedAt||0);warehouseRemoteReady=true;
    if(!data.exists){warehouseLastCloudSnapshot=coreSnapshot({});warehouseLastSyncedText=coreText({});markWarehouseDirty();localStorage.setItem(CLOUD_V3_KEY,'1');cloudStatus('подключено · сохраняю данные','warn');scheduleWarehouseSave(0);return {mode:'uploaded-local'};}
    const remoteSnap=coreSnapshot(data.state),remoteText=coreText(remoteSnap);warehouseLastCloudSnapshot=remoteSnap;warehouseLastSyncedText=remoteText;
    const firstV3=localStorage.getItem(CLOUD_V3_KEY)!=='1';let chosen=remoteSnap;
    if(warehouseLocalDirty)chosen=mergeDirtyPreferLocal(remoteSnap,localSnap);
    else if(firstV3&&coreHasData(localSnap))chosen=mergeUniquePreferRemote(remoteSnap,localSnap);
    applyWarehouseSnapshot(chosen);saveLocalOnly();localStorage.setItem(CLOUD_V3_KEY,'1');
    if(coreText(chosen)!==remoteText){markWarehouseDirty();cloudStatus('подключено · сохраняю изменения','warn');scheduleWarehouseSave(0)}else{clearWarehouseDirty();cloudStatus('синхронизировано','ok')}
    state.settings.d1WarehouseRevision=warehouseRemoteRevision;state.settings.d1WarehouseUpdatedAt=warehouseRemoteUpdatedAt;state.settings.d1MigratedAt=state.settings.d1MigratedAt||Date.now();saveLocalOnly();render();return {mode:'loaded-d1-v3'};
  }catch(e){warehouseRemoteReady=false;console.warn('D1 warehouse bootstrap failed; keeping local data',e);cloudStatus('нет связи с облаком · локальная копия','warn');return {mode:'local-fallback',error:String(e.message||e)}}
};

startWarehouseCloudWatcher=function(){
  if(warehouseWatchStarted)return;warehouseWatchStarted=true;
  setInterval(()=>pullWarehouseFromD1(),15000);
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')pullWarehouseFromD1({force:true})});
  window.addEventListener('focus',()=>pullWarehouseFromD1({force:true}));window.addEventListener('online',()=>pullWarehouseFromD1({force:true}));
};
})();
