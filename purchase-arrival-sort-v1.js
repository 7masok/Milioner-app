(function(){
'use strict';

let shipmentNumbers=new Map();
window.setPurchaseShipmentNumbers=function(values){
  if(!values||typeof values!=='object')return false;
  const next=new Map(Object.entries(values));
  const changed=next.size!==shipmentNumbers.size||[...next].some(([key,value])=>shipmentNumbers.get(key)!==value);
  shipmentNumbers=next;
  return changed;
};
window.purchaseShipmentNumber=function(key){
  const number=shipmentNumbers.get(String(key));
  return Number.isSafeInteger(number)&&number>=101?String(number):'';
};
const shipmentDate=new Intl.DateTimeFormat('ru-RU',{
  timeZone:'Asia/Almaty',day:'2-digit',month:'2-digit',year:'numeric'
});
window.purchaseShipmentHeading=function(key,orderedAt,fallback='Поставка'){
  const number=window.purchaseShipmentNumber(key);
  const date=Number(orderedAt);
  const title=date>0&&Number.isFinite(new Date(date).getTime())?shipmentDate.format(date):fallback;
  return number?'№ '+number+' · '+title:title;
};

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

if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',installPurchaseArrivalSort,{once:true});
else installPurchaseArrivalSort();
window.addEventListener('load',installPurchaseArrivalSort,{once:true});
})();
