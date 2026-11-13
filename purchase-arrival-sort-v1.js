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

createArrival=function(){
  if(!requireWarehouseEditReady())return;
  if(document.getElementById('arrivalBuyTotal')?.dataset?.pendingTotal==='1'){
    return alert('Распределите общую сумму по количеству или отмените её.');
  }
  const rows=arrivalDraftRows().filter(row=>row.productId||row.qty||row.buy);
  if(!rows.length||rows.some(row=>!prod(row.productId)||!Number.isSafeInteger(row.qty)||row.qty<=0||!Number.isFinite(row.buy)||row.buy<0)){
    return alert('Выберите товар и укажите количество и сумму по каждой позиции.');
  }
  if(new Set(rows.map(row=>row.productId)).size!==rows.length)return alert('Объедините одинаковые товары в одну строку.');
  const date=localDateStart(document.getElementById('ar')?.value);
  const delivery=Number(document.getElementById('ad')?.value||0);
  if(!(date>0)||!Number.isFinite(delivery)||delivery<0)return alert('Проверьте дату и стоимость доставки.');
  const batch=document.getElementById('ab')?.value||'',shipmentId='ship-'+id(),now=Date.now();
  const totalBuy=rows.reduce((sum,row)=>sum+row.buy,0);
  const totalQty=rows.reduce((sum,row)=>sum+row.qty,0);
  for(const row of rows){
    const unitCost=row.buy/row.qty;
    const deliveryShare=delivery*(totalBuy>0?row.buy/totalBuy:row.qty/totalQty);
    state.purchases.unshift({
      id:id(),shipmentId,status:'at_warehouse',productId:row.productId,qty:row.qty,remainingQty:0,
      receiptRecordedAt:now,warehouseReceivedAt:date,receivedAt:0,orderedAt:date,date:now,batch,
      buyTotal:row.buy,unitCost,delivery:deliveryShare,landedUnitCost:(row.buy+deliveryShare)/row.qty,
      shipmentPurchaseTotal:totalBuy,shipmentDeliveryTotal:delivery
    });
  }
  save();closeModal();render();
};

function canReturnArrivalToWarehouse(rows){
  if(!rows.length||rows.some(row=>row.status!=='received'||!Number.isSafeInteger(row.qty)||row.qty<=0
    ||row.remainingQty!==row.qty||row.warehouseWrittenOffQty||row.returnAdjustment||row.relocation||row.inventoryAdjustment))return false;
  const ids=new Set(rows.map(row=>String(row.id))),latestArrival=new Map();
  for(const row of rows){
    const arrival=Number(row.receiptRecordedAt||0);
    latestArrival.set(String(row.productId),Math.min(latestArrival.get(String(row.productId))??Infinity,arrival));
  }
  const usesLot=lots=>(Array.isArray(lots)?lots:[]).some(lot=>lot&&(ids.has(String(lot.purchaseId))||usesLot(lot.lots)));
  if((state.sales||[]).some(row=>usesLot(row.fifoLots))||(state.movements||[]).some(row=>usesLot(row.fifoLots)))return false;
  const needed=new Map();
  for(const row of rows)needed.set(row.productId,(needed.get(row.productId)||0)+row.qty);
  return [...needed].every(([pid,qty])=>{
    const product=prod(pid);
    if(!product||productAvailableStock(product)<qty)return false;
    const arrival=latestArrival.get(String(pid));
    const noLaterDebits=arrival>0&&!(state.movements||[]).some(row=>String(row.productId)===String(pid)
      &&Number(row.date)>=arrival&&Number(row.qty)<0);
    return noLaterDebits||fifoLots(pid).reduce((sum,lot)=>sum+Number(lot.remainingQty||0),0)===Number(product.stock);
  });
}

window.returnArrivalToWarehouse=function(key){
  if(!requireWarehouseEditReady())return;
  const rows=purchaseShipmentRows(key);
  if(!canReturnArrivalToWarehouse(rows))return alert('Проверьте свободный остаток. Переместить можно только целую неиспользованную поставку.');
  if(!confirm('Переместить эту поставку из продажи на склад?'))return;
  for(const row of rows){
    const product=prod(row.productId);
    product.stock-=row.qty;
    row.status='at_warehouse';
    row.warehouseReceivedAt=row.warehouseReceivedAt||row.receivedAt||Date.now();
    row.receivedAt=0;
    row.remainingQty=0;
    const movement=log('снятие с продажи',product.id,-row.qty,'Поставка на склад');
    movement.shipmentId=row.shipmentId||row.id;
    refreshProductAverageCost(product);
  }
  save();closeModal();render();
};

const editPurchaseShipment=openEditPurchaseShipment;
openEditPurchaseShipment=function(key,...args){
  const result=editPurchaseShipment(key,...args);
  const sheet=document.getElementById('sheet');
  const totalActions=sheet?.querySelector('#editPorBuyTotalActions, #correctPorBuyTotalActions');
  const distribute=totalActions?.querySelector('button[onclick^="applyPurchaseGrandTotal("]');
  if(distribute)totalActions.before(distribute);
  const remove=sheet?.querySelector('button[onclick^="deletePurchaseShipment("]');
  if(remove&&canReturnArrivalToWarehouse(purchaseShipmentRows(key))){
    const button=document.createElement('button');
    button.type='button';
    button.className='btn full';
    button.textContent='Переместить на склад';
    button.onclick=()=>window.returnArrivalToWarehouse(key);
    remove.after(button);
  }
  return result;
};

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
