(function(root){
 'use strict';
 const labels={DATA_FILLING:'Заполнение данных',READY_TO_SUPPLY:'Готова к отгрузке',ACCEPTED_AT_SUPPLY_WAREHOUSE:'Принята на точке отгрузки',IN_TRANSIT:'В пути',ACCEPTANCE_AT_STORAGE_WAREHOUSE:'На приёмке',ACCEPTED_AT_STORAGE_WAREHOUSE:'Принята на складе',REPORTS_CONFIRMATION_AWAITING:'Согласование актов',REPORT_REJECTED:'Спор по актам',COMPLETED:'Завершена',REJECTED_AT_SUPPLY_WAREHOUSE:'Отказ в приёмке',CANCELLED:'Отменена',OVERDUE:'Просроченная заявка',UNSPECIFIED:'Статус не определён'};
 const terminal=['COMPLETED','CANCELLED','REJECTED_AT_SUPPLY_WAREHOUSE'];
 const travelling=['ACCEPTED_AT_SUPPLY_WAREHOUSE','IN_TRANSIT'];
 function statusFor(state){return state==='COMPLETED'?'received':['CANCELLED','REJECTED_AT_SUPPLY_WAREHOUSE'].includes(state)?'cancelled':travelling.includes(state)?'in_transit':'pending';}
 function validDate(x){return typeof x==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(x)&&Number.isFinite(root.Planner.day(x))&&root.Planner.date(root.Planner.day(x))===x;}
 function tracked(shipments){return [...new Set(shipments.filter(s=>s.source==='Ozon API'&&!terminal.includes(s.ozonState)).map(s=>s.orderId))];}
 function merge(previous,payload,stamp){
  if(!payload||!Array.isArray(payload.supplies)||!Array.isArray(payload.missingOrderIds))throw Error('Неполный ответ Ozon по поставкам');
  const seen=new Set(),seenOrders=new Set(),next=[];
  for(const part of payload.supplies){
   if(!/^[1-9][0-9]*$/.test(part.orderId)||part.supplyId&&!/^[1-9][0-9]*$/.test(part.supplyId)||!Array.isArray(part.items)||typeof part.state!=='string')throw Error('Некорректные сведения о поставке Ozon');
   seenOrders.add(part.orderId);
   // Orders without a bundle remain visible; they do not invent SKU or quantities.
   const items=part.items.length?part.items:[{sku:'',name:'Состав пока недоступен',qty:null}];
   for(const item of items){
    if(item.sku&&(!/^[1-9][0-9]*$/.test(item.sku)||!Number.isInteger(item.qty)||item.qty<1))throw Error('Некорректный товар в поставке Ozon');
    const id='ozon_'+(part.supplyId||'order_'+part.orderId)+'_'+(item.sku||'empty');
    if(seen.has(id))throw Error('Повтор товара в поставке Ozon');seen.add(id);
    const old=previous.find(s=>s.id===id&&s.source==='Ozon API')||{};
    const state=terminal.includes(part.orderState)?part.orderState:part.state;
    const moved=!!(old.clusterId&&part.clusterId&&old.clusterId!==part.clusterId||old.warehouseId&&part.warehouseId&&old.warehouseId!==part.warehouseId);
    const override=moved?'':old.clusterOverride||'';
    next.push({id,sku:item.sku,name:item.name,qty:item.qty,cluster:override||part.cluster||'',clusterOverride:override,clusterId:part.clusterId||'',warehouseId:part.warehouseId||'',eta:moved?null:old.eta||null,source:'Ozon API',orderId:part.orderId,orderNumber:part.orderNumber,supplyId:part.supplyId,ozonState:state,status:statusFor(state),statusSource:part.statusSource||'supply-order/get',warehouse:part.warehouse||'',arrivalDate:part.arrivalDate||'',arrivalSource:part.arrivalSource||'',dateWarning:part.dateWarning||'',dateEvidence:Array.isArray(part.dateEvidence)?part.dateEvidence:[],timeslot:part.timeslot||'',timeslotLocal:part.timeslotLocal||part.timeslot||'',timeslotDay:part.timeslotDay||'',dropoffId:part.dropoffId||'',dropoffName:part.dropoffName||'',crossdock:!!part.crossdock,contentCached:!!part.contentCached,contentCheckedAt:part.contentCheckedAt||'',verifiedAt:stamp,unconfirmed:false});
   }
  }
  for(const old of previous.filter(s=>s.source==='Ozon API')){
   if(seen.has(old.id)||seenOrders.has(old.orderId))continue;
   // Disappearing orders are not a confirmation of receipt or cancellation.
   if(terminal.includes(old.ozonState))next.push(old);
   else next.push(Object.assign({},old,{unconfirmed:true}));
  }
  return previous.filter(s=>s.source!=='Ozon API').concat(next);
 }
 function withRouteDates(shipments,routes){
  return shipments.map(s=>{
   // An explicit date (including dates saved by older versions) wins. The
   // estimate is derived, not stored as a confirmed receipt or manual date.
   if(s.source!=='Ozon API'||s.eta||s.status!=='in_transit'||s.unconfirmed)return s;
   const planned=ozonDate(s);
   if(planned)return Object.assign({},s,{eta:planned,etaSource:'ozon',etaBase:planned,etaDays:0});
   const route=(routes||[]).find(r=>r.cluster===s.cluster),base=s.timeslotDay||(s.timeslot||'').slice(0,10);
   if(!s.cluster||!route||!validDate(base))return s;
   const days=[route.travel,route.accept];
   if(days.some(x=>x===null||x===undefined||String(x).trim()===''||!Number.isInteger(Number(x))||Number(x)<0||Number(x)>365))return s;
   const total=Number(route.travel)+Number(route.accept);
   return Object.assign({},s,{eta:root.Planner.date(root.Planner.day(base)+total),etaSource:'route',etaBase:base,etaDays:total});
  });
 }
 function ozonDate(s){const value=typeof s.arrivalDate==='string'?s.arrivalDate.slice(0,10):'';return validDate(value)?value:null;}
 function routesForState(state){
  // The automatic duration is an observation of Ozon's latest planned route,
  // not a promised transport SLA. Never pool different drop-off points.
  const manual=state.routes||[],all=state.shipments.filter(s=>s.source==='Ozon API'&&!s.unconfirmed&&(['in_transit','received'].includes(s.status)||['ACCEPTANCE_AT_STORAGE_WAREHOUSE','ACCEPTED_AT_STORAGE_WAREHOUSE','REPORTS_CONFIRMATION_AWAITING','REPORT_REJECTED'].includes(s.ozonState))&&s.cluster&&!s.clusterOverride&&validDate(s.timeslotDay||(s.timeslot||'').slice(0,10)));
  if(!all.length)return manual;
  const base=s=>s.timeslotDay||(s.timeslot||'').slice(0,10),key=s=>s.clusterId?'id:'+s.clusterId:'name:'+s.cluster,groups=new Map(),inferred=[];
  for(const s of all){const k=key(s);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(s);}
  for(const history of groups.values()){
   const cluster=history[0].cluster;
   if(manual.some(r=>r.cluster===cluster))continue;
   // Ambiguity in one destination does not erase independent routes elsewhere.
   // An undated newer shipment from another origin still prevents using the old route here.
   const last=history.reduce((v,s)=>base(s)>v?base(s):v,''),origins=[...new Set(history.filter(s=>base(s)===last).map(s=>s.dropoffId))];
   if(origins.length!==1||!origins[0]||origins[0]==='0')continue;
   const samples=history.filter(s=>s.dropoffId===origins[0]&&ozonDate(s));if(!samples.length)continue;
   const newest=samples.reduce((v,s)=>base(s)>v?base(s):v,'');
   const current=samples.filter(s=>base(s)===newest),durations=current.map(s=>root.Planner.day(ozonDate(s))-root.Planner.day(base(s)));
   if(durations.some(d=>!Number.isInteger(d)||d<0||d>365))continue;
   const sample=current[0];
   inferred.push({id:'auto_'+sample.supplyId,cluster,clusterId:sample.clusterId||'',prepare:0,travel:Math.max(...durations),accept:0,source:'Ozon planned',label:(sample.dropoffName||sample.dropoffId)+' → '+cluster,supplyId:sample.supplyId,dropoffId:sample.dropoffId,departure:newest,arrival:root.Planner.date(root.Planner.day(newest)+Math.max(...durations))});
  }
  return manual.concat(inferred);
 }
 function reason(s,now){
  if(s.source!=='Ozon API')return '';
  if(s.unconfirmed)return 'Заявка не вернулась из Ozon. Статус требует сверки; в плане не учитывается.';
  if(!s.sku||s.qty===null)return 'Ozon ещё не вернул товарный состав. В плане не учитывается.';
  if(s.ozonState==='OVERDUE')return 'Срок по заявке истёк. Статус Ozon не подтверждает передачу товара. Количество — состав заявки, а не подтверждённое поступление.';
  if(s.status==='received'||s.status==='cancelled')return 'В будущие поступления не включается. Доступный остаток загружается отдельно.';
  if(s.status!=='in_transit')return s.ozonState==='ACCEPTANCE_AT_STORAGE_WAREHOUSE'?'На приёмке часть товара уже может входить в остаток. Поставка исключена из будущих поступлений, чтобы не считать её дважды.':'Этот статус не подтверждает поставку в пути. В плане не учитывается.';
  if(!s.cluster)return 'Выбери кластер, чтобы учесть поставку в плане.';
  if(!validDate(s.eta))return s.dateWarning||'Плановая дата доставки не получена из Ozon. Обнови данные; подробности доступны в отчёте дат.';
  if(s.eta<(now||root.Planner.today()))return 'Плановая дата прошла, а статус остаётся «'+(labels[s.ozonState]||s.ozonState)+'». Новая дата пока не получена. Количество остаётся в поставках; в доступный остаток оно не добавлено.';
  return '';
 }
 function group(s,now){
  if(s.status==='received'||s.status==='cancelled'||terminal.includes(s.ozonState)||s.ozonState==='OVERDUE')return 'archive';
  if(s.unconfirmed)return 'review';
  if(s.status==='in_transit')return !validDate(s.eta)?'undated':s.eta<(now||root.Planner.today())?'delayed':'upcoming';
  if(['ACCEPTANCE_AT_STORAGE_WAREHOUSE','ACCEPTED_AT_STORAGE_WAREHOUSE','REPORTS_CONFIRMATION_AWAITING','REPORT_REJECTED'].includes(s.ozonState))return 'acceptance';
  if(['DATA_FILLING','READY_TO_SUPPLY'].includes(s.ozonState))return 'preparing';
  return 'review';
 }
 function batches(shipments,now){
  const parts=new Map(),remoteIds=new Set(shipments.filter(s=>s.source==='Ozon API').map(s=>s.id));
  for(const row of shipments){
   if(row.source!=='Ozon API'&&row.linkedOzonId&&remoteIds.has(row.linkedOzonId))continue;
   const key=row.source==='Ozon API'?'ozon_'+(row.supplyId||'order_'+row.orderId):'manual_'+row.id;
   if(!parts.has(key))parts.set(key,[]);parts.get(key).push(row);
  }
  return [...parts].map(([key,rows])=>{
   const first=rows[0],categories=rows.map(s=>group(s,now)),clusters=[...new Set(rows.map(s=>s.cluster).filter(Boolean))],dates=[...new Set(rows.map(s=>s.eta).filter(validDate))];
   const incoming=rows.some(s=>s.status==='in_transit'&&!terminal.includes(s.ozonState)&&s.ozonState!=='OVERDUE');
   const acceptance=!incoming&&categories.includes('acceptance'),quantityKnown=rows.every(s=>s.qty!==null&&s.qty!==undefined&&String(s.qty).trim()!==''&&Number.isInteger(Number(s.qty))&&Number(s.qty)>=0);
   return {key,rows,remote:first.source==='Ozon API',incoming,acceptance,quantityKnown,qty:rows.reduce((q,s)=>q+Math.max(0,root.Planner.num(s.qty)),0),cluster:clusters.length===1?clusters[0]:clusters.length?'Несколько направлений':'Кластер не получен',eta:dates.length===1&&rows.every(s=>s.eta===dates[0])?dates[0]:null,mixedDates:dates.length>1||incoming&&dates.length>0&&rows.some(s=>!validDate(s.eta)),unconfirmed:rows.some(s=>s.unconfirmed),delayed:incoming&&categories.includes('delayed'),linkedManual:shipments.some(s=>s.source!=='Ozon API'&&rows.some(r=>r.id===s.linkedOzonId))};
  });
 }

 function mergeSnapshot(state,payload,stamp,makeId){
 const snapshotDay=payload.asOf||root.Planner.today(),rows=payload.rows;if(!Array.isArray(rows))throw Error("Ozon не вернул строки аналитики");
 const shipments=merge(state.shipments,payload,stamp),items=state.items.map(i=>Object.assign({},i)),seen=new Set();
 const requested=payload.stockRequestedSkus;
 if(requested!==undefined&&(!Array.isArray(requested)||requested.some(s=>typeof s!=='string'||! /^[1-9][0-9]{0,18}$/.test(s))||new Set(requested).size!==requested.length))throw Error('Некорректный список проверенных SKU');
 const checked=new Set(requested||[]),label=x=>String(x.cluster||'').trim().replace(/\s+/g,' ').toLocaleLowerCase('ru'),id=x=>/^[1-9][0-9]{0,18}$/.test(String(x.clusterId||''))?String(x.clusterId):'',ids=new Map();
 for(const x of [...items,...state.shipments,...shipments,...rows]){const k=label(x),v=id(x);if(k&&v){if(!ids.has(k))ids.set(k,new Set());ids.get(k).add(v);}}
 const resolved=x=>id(x)||(ids.get(label(x))?.size===1?[...ids.get(label(x))][0]:'');
 const same=(a,b)=>{if(a.sku!==b.sku)return false;const ai=resolved(a),bi=resolved(b);return ai&&bi?ai===bi:label(a)===label(b)&&(!ids.has(label(a))||ids.get(label(a)).size===1);};
 for(const i of items){const v=resolved(i);if(v)i.clusterId=v;}
 for(const shipment of shipments){if(!shipment.clusterOverride){const v=resolved(shipment);if(v)shipment.clusterId=v;}}
 for(const row of rows){
  const key=row.sku+'\u0000'+(resolved(row)?'id:'+resolved(row):'name:'+label(row));
  if(typeof row.sku!=='string'||!row.sku||typeof row.cluster!=='string'||!row.cluster||!Number.isInteger(row.stock)||row.stock<0||row.daily!==null&&(!Number.isFinite(row.daily)||row.daily<0)||seen.has(key)||requested!==undefined&&!checked.has(row.sku))throw Error('Неполные или повторные данные Ozon: остаток, продажи или кластер');seen.add(key);
  const matches=items.filter(i=>same(i,row)),old=matches.find(i=>i.source==='Ozon API')||matches[0]||{};
  const item=Object.assign({},old,row,{id:old.id||makeId(),ozon:old.ozon??null,pack:old.pack||1,rateMode:'manual',asOf:snapshotDay,source:'Ozon API',stockCheckedAt:stamp,stockMissingReason:null});
  const clusterId=resolved(row);if(clusterId)item.clusterId=clusterId;
  const ix=items.findIndex(i=>matches.includes(i));for(let j=items.length-1;j>=0;j--)if(matches.includes(items[j]))items.splice(j,1);
  if(ix>=0)items.splice(Math.min(ix,items.length),0,item);else items.push(item);
 }
 // A supply composition identifies a product, but is not a stock snapshot.
 for(const shipment of shipments){if(shipment.source==='Ozon API'&&shipment.sku&&shipment.cluster&&!items.some(i=>same(i,shipment))){const item={id:makeId(),sku:shipment.sku,name:shipment.name,cluster:shipment.cluster,stock:null,daily:null,ozon:null,pack:1,rateMode:'manual',asOf:snapshotDay,source:'Состав поставки Ozon'};const clusterId=resolved(shipment);if(clusterId)item.clusterId=clusterId;items.push(item);}}
 for(const item of items){if(item.stock==null&&checked.has(item.sku)){item.stockCheckedAt=stamp;item.stockMissingReason='cluster_not_returned';}}

 return {...state,items,shipments,lastSync:stamp,lastSupplySync:stamp,compositionSync:payload.compositionSync||null,lastError:null,supplyWarning:payload.mappingWarning||null};
 }
 const api={mergeSnapshot,labels,terminal,travelling,statusFor,tracked,merge,withRouteDates,ozonDate,routesForState,reason,validDate,group,batches};root.Supplies=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
