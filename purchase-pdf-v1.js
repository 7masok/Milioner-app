(function(){
'use strict';
let busy=false;
function purchasePdfInput(mode,key){
 if(mode==='saved'){
  const rows=purchaseShipmentRows(key);if(!rows.length)throw Error('Закупка не найдена');
  return {title:typeof purchaseShipmentHeading==='function'?purchaseShipmentHeading(rows[0].shipmentId||rows[0].id,rows[0].orderedAt||rows[0].date):rows[0].batch||'Закупка',date:localDateInputValue(rows[0].orderedAt||rows[0].date),draft:false,delivery:rows.reduce((n,r)=>n+(Number(r.delivery)||0),0),items:rows.map(r=>({productId:r.productId,qty:Number(r.qty),buyTotal:Number(r.buyTotal)||Number(r.unitCost)*Number(r.qty)||0}))};
 }
 const edit=mode==='edit',prefix=edit?'editPor':'por',rows=edit?editPurchaseDraftRows():purchaseDraftRows();
 if(!rows.length||rows.some(r=>!r.productId||!Number.isSafeInteger(r.qty)||r.qty<1||r.priceValid===false))throw Error('Проверьте товар и количество в каждой позиции');
 if(document.getElementById(prefix+'BuyTotal')?.dataset?.pendingTotal==='1')throw Error('Сначала распределите общую сумму по количеству или отмените её ввод');
 const buy=Number(document.getElementById(prefix+'BuyTotal')?.value)||0,delivery=Number(document.getElementById(prefix+'Delivery')?.value)||0;
 if(buy<0||delivery<0)throw Error('Суммы закупки не могут быть отрицательными');
 const date=document.getElementById(prefix+'Date')?.value||'';
 const shipmentKey=edit?document.getElementById('editPurchaseItems')?.dataset.shipmentKey:'';
 const title=typeof purchaseShipmentHeading==='function'?purchaseShipmentHeading(shipmentKey,localDateStart(date),'Закупка'):document.getElementById(prefix+'Batch')?.value||'Закупка';
 return {title,date,draft:true,delivery,items:purchaseDraftCosts(rows,buy,delivery).map(r=>({productId:r.productId,qty:r.qty,buyTotal:r.buyTotal}))};
}
window.exportPurchasePdf=async function(mode,key,button){
 if(busy)return;let input;
 try{input=purchasePdfInput(mode,key)}catch(error){alert(error.message);return;}
 busy=true;const label=button?.textContent;if(button){button.disabled=true;button.textContent='Готовлю PDF…';}
 try{
  const response=await fetch(MILLIONER_API+'/api/purchases/pdf',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
  if(!response.ok){const data=await response.json().catch(()=>({}));throw Error(data.error||'Не удалось создать PDF');}
  const blob=await response.blob();if(!blob.size||!blob.type.includes('pdf'))throw Error('Сервер не вернул PDF');
  const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='Закупка-'+String(input.title).replace(/[\\/:*?"<>|]/g,'_').slice(0,60)+'-'+(input.date||new Date().toISOString().slice(0,10))+'.pdf';document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
 }catch(error){alert(error.message||'Не удалось выгрузить PDF');}
 finally{busy=false;if(button){button.disabled=false;button.textContent=label;}}
};

const quantity=row=>Math.max(0,Number(row.qty)||0);
const shipmentKey=row=>String(row.shipmentId||row.id||'');
const dateOf=row=>Number(row.orderedAt||row.date||row.createdAt)||0;
const buyAmount=row=>Number(row.buyTotal)>0?Number(row.buyTotal):Math.max(0,Number(row.unitCost)||0)*quantity(row);
const percent=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:1,signDisplay:'exceptZero'});

function historicalCosts(rows,current,date){
 const totals=new Map(rows.map(row=>[String(row.productId),{buy:0,buyQty:0,delivery:0,deliveryQty:0}]));
 for(const row of state.purchases||[]){
  const cost=totals.get(String(row.productId)),qty=quantity(row);
  if(!cost||!qty||!isRealPurchase(row)||row.returnAdjustment||row.relocation)continue;
  const stage=purchaseStatus(row),orderDate=dateOf(row);
  if(stage!=='received'&&stage!=='at_warehouse')continue;
  if(!orderDate||orderDate>date||current&&shipmentKey(row)===shipmentKey(current))continue;
  if(current&&orderDate===date&&(Number(row.createdAt)||0)>=(Number(current.createdAt)||0))continue;
  const buy=buyAmount(row);
  if(buy>0){cost.buy+=buy;cost.buyQty+=qty;}
  if(Number(row.delivery)>0){cost.delivery+=Number(row.delivery);cost.deliveryQty+=qty;}
 }
 return totals;
}

function summarize(rows,current,date,{draft=false,pendingBuy=false}={}){
 const history=historicalCosts(rows,current,date);
 const buy={estimate:0,actual:0,count:0,compared:0,baseline:0};
 const delivery={estimate:0,actual:0,count:0,compared:0,baseline:0};
 for(const row of rows){
  const cost=history.get(String(row.productId)),qty=quantity(row);
  for(const [key,total] of [['buy',buy],['delivery',delivery]]){
   if(!cost[key+'Qty'])continue;
   const estimate=cost[key]/cost[key+'Qty']*qty;
   total.estimate+=estimate;
   total.count++;
   const actual=key==='buy'?(pendingBuy?0:buyAmount(row)):Number(draft?row.deliveryShare:row.delivery);
   const confirmedFreeDelivery=!draft&&key==='delivery'&&actual===0&&['received','at_warehouse'].includes(purchaseStatus(row));
   if(actual>0||confirmedFreeDelivery){
    total.actual+=actual;
    total.baseline+=estimate;
    total.compared++;
   }
  }
 }
 return {buy,delivery};
}

function estimateLabel(cost,count){
 if(!cost.count)return 'нет данных по прошлым закупкам';
 return '≈ '+fmt(cost.estimate)+(cost.count<count?' · по '+cost.count+' из '+count+' поз.':'');
}

function comparisonLabel(cost,count,pending){
 if(!cost.count)return 'нет данных по прошлым закупкам';
 if(!cost.compared)return pending+' · ориентир '+estimateLabel(cost,count);
 const change=(cost.actual/cost.baseline-1)*100;
 return fmt(cost.actual)+' вместо ≈ '+fmt(cost.baseline)+' · <b>'+percent.format(change)+'%</b>'
  +(cost.compared<count?' · по '+cost.compared+' из '+count+' поз.':'');
}

function addDraftEstimate(mode){
 const edit=mode==='edit',box=document.getElementById(edit?'editPurchaseCalc':'purchaseOrderCalc');
 if(!box)return;
 const rows=(edit?editPurchaseDraftRows():purchaseDraftRows()).filter(row=>row.productId&&quantity(row)>0);
 if(!rows.length)return;
 const key=edit?document.getElementById('editPurchaseItems')?.dataset.shipmentKey:'';
 const current=key?purchaseShipmentRows(encodeURIComponent(key))[0]:null;
 const dateInput=document.getElementById(edit?'editPorDate':'porDate');
 const date=Number(localDateStart(dateInput?.value))||Date.now();
 if(dateInput&&!dateInput.dataset.purchaseEstimate){
  dateInput.dataset.purchaseEstimate='1';
  dateInput.addEventListener('change',edit?()=>updateEditPurchaseCalculator():()=>updatePurchaseOrderCalculator());
 }
 const prefix=edit?'editPor':'por';
 const deliveryAmount=Number(document.getElementById(prefix+'Delivery')?.value)||0;
 const pendingBuy=document.getElementById(prefix+'BuyTotal')?.dataset?.pendingTotal==='1';
 const costs=purchaseDraftCosts(rows,0,deliveryAmount);
 const {buy,delivery}=summarize(costs,current,date,{draft:true,pendingBuy});
 const count=rows.length;
 const buyText=buy.compared?comparisonLabel(buy,count,'цена пока не указана'):estimateLabel(buy,count);
 const deliveryText=delivery.compared?comparisonLabel(delivery,count,'стоимость пока не указана')
  :estimateLabel(delivery,count)+(delivery.count&&buy.compared?' · сумма доставки пока не указана':'');
 box.insertAdjacentHTML('beforeend','<div style="margin-top:10px"><b>Ориентир по прошлым закупкам</b>'
  +'<div>Товары · '+buyText+'</div>'
  +'<div>Доставка · '+deliveryText+'</div>'
  +(buy.count===count&&delivery.count===count?'<div><b>Всего ≈ '+fmt(buy.estimate+delivery.estimate)+'</b></div>':'')
  +'</div>');
}

if(typeof updatePurchaseOrderCalculator==='function'){
 const updateNew=updatePurchaseOrderCalculator;
 updatePurchaseOrderCalculator=function(){
  updateNew();
  addDraftEstimate('new');
 };
}
if(typeof updateEditPurchaseCalculator==='function'){
 const updateEdit=updateEditPurchaseCalculator;
 updateEditPurchaseCalculator=function(){
  updateEdit();
  addDraftEstimate('edit');
 };
}

if(typeof openPurchaseShipment==='function'){
 const openShipment=openPurchaseShipment;
 openPurchaseShipment=function(key){
  openShipment(key);
  const rows=purchaseShipmentRows(key);
  const current=rows[0];
  const sheet=document.getElementById('sheet');
  if(!current||!sheet)return;
  const workflow=purchaseWorkflow();
  const stage=purchaseWorkflowStage(current);
  const unpaid=workflow.some(row=>row.id===stage&&(row.id==='cart'||normalizeName(row.name)==='корзина'));
  if(unpaid)return;
  const button=sheet.querySelector('button[onclick^="exportPurchasePdf("]');
  if(!button)return;
  const {buy,delivery}=summarize(rows,current,dateOf(current));
  button.insertAdjacentHTML('beforebegin','<div class="link-note"><b>Сравнение с прошлыми закупками</b>'
   +'<div style="margin-top:6px">Товары · '+comparisonLabel(buy,rows.length,'цена пока не указана')+'</div>'
   +'<div>Доставка · '+comparisonLabel(delivery,rows.length,'стоимость пока не указана')+'</div></div>');
 };
}
})();
