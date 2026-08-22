(function(){
'use strict';

if(typeof normalizeWarehouseSnapshot!=='function'||typeof mergeWarehouseSnapshots!=='function')return;

pushWarehouseToServer=async function(){
  if(!warehouseRemoteReady||warehouseSaveInFlight||!warehouseLocalDirty)return false;
  warehouseSaveInFlight=true;
  cloudStatus('сохраняю…','warn');
  try{
    const sentSnap=normalizeWarehouseSnapshot(warehouseSnapshot());
    const sentText=JSON.stringify(sentSnap);
    const response=await fetch(MILLIONER_API+'/api/warehouse-state',{
      method:'PUT',
      headers:{'Content-Type':'application/json',Accept:'application/json'},
      body:JSON.stringify({baseRevision:warehouseRemoteRevision,state:sentSnap})
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

    if(!response.ok||data.ok===false)throw new Error(data.error||('HTTP '+response.status));

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
    cloudStatus('изменения не сохранены · повторяю','warn');
    setTimeout(()=>scheduleWarehouseSave(0),2000);
    return false;
  }finally{
    warehouseSaveInFlight=false;
  }
};
})();