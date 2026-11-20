(function(){
 'use strict';
 if(window.WB3_ONLY||window.WAREHOUSE_SCOPE_CONFIG?.inferno)return;
 let snapshot={orders:[],connected:false},loaded=false,loading=null,checkedAt=0,shipment='',search='',showHidden=false,page=1,draft=null;
 const sending=new Set(),sendErrors=new Map();
 const enc=x=>encodeURIComponent(String(x)).replace(/'/g,'%27');
 const number=x=>x===null||x===undefined?'—':Number(x).toLocaleString('ru-RU',{maximumFractionDigits:4});
 const when=x=>x&&Number.isFinite(new Date(x).getTime())?new Date(x).toLocaleString('ru-RU',{timeZone:'Asia/Almaty',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}):'—';
 const money=x=>x==null?'—':Number(x).toLocaleString('ru-RU',{maximumFractionDigits:2})+' ₸';
 async function request(path='',method='GET',body){
  const response=await fetch(MILLIONER_API+'/api/amantrans'+path,{method,cache:'no-store',headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  const data=await response.json();if(!response.ok||data.ok===false)throw Error(data.error||'Не удалось получить Aman Trans');return data;
 }
 function accept(data){snapshot=data;loaded=true;checkedAt=Date.now();const linked=applyPurchaseLinks(),changed=amanApplyPurchaseStages(),delivery=amanApplyPurchaseDelivery();refreshDeliveryDraft();paint();if(linked||changed||delivery)renderPurchases({listOnly:true});}
 async function load(force=false){if(loading)return loading;if(!force&&loaded&&Date.now()-checkedAt<60000)return snapshot;loading=request('/state').then(data=>{accept(data);return data;}).catch(error=>{snapshot.lastError=error.message;paint();return snapshot;}).finally(()=>loading=null);return loading;}
 function rows(){return shipment?purchaseShipmentRows(enc(shipment)):[];}
 function order(id){return snapshot.orders.find(x=>x.id===String(id));}
 function applyPurchaseLinks(){
  if(!snapshot.connected||typeof warehouseEditReady!=='function'||!warehouseEditReady())return false;let changed=false;
  for(const row of state.purchases||[]){const key=String(row.shipmentId||row.id||''),link=snapshot.purchaseLinks?.[key];if(!link||!row.amantransAutoRequestedAt||row.amantransAccountId&&String(row.amantransAccountId)!==snapshot.accountId)continue;
   const currentId=String(row.amantransOrderId||'');
   if(currentId&&currentId!==String(link.id)&&(currentId!==String(link.replacesId||'')||rowTrack(row)!==link.track||!['to_forwarder','to_me'].includes(purchaseStatus(row))))continue;
   if(String(row.amantransOrderId||'')!==String(link.id)||row.amantransAccountId!==snapshot.accountId||row.amantransSyncedTrack!==link.track){row.amantransOrderId=String(link.id);row.amantransAccountId=snapshot.accountId;row.amantransSyncedTrack=link.track;changed=true;}}
  // Older paid shipments predate carrier IDs. Recover only an unambiguous,
  // exact track from a fresh snapshot; never create an external order here.
  if(snapshot.fetchedAt&&!snapshot.lastError&&Date.now()-snapshot.fetchedAt<=10*60000&&typeof purchaseWorkflow==='function'){
   const groups=new Map(),tracks=new Map(),used=new Set(),workflow=purchaseWorkflow(),paid=workflow.findIndex(x=>x.id==='paid'||x.amantransStatus==='NEW');
   for(const row of state.purchases||[]){const key=String(row.shipmentId||row.id||'');if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);if(row.amantransOrderId)used.add(String(row.amantransOrderId));}
   for(const items of groups.values())for(const track of new Set(items.map(x=>rowTrack(x)).filter(Boolean)))tracks.set(track,(tracks.get(track)||0)+1);
   for(const items of groups.values()){
    const track=purchaseTrack(items);
    if(paid<0||!track||tracks.get(track)!==1||items.some(x=>x.amantransOrderId||x.amantransAutoRequestedAt||x.amantransPendingTrack||x.amantransAccountId&&String(x.amantransAccountId)!==snapshot.accountId||rowTrack(x)!==track||!['to_forwarder','to_me'].includes(purchaseStatus(x))||workflow.findIndex(s=>s.id===purchaseWorkflowStage(x))<paid))continue;
    const matches=snapshot.orders.filter(x=>x.track===track);
    if(matches.length!==1||used.has(String(matches[0].id)))continue;
    const carrier=matches[0];used.add(String(carrier.id));
    for(const row of items){row.amantransOrderId=String(carrier.id);row.amantransAccountId=snapshot.accountId;row.amantransSyncedTrack=track;}changed=true;
   }
  }
  if(changed)save();return changed;
 }
 const carrierStages=[['NEW','Новый'],['CHINA','На складе в Китае'],['ON_ROAD_CHINA','В пути из Китая'],['ON_BORDER','На границе'],['SORTING','Сортировка'],['ON_ROAD','В пути'],['SUB_FILIAL','В филиале']];
 function carrierStageOptions(){const options=new Map(carrierStages);for(const row of snapshot.orders||[])if(/^[A-Z_]{1,40}$/.test(row.status)&&row.statusLabel)options.set(row.status,row.statusLabel);return options;}
 window.amanStageBindingField=function(stage,index){
  const selected=String(stage.amantransStatus||''),options=carrierStageOptions();if(selected&&!options.has(selected))options.set(selected,selected);
  return '<div class="field"><label>Статус Aman Trans</label><select data-workflow-aman="'+index+'" '+(stage.id==='arrived'?'disabled':'')+'><option value="">Вручную · без привязки</option>'+[...options].map(([code,label])=>'<option value="'+esc(code)+'" '+(selected===code?'selected':'')+'>'+esc(label)+'</option>').join('')+'</select></div>';
 };
 window.amanValidateWorkflowBindings=function(workflow){
  const seen=new Set(),delivery=workflow.findIndex(x=>x.id==='delivery_warehouse'),arrived=workflow.findIndex(x=>x.id==='arrived');
  for(let i=0;i<workflow.length;i++){
   const stage=workflow[i],code=String(stage.amantransStatus||'');if(!code)continue;
   if(!/^[A-Z_]{1,40}$/.test(code))throw Error('Выбери статус Aman Trans из списка');
   if(i>=arrived)throw Error('Получение на наш склад подтверждается вручную');
   if(seen.has(code))throw Error('Один статус Aman Trans можно привязать только к одному этапу');
   if(code!=='NEW'&&i<delivery)throw Error('Этапы доставки Aman Trans размести начиная со склада доставки и до поступления к тебе');
   if(code==='NEW'&&i>=delivery)throw Error('«Новый» привяжи к оплате, до склада доставки');
   seen.add(code);
  }
 };
 window.amanApplyPurchaseStages=function(){
  if(!loaded||!snapshot.connected||snapshot.lastError||!snapshot.fetchedAt||Date.now()-snapshot.fetchedAt>10*60000||typeof warehouseEditReady!=='function'||!warehouseEditReady()||typeof purchaseWorkflow!=='function')return false;
  const workflow=purchaseWorkflow(),targets=new Map(),duplicates=new Set(),groups=new Map(),byId=new Map(snapshot.orders.map(x=>[x.id,x])),paid=workflow.findIndex(x=>x.id==='paid'||x.amantransStatus==='NEW');
  if(paid<0)return false;
  for(const stage of workflow){if(!stage.amantransStatus)continue;if(targets.has(stage.amantransStatus))duplicates.add(stage.amantransStatus);targets.set(stage.amantransStatus,stage);}
  for(const row of state.purchases||[]){const key=String(row.shipmentId||row.id||'');if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}
  let changed=false;
  for(const items of groups.values()){
   const first=items[0],id=String(first.amantransOrderId||''),account=String(first.amantransAccountId||'');
   if(!id||account!==snapshot.accountId||items.some(x=>String(x.amantransOrderId||'')!==id||String(x.amantransAccountId||'')!==account||!['to_forwarder','to_me'].includes(purchaseStatus(x))))continue;
   const carrier=byId.get(id),target=targets.get(carrier?.status);if(!target||duplicates.has(carrier.status))continue;
   const phase=purchaseWorkflowPhase(target.id),targetIndex=workflow.findIndex(x=>x.id===target.id);if(!['to_forwarder','to_me'].includes(phase)||target.id==='arrived'||carrier.status!=='NEW'&&phase!=='to_me'||carrier.status==='NEW'&&phase!=='to_forwarder')continue;
   if(items.some(x=>{const index=workflow.findIndex(s=>s.id===purchaseWorkflowStage(x));return index<paid||index>targetIndex;}))continue;
   for(const row of items){if(row.workflowStageId===target.id&&row.status===phase)continue;row.workflowStageId=target.id;row.workflowStageAt=snapshot.fetchedAt;row.status=phase;row.amantransStageStatus=carrier.status;row.amantransStageObservedAt=snapshot.fetchedAt;changed=true;}
  }
  if(changed)save();return changed;
 };
 window.amanApplyPurchaseDelivery=function(){
  if(!loaded||!snapshot.connected||snapshot.lastError||!snapshot.fetchedAt||Date.now()-snapshot.fetchedAt>10*60000||typeof warehouseEditReady!=='function'||!warehouseEditReady())return false;
  const groups=new Map(),used=new Map(),workflow=typeof purchaseWorkflow==='function'?purchaseWorkflow():[],paid=workflow.findIndex(x=>x.id==='paid'||x.amantransStatus==='NEW');let changed=false;
  if(paid<0)return false;
  for(const row of state.purchases||[]){const key=String(row.shipmentId||row.id||'');if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}
  for(const items of groups.values())for(const id of new Set(items.map(x=>String(x.amantransOrderId||'')).filter(Boolean)))used.set(id,(used.get(id)||0)+1);
  for(const items of groups.values()){
   const first=items[0],id=String(first.amantransOrderId||''),carrier=order(id);
   if(!id||used.get(id)!==1||!carrier||carrier.track!==purchaseTrack(items)||items.some(x=>String(x.amantransOrderId||'')!==id||String(x.amantransAccountId||'')!==snapshot.accountId||!['to_forwarder','to_me'].includes(purchaseStatus(x))||workflow.findIndex(stage=>stage.id===purchaseWorkflowStage(x))<paid||rowTrack(x)!==carrier.track))continue;
   if(carrier.totalKzt==null||!Number.isFinite(Number(carrier.totalKzt))||Number(carrier.totalKzt)<=0)continue;
   const total=Math.round(Number(carrier.totalKzt)*100)/100,current=items.reduce((n,x)=>n+Math.max(0,Number(x.delivery)||0),0),previous=first.amantransDeliveryTotal;
   // An entered amount is a manual override. Keep it, including a manual zero
   // after a previous import; only our unchanged last import follows new rates.
   if(previous==null?current>0.005:items.some(x=>x.amantransDeliveryTotal!==previous)||Math.abs(current-Number(previous))>0.005)continue;
   const qty=items.reduce((n,x)=>n+Math.max(0,Number(x.qty)||0),0),buys=items.map(x=>Math.max(0,Number(x.buyTotal??Number(x.unitCost||0)*Number(x.qty||0))||0)),buy=buys.reduce((n,x)=>n+x,0),base=buy>0?buy:qty;
   if(!base||items.some(x=>!Number.isSafeInteger(Number(x.qty))||Number(x.qty)<=0))continue;
   if(previous===total&&Math.abs(current-total)<0.005)continue;
   let allocated=0,weight=0;const cents=Math.round(total*100);
   for(let i=0;i<items.length;i++){
    const row=items[i];weight+=buy>0?buys[i]:Number(row.qty);const through=i===items.length-1?cents:Math.round(cents*weight/base),share=(through-allocated)/100;allocated=through;
    row.delivery=share;row.shipmentDeliveryTotal=total;row.amantransDeliveryTotal=total;row.amantransDeliveryObservedAt=snapshot.fetchedAt;
   }
   changed=true;
  }
  if(changed)save();return changed;
 };
 function refreshDeliveryDraft(){
  const input=document.getElementById('editPorDelivery'),box=document.getElementById('editPurchaseItems');
  if(!input?.dataset?.amanDeliveryWatch||input.dataset.amanDeliveryDirty==='1'||input.value!==input.dataset.amanDeliveryValue||!box?.dataset?.shipmentKey)return;
  const items=purchaseShipmentRows(enc(box.dataset.shipmentKey));if(!items.length||!items.every(x=>x.amantransDeliveryTotal!=null))return;
  const value=String(Math.round(items.reduce((n,x)=>n+(Number(x.delivery)||0),0)*100)/100);if(input.value===value)return;
  input.value=value;input.dataset.amanDeliveryValue=input.value;
  if(typeof updateEditPurchaseCalculator==='function')updateEditPurchaseCalculator();
 }
 if(typeof openEditPurchaseShipment==='function'){
  const edit=openEditPurchaseShipment;openEditPurchaseShipment=function(...args){
   amanApplyPurchaseDelivery();const result=edit(...args),input=document.getElementById('editPorDelivery');
   if(input?.dataset){input.dataset.amanDeliveryWatch='1';input.dataset.amanDeliveryValue=input.value;input.dataset.amanDeliveryDirty='0';input.addEventListener('input',()=>{input.dataset.amanDeliveryDirty='1';},{once:true});}
   void load();return result;
  };
 }
 function temporaryPurchaseTrack(row){
  return 'TMP-'+String(row?.shipmentId||row?.id||'').replace(/[^a-zA-Z0-9_-]/g,'-').slice(-90);
 }
 function rowTrack(row){
  if(!row)return '';
  if(Object.hasOwn(row,'amantransTrack'))return String(row.amantransTrack||'').trim();
  const batch=String(row.batch||'').trim();
  return /^Китай \d/.test(batch)?'':batch;
 }
 function purchaseTrack(items){return rowTrack(items[0]);}
 window.amanPurchaseTrack=purchaseTrack;
 window.amanPurchaseTitle=function(row){
  const batch=String(row?.batch||'').trim();
  if(batch&&batch!==temporaryPurchaseTrack(row))return batch;
  const orderedAt=Number(row?.orderedAt||row?.date||row?.createdAt);
  return orderedAt?'Китай '+new Date(orderedAt).toLocaleDateString('ru-RU',{timeZone:'Asia/Almaty'}):'Поставка';
 };
 const normalizedTrack=track=>String(track||'').replace(/[\s\u200b-\u200d\ufeff]/g,'').toUpperCase();
 function duplicateTracks(items,track){
  const key=normalizedTrack(track);if(!key)return [];
  const own=new Set(items.map(row=>String(row.shipmentId||row.id))),groups=new Map();
  for(const row of state.purchases||[]){
   const group=String(row.shipmentId||row.id||'');
   if(!group||own.has(group)||normalizedTrack(rowTrack(row))!==key)continue;
   if(!groups.has(group))groups.set(group,row);
  }
  return [...groups.entries()].map(([group,row])=>({group,row}));
 }
 function duplicateTrackHtml(items,track){
  const duplicates=duplicateTracks(items,track);if(!duplicates.length)return '';
  return '<div class="link-note" role="status" style="color:#8a5300"><b>⚠ Такой трек уже указан в других закупках</b>'
   +duplicates.map(({group,row})=>'<div>'+esc(typeof purchaseShipmentHeading==='function'
    ?purchaseShipmentHeading(group,row.orderedAt||row.date,window.amanPurchaseTitle(row))
    :window.amanPurchaseTitle(row)+' · '+new Date(Number(row.orderedAt||row.date)||0).toLocaleDateString('ru-RU'))+'</div>').join('')
   +'<div>Проверь, это одна посылка или трек введён повторно.</div></div>';
 }
 window.amanDuplicateTracks=duplicateTracks;
 window.amanPurchaseTrackHtml=function(items){
  const track=purchaseTrack(items);
  return (track?'<div class="muted" style="overflow-wrap:anywhere">'+(track.startsWith('TMP-')?'Временный трек':'Трек')+' · '+esc(track)+'</div>':'')+duplicateTrackHtml(items,track);
 };
 let trackWarningItems=[];
 window.amanRefreshTrackWarning=function(input){
  const warning=document.getElementById('amanDuplicateTrackWarning');
  if(warning)warning.innerHTML=duplicateTrackHtml(trackWarningItems,input.value);
 };
 window.amanPurchaseTrackField=items=>{
  trackWarningItems=items;
  return '<div class="field"><label for="amanPurchaseTrackInput">Трек-код</label><input id="amanPurchaseTrackInput" value="'+esc(purchaseTrack(items))+'" oninput="amanRefreshTrackWarning(this)" autocomplete="off" placeholder="Можно добавить позже"></div>'
   +'<div id="amanDuplicateTrackWarning">'+duplicateTrackHtml(items,purchaseTrack(items))+'</div>';
 };
 window.amanReadPurchaseTrack=()=>document.getElementById('amanPurchaseTrackInput')?.value;
 window.amanPreparePurchase=function(items,previousStage,track,previousTrack){
  if(!items.length)return;
  if(track!==undefined){
   const keepTrack=items.some(row=>row.amantransOrderId||row.amantransAutoRequestedAt);
   const desired=String(track).trim()||(keepTrack?String(previousTrack||purchaseTrack(items)).trim():'');
   for(const row of items)row.amantransTrack=desired;
  }
  const current=purchaseWorkflowStage(items[0]),stage=typeof purchaseWorkflow==='function'?purchaseWorkflow().find(x=>x.id===current):null,paid=current==='paid'||stage?.amantransStatus==='NEW';
  const payment=paid&&previousStage!==current&&!items.some(x=>x.amantransOrderId);
  if(payment){
   const desired=purchaseTrack(items)||temporaryPurchaseTrack(items[0]),at=Date.now();
   for(const row of items){row.amantransAutoRequestedAt=at;row.amantransTrack=desired;}
  }
  const desired=purchaseTrack(items),edited=previousTrack===undefined?track!==undefined:desired!==String(previousTrack).trim();
  if(desired&&(payment||edited)&&items.some(x=>x.amantransAutoRequestedAt||x.amantransOrderId)&&items.some(x=>x.amantransPendingTrack!==desired)){
   const operationId=crypto.randomUUID();
   for(const row of items){row.amantransPendingTrack=desired;row.amantransTrackOperationId=operationId;}
  }
 };
 window.amanSubmitPurchase=async function(key){
  key=decodeURIComponent(String(key));const items=purchaseShipmentRows(enc(key));
  if(!items.length||!items.some(x=>x.amantransAutoRequestedAt||x.amantransOrderId)||sending.has(key))return;
  const firstRow=items[0],linked=items.some(x=>x.amantransOrderId),track=purchaseTrack(items);
  if(linked&&!items.some(x=>x.amantransPendingTrack))return;
  if(linked&&items.every(x=>x.amantransSyncedTrack===track))return;
  if(!requireWarehouseEditReady()){sendErrors.set(key,'Дождись загрузки склада и проверь отправку');paint();return;}
  if(!track){sendErrors.set(key,'Укажи трек-код закупки');paint();return;}
  const operationId=firstRow.amantransTrackOperationId||crypto.randomUUID();if(!firstRow.amantransTrackOperationId){for(const row of items){row.amantransTrackOperationId=operationId;row.amantransPendingTrack=track;}save();}
  sending.add(key);sendErrors.delete(key);paint();let successful=false;
  try{
   const result=await request('/purchases/register','POST',{purchaseKey:key,...(linked?{orderId:firstRow.amantransOrderId,accountId:firstRow.amantransAccountId,previousTrack:firstRow.amantransSyncedTrack||order(firstRow.amantransOrderId)?.track||''}:{}),editOperationId:operationId,fields:{...warehouseDeclaration(items),track,shippingMethod:'Avto'}});
   accept(result);
   if(!result.createdOrderId)throw Error('Проверяем создание в Aman Trans. Связь восстановится автоматически, повторной записи не будет.');
   const current=purchaseShipmentRows(enc(key));
   if(!requireWarehouseEditReady())throw Error('Отправлено в Aman Trans. Дождись связи со складом и нажми «Проверить отправку».');
   for(const row of current){if(row.amantransAccountId&&row.amantransAccountId!==result.accountId)throw Error('Аккаунт закупки изменился');row.amantransOrderId=result.createdOrderId;row.amantransAccountId=result.accountId;row.amantransSyncedTrack=result.syncedTrack||track;}save();successful=true;
   if(result.refreshNeeded&&!linked){try{accept(await request('/sync','POST'));}catch{}}
  }catch(error){sendErrors.set(key,error.message);}finally{sending.delete(key);paint();if(successful&&purchaseTrack(purchaseShipmentRows(enc(key)))!==track)void amanSubmitPurchase(enc(key));}
 };
 window.amanRetryPurchase=key=>amanSubmitPurchase(key);
 let shipmentDataDraft=null;
 const shipmentDataOperations=new Map();
 function warehouseDeclaration(items){
  const names=items.map(row=>productNameById(row.productId,'')).filter(Boolean)
   .sort((a,b)=>a.localeCompare(b,'ru',{numeric:true,sensitivity:'base'}));
  const total=items.reduce((n,row)=>n+(Number(row.buyTotal)||Number(row.unitCost||0)*Number(row.qty||0)),0);
  return {name:(names[0]||'').slice(0,200),priceUsd:Math.round(total*100)/100,
   amount:items.reduce((n,row)=>n+Number(row.qty||0),0)};
 }
 function linkedShipment(items){
  const id=String(items[0]?.amantransOrderId||'');
  return id&&snapshot.accountId&&items.every(x=>String(x.amantransOrderId||'')===id
   &&String(x.amantransAccountId||'')===snapshot.accountId) ? order(id) : null;
 }
 function shipmentComparison(items,carrier){
  const warehouse=warehouseDeclaration(items);
  const trackMatches=!!carrier.track&&items.every(row=>rowTrack(row)===carrier.track)
   &&!duplicateTracks(items,carrier.track).length;
  const quantityKnown=Number.isSafeInteger(carrier.amount)&&carrier.amount>0;
  const ready=snapshot.connected&&!snapshot.lastError&&trackMatches&&warehouse.name
   &&Number.isFinite(warehouse.priceUsd)&&warehouse.priceUsd>0&&quantityKnown
   &&carrier.amount===warehouse.amount&&carrier.status==='NEW';
  return {warehouse,trackMatches,ready,changed:warehouse.name!==carrier.name||warehouse.priceUsd!==carrier.priceUsd};
 }
 window.amanReviewShipmentData=function(encodedKey){
  const items=purchaseShipmentRows(encodedKey),carrier=linkedShipment(items);
  if(!carrier)return alert('Отправление Aman Trans не найдено. Обнови данные.');
  const result=shipmentComparison(items,carrier);
  if(!result.ready||!result.changed)return alert('Сверь трек, количество, статус и сумму закупки перед обновлением.');
  const {warehouse}=result;
  const operationKey=JSON.stringify([carrier.id,carrier.fingerprint,warehouse.name,warehouse.priceUsd]);
  if(!shipmentDataOperations.has(operationKey))shipmentDataOperations.set(operationKey,crypto.randomUUID());
  shipmentDataDraft={encodedKey,operationKey};
  showSheet('<h3>Обновить данные Aman Trans</h3><div class="muted">Трек '+esc(carrier.track)+'</div>'
   +'<div class="item"><div>Название · '+esc(carrier.name||'—')+' → '+esc(warehouse.name)+'</div>'
   +'<div>Стоимость · '+number(carrier.priceUsd)+' $ → '+number(warehouse.priceUsd)+' $</div></div>'
   +'<div class="muted">Aman Trans подписывает поле стоимости как «$». В него передаётся число из суммы закупки, как при создании отправления.</div>'
   +'<button type="button" class="btn dark full" onclick="amanSendShipmentData(this)">Обновить в Aman Trans</button>'
   +'<div id="amanShipmentDataStatus" role="status"></div>');
 };
 window.amanSendShipmentData=async function(button){
  const draft=shipmentDataDraft;
  if(!draft||!requireWarehouseEditReady()||button.disabled)return;
  const items=purchaseShipmentRows(draft.encodedKey),carrier=linkedShipment(items),status=document.getElementById('amanShipmentDataStatus');
  const result=carrier&&shipmentComparison(items,carrier);
  if(!result?.ready||!result.changed||JSON.stringify([carrier.id,carrier.fingerprint,result.warehouse.name,result.warehouse.priceUsd])!==draft.operationKey){
   status.textContent='Данные изменились. Открой сверку заново.';return;
  }
  button.disabled=true;
  try{
   const {warehouse}=result;
   await request('/orders/'+carrier.id,'PATCH',{fingerprint:carrier.fingerprint,operationId:shipmentDataOperations.get(draft.operationKey),
    fields:{name:warehouse.name,track:carrier.track,priceUsd:warehouse.priceUsd,amount:carrier.amount}});
   const fresh=await request('/sync','POST');accept(fresh);
   const updated=order(carrier.id);
   if(updated?.name!==warehouse.name||updated?.priceUsd!==warehouse.priceUsd)throw Error('Aman Trans ещё не подтвердил новые данные.');
   status.textContent='Обновление подтверждено Aman Trans.';
  }catch(error){
   status.textContent=error.message+' Проверь данные отправления перед повтором.';
  }
 };
 function connectedCard(){return '<b>Aman Trans</b><div class="muted">'+(loaded?snapshot.connected?'Подключён '+esc(snapshot.phoneHint||''):'Не подключён':'Доставки из Китая')+'</div><button type="button" class="btn full" onclick="openAmanTrans()">'+(snapshot.connected?'Отправления и доставка':'Подключить Aman Trans')+'</button><button type="button" class="btn full" onclick="openPurchaseWorkflowEditor()">Привязать этапы</button>';}
 function install(){document.getElementById('amanPurchases')?.remove?.();if(!document.getElementById('amanSettings')){const root=document.getElementById('settings');if(root){const box=document.createElement('div');box.id='amanSettings';box.className='item';root.append(box);}}paint();}
 function paint(){for(const el of document.querySelectorAll('[data-aman-shipment]')){const key=decodeURIComponent(el.dataset.amanShipment),items=typeof state!=='undefined'?(state.purchases||[]).filter(x=>String(x.shipmentId||x.id||'')===key):[];el.outerHTML=amanShipmentHtml(key,items);}const box=document.getElementById('amanSettings');if(box)box.innerHTML=connectedCard();}
 window.amanShipmentHtml=function(key,items){
  const row=linkedShipment(items),requested=items.some(x=>x.amantransAutoRequestedAt),error=sendErrors.get(key);
  const label=sending.has(key)?'Синхронизирую трек…':error?error:row?row.statusLabel+(snapshot.lastError?' · нет обновления':'')
   :items.some(x=>x.amantransOrderId)?'Связь требует проверки':requested?'Ожидает отправки':'';
  let details='';
  if(row){
   const {warehouse,trackMatches,ready,changed}=shipmentComparison(items,row);
   const discrepancy=!trackMatches?'Проверь привязку: трек различается или повторяется в закупках.'
    :row.amount!=null&&row.amount!==warehouse.amount?'Количество отличается: «Склад» '+number(warehouse.amount)+' шт., Aman Trans '+number(row.amount)+' шт.'
    :changed?'Название или стоимость отличаются от «Склада».':'';
   details='<details><summary class="muted">Данные Aman Trans</summary><div class="muted">Трек '+esc(row.track)
    +' · '+number(row.amount)+' шт. · вес '+number(row.weight)+' кг</div>'
    +'<div class="muted">Стоимость товара '+number(row.priceUsd)+' $ · тариф '+number(row.tariffUsd)+' $/кг</div>'
    +'<div class="muted">Доставка '+number(row.deliveryUsd)+' $ · упаковка '+number(row.boxUsd)+' $ · курс '+number(row.exchangeRate)+'</div>'
    +(row.createdAt?'<div class="muted">Создано '+when(row.createdAt)+'</div>':'')
    +(discrepancy?'<div class="muted">'+esc(discrepancy)+'</div>':'')
    +(ready&&changed?'<button type="button" class="btn" onclick="amanReviewShipmentData(\''+enc(key)+'\')">Сверить название и сумму</button>':'')
    +'</details>';
  }
  return '<div class="aman-shipment" data-aman-shipment="'+enc(key)+'">'+(label?'<div class="muted">Aman Trans · '+esc(label)
   +(row?' · '+esc(row.name||'Без названия')+' · доставка '+money(row.totalKzt):'')+'</div>':'')+details+'</div>';
 };
 window.openAmanTrans=async function(key=''){shipment=decodeURIComponent(String(key));search='';page=1;showHidden=false;showSheet('<h3>Aman Trans</h3><div class="muted">Читаю сохранённые отправления…</div>');await load();if(!snapshot.connected)return openAmanConnect();renderManager();};
 function renderManager(){
  const selected=rows(),ids=new Set(selected.filter(x=>String(x.amantransAccountId)===snapshot.accountId).map(x=>String(x.amantransOrderId))),filter=search.trim().toLocaleLowerCase('ru'),all=snapshot.orders.filter(x=>showHidden||!x.hidden).filter(x=>!filter||(x.name+' '+x.track).toLocaleLowerCase('ru').includes(filter)),pages=Math.max(1,Math.ceil(all.length/20));page=Math.min(page,pages);
  const cards=all.slice((page-1)*20,page*20).map(x=>'<div class="item"><b>'+esc(x.name)+'</b><div>'+esc(x.track)+'</div><div class="muted">'+esc(x.statusLabel)+' · '+number(x.amount)+' шт. · '+number(x.weight)+' кг</div><div class="muted">Товар '+number(x.priceUsd)+' $ · тариф '+number(x.tariffUsd)+' $/кг</div><div class="muted">Доставка '+number(x.deliveryUsd)+' $ · упаковка '+number(x.boxUsd)+' $</div><b>'+money(x.totalKzt)+'</b><div class="muted">Создано '+when(x.createdAt)+(x.hidden?' · скрыто в нашем складе':'')+'</div>'+(selected.length?'<button type="button" class="btn full" '+(ids.has(x.id)?'disabled':'')+' onclick="amanLink(\''+x.id+'\')">'+(ids.has(x.id)?'Привязано к закупке':'Связать с этой закупкой')+'</button>':'')+'<div class="actions" style="flex-wrap:wrap"><button type="button" class="btn" onclick="amanEditOrder(\''+x.id+'\')">Изменить</button><button type="button" class="btn" onclick="amanHistory(\''+x.id+'\')">История</button><button type="button" class="btn" onclick="amanHideOrder(\''+x.id+'\','+!x.hidden+',this)">'+(x.hidden?'Вернуть':'Скрыть в складе')+'</button></div></div>').join('');
  showSheet('<h3>Aman Trans'+(selected.length?' · закупка':'')+'</h3><div class="muted">Обновлено: '+when(snapshot.fetchedAt)+'</div>'+(snapshot.lastError?'<div class="link-note">'+esc(snapshot.lastError)+'. Показаны последние сохранённые данные.</div>':'')+'<div class="actions" style="flex-wrap:wrap"><button class="btn" type="button" onclick="amanRefresh(this)">Обновить</button><button class="btn" type="button" onclick="amanEditOrder()">Создать отправление</button></div><div class="field"><label>Название или трек</label><input id="amanSearch" value="'+esc(search)+'" placeholder="Найти отправление"></div><label><input type="checkbox" '+(showHidden?'checked':'')+' onchange="amanShowHidden(this.checked)"> Показывать скрытые</label><div id="amanList">'+(cards||'<div class="empty">Отправлений нет</div>')+'</div><div class="actions" style="flex-wrap:wrap"><button class="btn" type="button" '+(page<=1?'disabled':'')+' onclick="amanPage(-1)">←</button><span>'+page+' / '+pages+' · '+all.length+'</span><button class="btn" type="button" '+(page>=pages?'disabled':'')+' onclick="amanPage(1)">→</button></div>'+(selected.some(x=>x.amantransOrderId)?'<button type="button" class="btn full" onclick="amanUnlink()">Отвязать от закупки</button>':'')+'<div class="muted">Статус перевозчика не проводит приход и не меняет себестоимость закупки. Скрытие действует только в нашем складе.</div><button class="btn full" type="button" onclick="openAmanConnect()">Подключение аккаунта</button>');
  let timer;document.getElementById('amanSearch').oninput=e=>{search=e.target.value;clearTimeout(timer);timer=setTimeout(()=>{page=1;const caret=document.getElementById('amanSearch')?.selectionStart;renderManager();const field=document.getElementById('amanSearch');field?.focus();field?.setSelectionRange(caret,caret);},250);};
 }
 window.amanPage=delta=>{page=Math.max(1,page+delta);renderManager();};
 window.amanShowHidden=value=>{showHidden=value;page=1;renderManager();};
 window.openAmanConnect=function(){showSheet('<h3>Подключение Aman Trans</h3><div class="muted">Вход хранится зашифрованным на сервере склада. Обновление отправлений — раз в 5 минут. Смена пароля в Aman Trans может потребовать повторного подключения.</div><div class="field"><label>Телефон</label><input id="amanPhone" type="tel" autocomplete="username" placeholder="+7…"></div><div class="field"><label>Пароль Aman Trans</label><input id="amanPassword" type="password" autocomplete="current-password"></div><div id="amanError" class="login-error"></div><button type="button" class="btn dark full" onclick="amanConnect(this)">Проверить и подключить</button>'+(snapshot.connected?'<button type="button" class="btn full" onclick="amanDisconnect(this)">Отключить</button>':'')+(snapshot.orders.length?'<button type="button" class="btn full" onclick="amanBack()">Сохранённые отправления</button>':''));};
 window.amanConnect=async button=>{button.disabled=true;const phone=document.getElementById('amanPhone').value,password=document.getElementById('amanPassword').value;try{accept(await request('/connect','POST',{phone,password}));document.getElementById('amanPassword').value='';renderManager();}catch(error){document.getElementById('amanError').textContent=error.message;}finally{button.disabled=false;}};
 window.amanDisconnect=async button=>{if(!confirm('Отключить обновление Aman Trans? Сохранённые отправления останутся.'))return;button.disabled=true;try{accept(await request('/disconnect','POST'));openAmanConnect();}catch(error){alert(error.message);}finally{button.disabled=false;}};
 window.amanRefresh=async button=>{button.disabled=true;button.textContent='Обновляю…';try{accept(await request('/sync','POST'));renderManager();}catch(error){await load(true);alert(error.message);renderManager();}finally{button.disabled=false;}};
 window.amanHideOrder=async(id,hidden,button)=>{button.disabled=true;try{accept(await request('/orders/'+id+'/visibility','POST',{hidden}));renderManager();}catch(error){alert(error.message);}finally{button.disabled=false;}};
 window.amanBack=()=>renderManager();
 window.amanLink=function(id){if(!requireWarehouseEditReady())return;const target=order(id),items=rows();if(!target||!items.length)return alert('Закупка или отправление изменились. Откройте их заново.');for(const row of items){row.amantransOrderId=id;row.amantransAccountId=snapshot.accountId;}save();renderPurchases({listOnly:true});renderManager();};
 window.amanUnlink=function(){if(!requireWarehouseEditReady())return;for(const row of rows()){delete row.amantransOrderId;delete row.amantransAccountId;delete row.amantransAutoRequestedAt;}save();renderPurchases({listOnly:true});renderManager();};
 window.amanEditOrder=function(id=''){
  const original=id?order(id):null;if(id&&!original)return alert('Обновите список Aman Trans');
  const items=rows(),name=items.map(x=>productNameById(x.productId,'')).filter(Boolean).join(', ').slice(0,200),fields=original?{name:original.name,track:original.track,priceUsd:original.priceUsd,amount:original.amount}:{name,track:'',priceUsd:'',amount:items.reduce((sum,x)=>sum+Number(x.qty||0),0)||1,shippingMethod:'Avto'};
  draft={id,original,operationId:crypto.randomUUID(),fields};
  showSheet('<h3>'+(id?'Изменить отправление':'Новое отправление')+'</h3><div class="muted">Данные будут отправлены в Aman Trans только кнопкой ниже. Суммы закупки в тенге сюда не переносятся.</div><div class="field"><label>Название</label><input id="amanName" maxlength="200" value="'+esc(fields.name)+'"></div><div class="field"><label>Трек</label><input id="amanTrack" maxlength="100" value="'+esc(fields.track)+'"></div><div class="field"><label>Стоимость товара, $ · как в Aman Trans</label><input id="amanPrice" type="number" min="0" step="0.01" value="'+(fields.priceUsd??'')+'"></div><div class="field"><label>Количество</label><input id="amanAmount" type="number" min="1" step="1" value="'+(fields.amount??'')+'"></div>'+(!id?'<div class="field"><label>Доставка из Китая</label><select id="amanShipping"><option value="Avto">Авто</option><option value="Avia">Авиа</option></select></div>':'')+'<div id="amanError" class="login-error"></div><button type="button" class="btn dark full" onclick="amanSendOrder(this)">Отправить в Aman Trans</button><button type="button" class="btn full" onclick="amanBack()">Отмена</button>');
 };
 window.amanSendOrder=async button=>{
  if(!draft)return;button.disabled=true;const current=draft,fields={name:document.getElementById('amanName').value.trim(),track:document.getElementById('amanTrack').value.trim(),priceUsd:document.getElementById('amanPrice').value,amount:document.getElementById('amanAmount').value,...(!draft.id?{shippingMethod:document.getElementById('amanShipping').value}:{})};
  try{const result=await request('/orders'+(current.id?'/'+current.id:''),current.id?'PATCH':'POST',{fields,operationId:current.operationId,fingerprint:current.original?.fingerprint});accept(result);draft=null;if(result.refreshNeeded){button.textContent='Отправлено · обновляю список…';try{accept(await request('/sync','POST'));}catch{await load(true);alert('Aman Trans принял запись. Список пока не обновился; повторно отправлять её не нужно.');}}renderManager();}
  catch(error){const box=document.getElementById('amanError');if(box)box.textContent=error.message;}finally{button.disabled=false;}
 };
 window.amanHistory=async id=>{showSheet('<h3>История Aman Trans</h3><div id="amanHistory">Загружаю…</div><button class="btn full" onclick="amanBack()">Назад</button>');try{const data=await request('/orders/'+id+'/history'),box=document.getElementById('amanHistory');if(box){const seen=new Set();box.innerHTML=data.history.filter(x=>{const key=x.at+'|'+x.status;if(seen.has(key))return false;seen.add(key);return true;}).map(x=>'<div class="item"><b>'+esc(x.status)+'</b><div class="muted">'+when(x.at)+'</div></div>').join('')||'История пока отсутствует';}}catch(error){const box=document.getElementById('amanHistory');if(box)box.textContent=error.message;}};
 const render=renderPurchases;renderPurchases=function(...args){applyPurchaseLinks();amanApplyPurchaseStages();amanApplyPurchaseDelivery();refreshDeliveryDraft();const result=render(...args);void load();return result;};
 const settings=renderStoreSettings;renderStoreSettings=function(...args){const result=settings(...args);paint();void load();return result;};
 function resumePending(){if(typeof warehouseEditReady==='function'&&!warehouseEditReady())return;const keys=new Set((state.purchases||[]).filter(x=>!x.amantransOrderId&&x.amantransAutoRequestedAt||x.amantransOrderId&&x.amantransPendingTrack).map(x=>String(x.shipmentId||x.id||'')));for(const key of keys)if(purchaseShipmentRows(enc(key)).some(x=>x.amantransSyncedTrack!==purchaseTrack(purchaseShipmentRows(enc(key)))))void amanSubmitPurchase(enc(key));}
 const start=startAppRuntime;startAppRuntime=function(...args){const result=start(...args);install();const timer=setInterval(()=>{if(document.querySelector('#purchases.view.active,#settings.view.active'))void load(true).then(resumePending);},60000);return result;};
})();
