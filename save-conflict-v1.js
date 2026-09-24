(function(){
'use strict';

if(typeof normalizeWarehouseSnapshot!=='function'||typeof mergeWarehouseSnapshots!=='function')return;

function warehouseChangedWire(sentSnap){
  const base=normalizeWarehouseSnapshot(warehouseLastCloudSnapshot||{});
  if(!warehouseLastCloudSnapshot)return {patch:false,state:sentSnap};
  const fields=['products','movements','sales','purchases','reservations','kaspiAdExpenses'];
  const patch={deleted:{}};
  let changedRows=0;
  for(const field of fields){
    const oldMap=new Map((base[field]||[]).map(row=>[warehouseKey(field,row),row]).filter(entry=>entry[0]));
    const nextMap=new Map((sentSnap[field]||[]).map(row=>[warehouseKey(field,row),row]).filter(entry=>entry[0]));
    const upserts=[];
    const removed=[];
    for(const [key,row] of nextMap){
      const old=oldMap.get(key);
      if(!old||!jsonSame(stripSyncStamp(old),stripSyncStamp(row)))upserts.push(row);
    }
    for(const key of oldMap.keys())if(!nextMap.has(key))removed.push(key);
    if(upserts.length)patch[field]=upserts;
    if(removed.length)patch.deleted[field]=removed;
    changedRows+=upserts.length+removed.length;
  }
  if(!jsonSame(base.settings||{},sentSnap.settings||{}))patch.settings=sentSnap.settings||{};
  if((base.kaspiBaselineAt||null)!==(sentSnap.kaspiBaselineAt||null))patch.kaspiBaselineAt=sentSnap.kaspiBaselineAt||null;
  if(!Object.keys(patch.deleted).length)delete patch.deleted;
  const described=Object.keys(patch).length>0;
  if(!described)return {patch:false,state:sentSnap};
  const totalRows=fields.reduce((sum,field)=>sum+((sentSnap[field]||[]).length),0);
  if(totalRows>0&&changedRows>Math.max(80,Math.floor(totalRows*0.6)))return {patch:false,state:sentSnap};
  return {patch:true,state:patch};
}

pushWarehouseToServer=async function(){
  if(!warehouseRemoteReady||warehouseSaveInFlight||!warehouseLocalDirty)return false;
  warehouseSaveInFlight=true;
  cloudStatus('сохраняю…','warn');
  try{
    const sentSnap=normalizeWarehouseSnapshot(warehouseSnapshot());
    const sentText=JSON.stringify(sentSnap);
    const wire=warehouseChangedWire(sentSnap);
    const response=await fetch(MILLIONER_API+'/api/warehouse-state',{
      method:'PUT',
      headers:{'Content-Type':'application/json',Accept:'application/json'},
      body:JSON.stringify({baseRevision:warehouseRemoteRevision,patch:wire.patch,state:wire.state})
    });
    let data={};
    try{data=await response.json()}catch{}

    if(response.status===409){
      // Keep every edit that exists locally at conflict time. Merge it against
      // the last common snapshot and the newest server snapshot, then retry.
      const localNow=normalizeWarehouseSnapshot(warehouseSnapshot());
      const remoteData=await fetchWarehouseCloud();
      const remoteSnap=normalizeWarehouseSnapshot(remoteData.state);
      const baseSnap=normalizeWarehouseSnapshot(warehouseLastCloudSnapshot||{});
      const mergedSnap=mergeWarehouseSnapshots(
        baseSnap,
        remoteSnap,
        localNow,
        Number(remoteData.updatedAt||0),
        Date.now()
      );
      warehouseRemoteRevision=Number(remoteData.revision||0);
      warehouseRemoteUpdatedAt=Number(remoteData.updatedAt||0);
      warehouseLastCloudSnapshot=remoteSnap;
      warehouseLastSyncedText=JSON.stringify(remoteSnap);
      applyWarehouseSnapshot(mergedSnap);
      markWarehouseDirty();
      render();
      cloudStatus('конфликт объединён · сохраняю…','warn');
      scheduleWarehouseSave(80);
      return false;
    }

    if(!response.ok||data.ok===false){
      const error=new Error(data.error||('HTTP '+response.status));
      error.status=response.status;
      throw error;
    }

    warehouseRemoteRevision=Number(data.revision||warehouseRemoteRevision);
    warehouseRemoteUpdatedAt=Number(data.updatedAt||Date.now());
    warehouseLastCloudSnapshot=sentSnap;
    warehouseLastSyncedText=sentText;
    const currentText=JSON.stringify(normalizeWarehouseSnapshot(warehouseSnapshot()));
    if(currentText===sentText){
      clearWarehouseDirty();
      cloudStatus('сохранено на сервере','ok');
      if(typeof triggerImmediateWbStockSync==='function')setTimeout(()=>triggerImmediateWbStockSync(),50);
    }else{
      markWarehouseDirty();
      scheduleWarehouseSave(100);
    }
    return true;
  }catch(error){
    console.error('safe warehouse save failed',error);
    markWarehouseDirty();
    if(Number(error?.status)===413){
      cloudStatus('склад слишком большой · требуется обновление','bad');
      return false;
    }
    cloudStatus('изменения не сохранены · повторяю','warn');
    setTimeout(()=>scheduleWarehouseSave(0),2000);
    return false;
  }finally{
    warehouseSaveInFlight=false;
  }
};

// Marketplace modules are loaded before owner authentication finishes. Their
// first protected requests can therefore return 401. Repair only after the
// authenticated app is ready; do not restart auth and do not observe the DOM.
let marketplaceUiRepairInstalled=false;
function ensureOzonReportTab(){
  const tabs=document.getElementById('reportMarketTabs');
  if(!tabs||tabs.querySelector('[data-report-market="Ozon"]'))return;
  tabs.insertAdjacentHTML('beforeend','<button class="market-tab" data-report-market="Ozon" onclick="setReportMarket(\'Ozon\')">Ozon</button>');
}
function ensureOzonCompactRow(){
  const stack=document.querySelector('.compact-market-stack');
  if(!stack||document.getElementById('ozonStatusRow'))return;
  stack.insertAdjacentHTML('beforeend','<button class="compact-market-row" id="ozonStatusRow" type="button"><span id="dotOzonTop" class="dot warn"></span><b>Ozon</b><span id="ozonTopStatus" class="compact-market-time">…</span></button>');
}
async function refreshOzonCompactStatus(){
  ensureOzonCompactRow();
  const dot=document.getElementById('dotOzonTop'),status=document.getElementById('ozonTopStatus');
  if(!dot||!status)return;
  // ozon-fbo-v1 owns the canonical browser cache and already refreshes the
  // header indicator. Do not issue a second protected /api/ozon-fbo request.
  if(typeof window.ozonFboRefreshStatus==='function'){
    try{return await window.ozonFboRefreshStatus()}catch{}
  }
  try{
    const response=await fetch(MILLIONER_API+'/api/ozon-fbo',{cache:'no-store',headers:{Accept:'application/json'}});
    if(!response.ok)throw new Error('HTTP '+response.status);
    const payload=await response.json().catch(()=>({}));
    if(!payload?.configured){dot.className='dot off';status.textContent='не подключён';return;}
    if(payload?.syncing){dot.className='dot warn';status.textContent='синхронизация…';return;}
    if((payload?.accounts||[]).length){dot.className='dot';status.textContent='работает';return;}
    dot.className='dot warn';status.textContent='ожидает';
  }catch{
    dot.className='dot bad';status.textContent='ошибка';
  }
}
function repairMarketplaceUi(){
  if(!document.body?.classList.contains('auth-ready'))return false;
  ensureOzonReportTab();
  ensureOzonCompactRow();
  if(document.getElementById('reports')?.classList.contains('active')){
    setTimeout(()=>{try{window.renderReports?.()}catch(error){console.warn('Report retry after auth failed',error)}},120);
  }
  return true;
}
function installMarketplaceUiRepair(){
  if(marketplaceUiRepairInstalled)return;
  marketplaceUiRepairInstalled=true;
  if(typeof window.setReportChrome==='function'){
    const baseSetReportChrome=window.setReportChrome;
    window.setReportChrome=function(){
      const result=baseSetReportChrome.apply(this,arguments);
      ensureOzonReportTab();
      return result;
    };
  }
  let attempts=0;
  const timer=setInterval(()=>{
    attempts++;
    if(repairMarketplaceUi()||attempts>=40)clearInterval(timer);
  },250);
  [600,1500,3500].forEach(ms=>setTimeout(()=>{if(document.body?.classList.contains('auth-ready'))repairMarketplaceUi()},ms));
  window.addEventListener('focus',()=>{if(document.body?.classList.contains('auth-ready'))repairMarketplaceUi()});
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',installMarketplaceUiRepair,{once:true});
else installMarketplaceUiRepair();
})();
