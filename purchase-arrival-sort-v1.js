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

if(typeof openCorrectReceivedPurchaseShipment==='function'){
  const correctShipment=openCorrectReceivedPurchaseShipment;
  openCorrectReceivedPurchaseShipment=function(key,...args){
    const result=correctShipment(key,...args);
    const sheet=document.getElementById('sheet');
    if(!sheet?.querySelector('#correctPorBuyTotal'))return result;
    groupPurchaseCorrectionRows(sheet,purchaseShipmentRows(key));
    return result;
  };
}

function groupPurchaseCorrectionRows(sheet,rows){
  const byId=new Map(rows.map(row=>[String(row.id),row])),groups=new Map();
  for(const element of sheet.querySelectorAll('.correct-purchase-row')){
    const row=byId.get(element.dataset.id);
    if(!row||!row.productId)continue;
    const productId=String(row.productId);
    if(!groups.has(productId))groups.set(productId,[]);
    groups.get(productId).push({row,element});
    const price=element.querySelector('.correct-purchase-unit');
    if(price&&price.value!==''){
      const unit=Number(price.value),rounded=Math.round(unit*100)/100;
      if(Number.isFinite(unit)&&Math.abs(unit-rounded)<=1e-9)price.value=String(rounded);
    }
  }
  for(const [productId,parts] of groups){
    if(parts.length<2)continue;
    const total=parts.reduce((sum,{row})=>sum+(Number(row.qty)||0),0);
    const departed=parts.reduce((sum,{row})=>purchaseStatus(row)==='received'
      ?sum+Math.max(0,(Number(row.qty)||0)-(Number(row.remainingQty)||0)):sum,0);
    const warehouse=parts.reduce((sum,{row})=>sum+purchaseWarehouseQty(row),0);
    const details=document.createElement('details'),summary=document.createElement('summary');
    details.className='item';
    details.style.marginBottom='9px';
    summary.style.cursor='pointer';
    const title=document.createElement('b');
    title.textContent=productNameById(productId,'Товар')+' · '+total+' шт.';
    const note=document.createElement('span');
    note.className='muted';
    note.style.display='block';
    note.textContent=[departed?'Выбыло '+departed+' шт.':'',warehouse?'На складе '+warehouse+' шт.':'','Показать части партии ('+parts.length+')'].filter(Boolean).join(' · ');
    summary.append(title,note);
    details.append(summary);
    parts[0].element.before(details);
    for(const {element} of parts)details.append(element);
  }
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

if(typeof inventoryForm==='function'){
  const baseInventoryForm=inventoryForm,baseSizeForm=sizeInventoryForm,baseSync=syncInventoryFields,baseCount=applyInventoryCount,baseSave=doInventory;
  const editableMovement=movementIsStockAdjustment;
  let countScope='sale',loadedCount=null;
  function warehouseCountLots(p){
    return (state.purchases||[]).filter(lot=>String(lot.productId)===String(p.id)&&purchaseWarehouseQty(lot)>0)
      .sort((a,b)=>Number(a.warehouseReceivedAt||a.date||0)-Number(b.warehouseReceivedAt||b.date||0));
  }
  function reservedWarehouseLots(){
    const lots=new Map();
    for(const r of state.reservations||[]){
      if(r.active!==true||r.source!=='FBO')continue;
      for(const entry of r.warehouseLots||[]){
        const key=String(entry.purchaseId);
        lots.set(key,(lots.get(key)||0)+(Number(entry.qty)||0));
      }
    }
    return lots;
  }
  function warehouseCountFields(p){
    const lots=warehouseCountLots(p),reservedLots=reservedWarehouseLots();
    const total=lots.reduce((n,lot)=>n+purchaseWarehouseQty(lot),0);
    const reserved=lots.reduce((n,lot)=>n+(reservedLots.get(String(lot.id))||0),0);
    const cost=total?lots.reduce((n,lot)=>n+purchaseWarehouseQty(lot)*purchaseDisplayUnitCost(lot),0)/total:Number(p.cost)||0;
    return {total,reserved,cost:Math.round(Math.max(0,cost)*100)/100};
  }
  function scopeField(){
    return '<div class="field"><label for="inventoryCountScope">Где пересчитать</label><select id="inventoryCountScope" onchange="changeInventoryCountScope(this.value)"><option value="sale" '+(countScope==='sale'?'selected':'')+'>В продаже</option><option value="at_warehouse" '+(countScope==='at_warehouse'?'selected':'')+'>На складе</option></select></div>';
  }
  function warehouseCountSignature(p){
    const lots=warehouseCountLots(p),reservedLots=reservedWarehouseLots();
    return JSON.stringify(lots.map(lot=>[lot.id,purchaseWarehouseQty(lot),reservedLots.get(String(lot.id))||0,purchaseDisplayUnitCost(lot)]));
  }
  function applyWarehouseCount(p,actual,unit){
    const {total,reserved}=warehouseCountFields(p),delta=actual-total;
    if(!delta)return;
    if(delta<0&&actual<reserved)throw Error('На складе зарезервировано для FBO '+reserved+' шт. Сначала освободите резерв для недостающего товара.');
    if(!Number.isFinite(actual*unit))throw Error('Проверьте себестоимость.');
    const used=[],now=Date.now();
    if(delta<0){
      let need=-delta;
      const reservedLots=reservedWarehouseLots();
      for(const lot of warehouseCountLots(p)){
        const qty=Math.min(need,Math.max(0,purchaseWarehouseQty(lot)-(reservedLots.get(String(lot.id))||0)));
        if(qty>0){used.push({lot,qty});need-=qty;}
        if(!need)break;
      }
      if(need)throw Error('Складские партии изменились. Откройте инвентаризацию заново.');
    }
    const movement=log('инвентаризация',p.id,delta,'На складе · было '+total+', стало '+actual+' шт.');
    movement.stockScope='at_warehouse';
    if(delta>0){
      const lot={id:id(),productId:p.id,status:'at_warehouse',qty:delta,remainingQty:0,
        unitCost:unit,landedUnitCost:unit,buyTotal:unit*delta,delivery:0,date:now,warehouseReceivedAt:now,
        batch:'Инвентаризация · на складе',inventoryAdjustment:true,adjustmentMovementId:movement.id};
      state.purchases.unshift(lot);
      movement.warehouseLots=[{purchaseId:String(lot.id),qty:delta,unitCost:unit}];
    }else{
      movement.warehouseLots=used.map(({lot,qty})=>{
        lot.warehouseWrittenOffQty=(Number(lot.warehouseWrittenOffQty)||0)+qty;
        return {purchaseId:String(lot.id),qty,unitCost:purchaseDisplayUnitCost(lot)};
      });
    }
    captureMovementBalance(movement,actual,'at_warehouse');
  }
  movementIsStockAdjustment=function(m){return m?.stockScope!=='at_warehouse'&&editableMovement(m);};
  applyInventoryCount=function(p,actual,unit){
    if(document.getElementById('inventoryCountScope')?.value==='at_warehouse')return applyWarehouseCount(p,actual,unit);
    return baseCount(p,actual,unit);
  };
  sizeInventoryForm=function(groupId){
    const html=baseSizeForm(groupId).replace('</h3>','</h3>'+scopeField());
    if(countScope!=='at_warehouse')return html;
    const fields=sizeInventoryRows(groupId).map(warehouseCountFields);
    let i=0;
    return html.replace(/Учтено [\d.]+ · резерв [\d.]+/g,()=>{const f=fields[i++];return 'На складе '+f.total+' · резерв FBO '+f.reserved;})
      .replace(/(id="sizeInventoryQty(\d+)"[^>]*?value=")\d+/g,(_m,head,i)=>head+fields[i].total)
      .replace(/(id="sizeInventoryCost(\d+)"[^>]*?value=")[\d.]+/g,(_m,head,i)=>head+fields[i].cost)
      .replace(/<div class="link-note">.*?<\/div>/,'<div class="link-note">Укажите фактическое количество на складе, включая резерв FBO.</div>');
  };
  inventoryForm=function(pid,scope){
    const target=prod(pid),group=target?.kind==='variant-group'?target:prod(target?.variantGroupId);
    const selected=target&&!isBundleProduct(target)?target:stockProducts()[0];
    const rows=group?sizeInventoryRows(group.id):[selected].filter(Boolean);
    countScope=scope||((rows.some(p=>purchaseAtWarehouseQty(p.id)>0)&&rows.every(p=>!Number(p.stock)))?'at_warehouse':'sale');
    if(group)return sizeInventoryForm(group.id);
    const html=baseInventoryForm(pid).replace('</h3>','</h3>'+scopeField());
    if(countScope!=='at_warehouse'||!rows.length)return html;
    const p=rows[0],f=warehouseCountFields(p);
    loadedCount={productId:p.id,signature:warehouseCountSignature(p)};
    return html.replace(/(id="iq"[^>]*?value=")\d+/,(_m,head)=>head+f.total)
      .replace(/(id="icost"[^>]*?value=")[\d.]+/,(_m,head)=>head+f.cost)
      .replace(/<div id="inventoryReserveNote"[\s\S]*?<button/,'<div id="inventoryReserveNote" class="link-note">На складе учтено '+f.total+' шт. · резерв FBO '+f.reserved+' шт.</div><div class="link-note">Себестоимость применяется к новым складским единицам.</div><button');
  };
  window.changeInventoryCountScope=function(scope){
    if(document.getElementById('sizeInventoryStatus')&&(sizeInventorySession?.applied||sizeInventorySession?.busy)){
      const input=document.getElementById('inventoryCountScope');
      if(input)input.value=countScope;
      return;
    }
    const pid=document.getElementById('ip')?.value||sizeInventorySession?.groupId;
    if(pid)showSheet(inventoryForm(pid,scope));
  };
  syncInventoryFields=function(){
    if(document.getElementById('inventoryCountScope')?.value==='at_warehouse')return window.changeInventoryCountScope('at_warehouse');
    return baseSync();
  };
  doInventory=function(){
    if(document.getElementById('inventoryCountScope')?.value!=='at_warehouse')return baseSave();
    if(!requireWarehouseEditReady())return;
    const p=prod(document.getElementById('ip')?.value);
    const qty=document.getElementById('iq')?.value,cost=document.getElementById('icost')?.value,actual=Number(qty),unit=Number(cost);
    if(!p||isBundleProduct(p)||!String(qty??'').trim()||!Number.isSafeInteger(actual)||actual<0||!String(cost??'').trim()||!Number.isFinite(unit)||unit<0||!Number.isFinite(actual*unit))return alert('Укажите целое количество от 0 и себестоимость от 0.');
    if(loadedCount?.productId!==p.id||loadedCount.signature!==warehouseCountSignature(p))return alert('Склад изменился. Откройте инвентаризацию заново.');
    try{applyWarehouseCount(p,actual,unit);}catch(error){return alert(error.message);}
    save();closeModal();render();
  };
}

if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',installPurchaseArrivalSort,{once:true});
else installPurchaseArrivalSort();
window.addEventListener('load',installPurchaseArrivalSort,{once:true});
})();
