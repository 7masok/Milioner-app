(function(){
'use strict';

function installPurchaseArrivalSort(){
  const select=document.getElementById('purchaseSort');
  if(!select||select.querySelector('option[value="arrival"]'))return;
  const option=document.createElement('option');
  option.value='arrival';
  option.textContent='По дате поступления на склад';
  select.appendChild(option);
}

purchaseSortChanged=function(){
  const value=document.getElementById('purchaseSort')?.value;
  purchaseSortMode=['date','stage','arrival'].includes(value)?value:'date';
  purchasePage=1;
  renderPurchases({listOnly:true});
};

sortPurchaseGroups=function(groups){
  const direction=purchaseSortDirection==='asc'?1:-1,workflow=purchaseWorkflow();
  return [...groups].sort((a,b)=>{
    if(purchaseSortMode==='stage'){
      const ai=workflow.findIndex(x=>x.id===purchaseWorkflowStage(a.rows[0]));
      const bi=workflow.findIndex(x=>x.id===purchaseWorkflowStage(b.rows[0]));
      const stage=(ai-bi)*direction;
      if(stage)return stage;
    }
    if(purchaseSortMode==='arrival'){
      const ad=Number(a.receivedAt||a.warehouseReceivedAt)||0;
      const bd=Number(b.receivedAt||b.warehouseReceivedAt)||0;
      const arrival=(ad-bd)*direction;
      if(arrival)return arrival;
    }
    const ad=Number(a.orderedAt)||0,bd=Number(b.orderedAt)||0;
    return (ad-bd)*direction;
  });
};

let ozonLastFullSync=0;
function ozonFullSyncFromPayload(payload){
  let latest=0;
  for(const account of payload?.accounts||[]){
    const stamps=['postings','stocks','finance','supplies'].map(key=>Number(account?.[key]?.updatedAt)||0);
    if(stamps.every(Boolean))latest=Math.max(latest,Math.min(...stamps));
  }
  return latest;
}
function paintOzonSyncTime(){
  if(!ozonLastFullSync)return;
  const el=document.getElementById('ozonTopStatus');
  if(!el)return;
  el.textContent=new Date(ozonLastFullSync).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'});
}
async function refreshOzonSyncTime(){
  try{
    const payload=await apiJson(MILLIONER_API+'/api/ozon-fbo');
    const stamp=ozonFullSyncFromPayload(payload);
    if(stamp)ozonLastFullSync=stamp;
    paintOzonSyncTime();
  }catch{}
}
function installOzonSyncTime(){
  setTimeout(refreshOzonSyncTime,2500);
  setInterval(paintOzonSyncTime,2000);
  setInterval(refreshOzonSyncTime,10*60*1000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshOzonSyncTime();});
  window.addEventListener('focus',refreshOzonSyncTime);
}

if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>{installPurchaseArrivalSort();installOzonSyncTime();},{once:true});
else{installPurchaseArrivalSort();installOzonSyncTime();}
window.addEventListener('load',installPurchaseArrivalSort,{once:true});
})();
