const states=['DATA_FILLING','READY_TO_SUPPLY','ACCEPTED_AT_SUPPLY_WAREHOUSE','IN_TRANSIT','ACCEPTANCE_AT_STORAGE_WAREHOUSE','REPORTS_CONFIRMATION_AWAITING','REPORT_REJECTED','OVERDUE'];
const terminal=s=>['COMPLETED','CANCELLED','REJECTED_AT_SUPPLY_WAREHOUSE'].includes(s);
const transit=s=>['IN_TRANSIT','ACCEPTED_AT_SUPPLY_WAREHOUSE'].includes(s);
const id=x=>{const s=String(x??'');if(!/^[1-9][0-9]{0,18}$/.test(s))throw Error('Ozon: неверный ID');return s;};
const day=x=>/^\d{4}-\d{2}-\d{2}(T.*)?$/.test(String(x||''))&&!Number.isNaN(Date.parse(String(x).slice(0,10)))&&new Date(String(x).slice(0,10)).toISOString().slice(0,10)===String(x).slice(0,10)?String(x).slice(0,10):'';
const array=(x,label)=>{if(!Array.isArray(x))throw Error('Ozon: нет '+label);return x;};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
export function parseOzonJson(text){return JSON.parse(text.replace(/("(?:[^"\\]|\\.)*")|(-?\d{16,})(?=[,}\]\s])/g,(all,quoted,number)=>quoted||JSON.stringify(number)));}
export function createOzonReader(credentials,{fetchImpl=fetch,sleep=pause,now=Date.now,spacing=1150}={}){
 let nextAt=0;
 return async(path,body)=>{
  for(let attempt=0;attempt<4;attempt++){
   await sleep(Math.max(0,nextAt-now()));nextAt=now()+spacing;
   let response;
   try{response=await fetchImpl('https://api-seller.ozon.ru'+path,{method:'POST',headers:{'Content-Type':'application/json','Client-Id':credentials.clientId,'Api-Key':credentials.apiKey},body:JSON.stringify(body),signal:AbortSignal.timeout(40000)});}
   catch{if(attempt<2){await sleep(1500*2**attempt);continue;}throw Error('Ozon: ошибка соединения. Сохранён предыдущий снимок');}
   if(response.ok){const data=response.text?parseOzonJson(await response.text()):await response.json();if(!data||data.error)throw Error('Ozon: некорректный ответ '+path);return data;}
   if(response.status===429||response.status>=500){
    const h=response.headers.get('retry-after'),retry=h&&/^\d+(\.\d+)?$/.test(h)?now()+Number(h)*1000:Date.parse(h||'');
    nextAt=Math.max(nextAt,Number.isFinite(retry)?retry:now()+2000*2**attempt);
    if(attempt<3&&nextAt-now()<=30000){await sleep(Math.max(0,nextAt-now()));continue;}
    const e=new Error('Ozon '+path+': HTTP '+response.status);e.retryAt=nextAt;throw e;
   }
   throw Error('Ozon '+path+': HTTP '+response.status);
  }
 };
}
function slot(row,slot){
 const raw=slot?.timeslot?.from||'',offset=slot?.timezone_info?.offset;let local=raw;
 if(raw&&offset&&/^[+-]\d{2}:\d{2}$/.test(offset)){
  const sign=offset[0]==='-'?-1:1,mins=sign*(Number(offset.slice(1,3))*60+Number(offset.slice(4,6))),ms=Date.parse(raw);
  if(Number.isFinite(ms))local=new Date(ms+mins*60000).toISOString().slice(0,19);
 }else if(raw&&slot?.timezone_info?.iana_name){try{local=new Intl.DateTimeFormat('sv-SE',{timeZone:slot.timezone_info.iana_name,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(raw)).replace(' ','T');}catch{}}
 Object.assign(row,{timeslot:raw,timeslotLocal:local,timeslotDay:day(local)});
}
function base(order,part){
 const w=part?.storage_warehouse||{},d=order.dropoff_warehouse||{};
 const row={orderId:id(order.order_id),orderNumber:String(order.order_number||order.order_id),orderState:order.state||'UNSPECIFIED',supplyId:part?id(part.supply_id):'',state:part?.state||order.state||'UNSPECIFIED',clusterId:part?.macrolocal_cluster_id?String(part.macrolocal_cluster_id):'',bundleId:part?.bundle_id?String(part.bundle_id):'',stateUpdatedDate:order.state_updated_date||'',warehouse:w.name||'',warehouseId:w.warehouse_id?String(w.warehouse_id):'',arrivalDate:day(w.arrival_date),arrivalSource:day(w.arrival_date)?'storage_warehouse.arrival_date':'',crossdock:!!part?.is_crossdock,dropoffId:d.warehouse_id?String(d.warehouse_id):'',dropoffName:d.name||'',items:[],contentKnown:!!part?.bundle_id,dateEvidence:[],dateWarning:'',cluster:''};slot(row,order.timeslot);return row;
}
async function enrichDates(rows,api,today){
 const missing=rows.filter(r=>transit(r.state)&&!terminal(r.orderState)&&r.contentKnown&&(!day(r.arrivalDate)||r.arrivalDate<today)&&r.supplyId),overdue=new Set(missing.filter(r=>r.arrivalDate).map(r=>r.supplyId));
 for(let start=0;start<missing.length;start+=100){
  const batch=missing.slice(start,start+100),ids=new Map(batch.map(r=>[r.supplyId,r]));
  try{
   const response=await api('/v1/cargoes/get',{supply_ids:batch.map(r=>r.supplyId)}),seen=new Set(),staged=[];
   for(const supply of array(response.supply,'грузомест')){
    const r=ids.get(String(supply.supply_id));if(!r||seen.has(r.supplyId))throw Error('Неверная поставка в датах');seen.add(r.supplyId);
    const cargoes=array(supply.cargoes,'грузомест'),evidence=[];let latest='',complete=cargoes.length>0,active=0;
    for(const cargo of cargoes){const t=cargo.tracking_info||{};evidence.push({cargoId:String(cargo.cargo_id||''),type:t.type||'',status:t.status||'',date:t.date||''});if(t.status==='DELETED')continue;active++;const date=day(t.date);if(t.type!=='EXPECTED_ARRIVAL'||t.status!=='ON_TRANSIT_WAREHOUSE'||!date)complete=false;else if(date>latest)latest=date;}
    staged.push([r,{dateEvidence:evidence,...(complete&&active&&latest&&(!r.timeslotDay||latest>=r.timeslotDay)?{arrivalDate:latest,arrivalSource:'cargoes.tracking_info.EXPECTED_ARRIVAL'}:{dateWarning:'Ozon не вернул плановую дату всех грузомест'})}]);
   }
   for(const [r,fields] of staged)Object.assign(r,fields);
  }catch(error){if(error.retryAt)throw error;for(const r of batch)r.dateWarning='Даты грузомест не получены';}
 }
 const orders=new Set(missing.filter(r=>!r.arrivalDate||r.arrivalDate<today||overdue.has(r.supplyId)).map(r=>r.orderId));
 for(const r of rows)if(r.contentKnown&&(transit(r.state)||['COMPLETED','ACCEPTANCE_AT_STORAGE_WAREHOUSE','REPORTS_CONFIRMATION_AWAITING','REPORT_REJECTED'].includes(r.state))&&(!r.dropoffId||!r.timeslotDay))orders.add(r.orderId);
 for(const orderId of orders){try{
  const details=await api('/v1/supply-order/details',{order_id:orderId});if(String(details.order_id)!==orderId)throw Error('Другая заявка');const parts=array(details.supplies,'частей заявки');
  if(new Set(parts.map(p=>id(p.supply_id))).size!==parts.length)throw Error('Повтор поставки');
  for(const r of rows.filter(r=>r.orderId===orderId)){
   if(details.state)r.orderState=details.state;if(terminal(details.state)){r.state=details.state;r.statusSource='supply-order/details';}
   if(!r.dropoffId&&details.dropoff_warehouse_id)r.dropoffId=String(details.dropoff_warehouse_id);
   if(!r.timeslotDay&&details.timeslot?.value)slot(r,details.timeslot.value);
   const p=parts.find(p=>String(p.supply_id)===r.supplyId),w=p?.storage_warehouse;
   if(!p||w&&r.warehouseId&&String(w.warehouse_id)!==r.warehouseId)continue;
   if(!terminal(details.state)&&p.supply_state){r.state=p.supply_state;r.statusSource='supply-order/details';}
   const date=day(w?.arrival_date);if(date&&(date>=today||!r.arrivalDate||r.arrivalDate<today)){r.arrivalDate=date;r.arrivalSource='details.storage_warehouse.arrival_date';r.dateWarning='';}
  }
 }catch(error){if(error.retryAt)throw error;for(const r of rows.filter(r=>r.orderId===orderId))r.dateWarning+=' Дата заявки не получена';}}
}
async function bundle(api,bundleId){
 const grouped=new Map();let cursor='';
 for(let page=0;page<1000;page++){
  const data=await api('/v1/supply-order/bundle',{bundle_ids:[bundleId],limit:100,sort_field:'SKU',is_asc:true,...(cursor?{last_id:cursor}:{})}),items=array(data.items,'состава поставки');
  if(typeof data.has_next!=='boolean')throw Error('Ozon: неполный состав');
  for(const i of items){const sku=id(i.sku),qty=i.quantity;if(!Number.isSafeInteger(qty)||qty<0)throw Error('Ozon: неверное количество');if(!qty)continue;const old=grouped.get(sku)||{sku,name:i.name||sku,qty:0};old.qty+=qty;grouped.set(sku,old);}
  if(!data.has_next)return [...grouped.values()];if(!data.last_id||data.last_id===cursor||!items.length)throw Error('Ozon: повтор страницы состава');cursor=data.last_id;
 }throw Error('Ozon: слишком большой состав');
}
export async function collectSnapshot(api,{previous=null,cache=new Map(),saveBundle=async()=>{},extraSkus=[],now=Date.now,today}={}){
 const started=now(),ids=new Set();let cursor='',ended=false;
 for(let page=0;page<100;page++){
  const response=await api('/v3/supply-order/list',{filter:{states},limit:100,sort_by:'ORDER_CREATION',sort_dir:'DESC',...(cursor?{last_id:cursor}:{})}),pageIds=array(response.order_ids,'списка заявок');
  for(const value of pageIds){const key=id(value);if(ids.has(key))throw Error('Ozon: повтор заявки');ids.add(key);}
  const next=response.last_id||'';if(!pageIds.length||!next){ended=true;break;}if(next===cursor)throw Error('Ozon: повтор страницы заявок');cursor=next;
 }if(!ended)throw Error('Ozon: слишком много заявок');
 for(const p of previous?.supplies||[])if(!terminal(p.state)&&!terminal(p.orderState))ids.add(p.orderId);
 const orderIds=[...ids],seen=new Set(),parts=[];
 for(let start=0;start<orderIds.length;start+=50){const batch=orderIds.slice(start,start+50),data=await api('/v3/supply-order/get',{order_ids:batch});for(const order of array(data.orders,'заявок')){const key=id(order.order_id);if(!batch.includes(key)||seen.has(key))throw Error('Ozon: неверная заявка');seen.add(key);const supplies=array(order.supplies,'поставок');if(!supplies.length)parts.push(base(order,null));for(const p of supplies)parts.push(base(order,p));}}
 if(new Set(parts.filter(p=>p.supplyId).map(p=>p.supplyId)).size!==parts.filter(p=>p.supplyId).length)throw Error('Ozon: повтор поставки');
 await enrichDates(parts,api,today);
 let reused=0,downloaded=0;const pass=new Map();
 const fingerprint=p=>JSON.stringify([p.orderId,p.supplyId,p.bundleId,p.state,p.orderState,p.stateUpdatedDate,p.clusterId,p.warehouseId]);
 const canReuse=p=>{const c=cache.get(p.supplyId),ttl=transit(p.state)?6*3600000:7*86400000;return !!(c&&c.fingerprint===fingerprint(p)&&Array.isArray(c.items)&&c.items.every(i=>/^[1-9][0-9]*$/.test(i.sku)&&Number.isSafeInteger(i.qty)&&i.qty>0)&&now()>=c.checkedAt&&now()-c.checkedAt<ttl&&(transit(p.state)||terminal(p.state)||p.state==='OVERDUE'));};
 const refresh=new Set(parts.filter(p=>p.bundleId&&!canReuse(p)).map(p=>p.bundleId));
 for(const p of parts){
  if(!p.bundleId)continue;
  const cached=cache.get(p.supplyId),reusable=canReuse(p)&&!refresh.has(p.bundleId);let checkedAt;
  if(pass.has(p.bundleId)){const hit=pass.get(p.bundleId);p.items=hit.items;checkedAt=hit.checkedAt;reused++;}
  else if(reusable){p.items=cached.items;checkedAt=cached.checkedAt;reused++;}
  else{p.items=await bundle(api,p.bundleId);checkedAt=now();downloaded++;}
  pass.set(p.bundleId,{items:p.items,checkedAt});p.contentCached=!!reusable;p.contentCheckedAt=new Date(checkedAt).toISOString();
  const entry={fingerprint:fingerprint(p),items:p.items,checkedAt};cache.set(p.supplyId,entry);await saveBundle(p.supplyId,entry);
 }
 const clusters=new Map(),warehouses=new Map();let mappingWarning='';
 for(const type of ['CLUSTER_TYPE_OZON','CLUSTER_TYPE_CIS']){try{
  const data=await api('/v1/cluster/list',{cluster_type:type});for(const c of array(data.clusters,'кластеров')){if(c.macrolocal_cluster_id)clusters.set(String(c.macrolocal_cluster_id),c.name);for(const lc of c.logistic_clusters||[])for(const w of lc.warehouses||[])warehouses.set(String(w.warehouse_id),c.name);}
 }catch(error){if(error.retryAt)throw error;mappingWarning='Не все кластеры определены';}}
 const names=new Map();for(const r of [...(previous?.rows||[]),...extraSkus])if(/^[1-9][0-9]{0,18}$/.test(String(r.sku||'')))names.set(String(r.sku),r.name||String(r.sku));
 for(const p of parts){p.cluster=clusters.get(p.clusterId)||warehouses.get(p.warehouseId)||previous?.supplies?.find(old=>old.supplyId===p.supplyId&&old.clusterId===p.clusterId)?.cluster||'';for(const i of p.items)names.set(i.sku,i.name||i.sku);}
 cursor='';ended=false;const unresolved=[];
 for(let page=0;page<200;page++){
  const data=await api('/v3/product/list',{filter:{visibility:'ALL'},limit:1000,...(cursor?{last_id:cursor}:{})}),result=data.result,items=array(result?.items,'каталога');
  for(const i of items){if(i.archived||i.is_discounted)continue;if(i.sku&&Number(i.sku)>0)names.set(id(i.sku),names.get(String(i.sku))||i.offer_id||String(i.sku));else if(i.product_id)unresolved.push(id(i.product_id));}
  const next=result.last_id||'';if(!items.length||items.length<1000||!next){ended=true;break;}if(next===cursor)throw Error('Ozon: повтор страницы каталога');cursor=next;
 }if(!ended)throw Error('Ozon: слишком большой каталог');
 for(let start=0;start<unresolved.length;start+=100){const data=await api('/v3/product/info/list',{product_id:unresolved.slice(start,start+100)});for(const i of array(data.items,'карточек'))if(i.sku)names.set(id(i.sku),i.name||i.offer_id||String(i.sku));}
 const skus=[...names.keys()],stocks=new Map();
 for(let start=0;start<skus.length;start+=100){
  const batch=skus.slice(start,start+100),data=await api('/v1/analytics/stocks',{skus:batch});
  for(const i of array(data.items||data.result?.items,'остатков')){
   const sku=id(i.sku),cluster=String(i.cluster_name||'').trim(),stock=i.available_stock_count,daily=i.ads_cluster??null,clusterId=Number(i.macrolocal_cluster_id)>0?String(i.macrolocal_cluster_id):'';
   if(!batch.includes(sku)||!cluster||!Number.isSafeInteger(stock)||stock<0||daily!==null&&(!Number.isFinite(daily)||daily<0))throw Error('Ozon: некорректный остаток или продажи');
   const key=sku+'\0'+(clusterId?'id:'+clusterId:cluster),old=stocks.get(key);
   if(old){old.stock+=stock;if(daily!==null){if(old.daily!==null&&Math.abs(old.daily-daily)>.00001)throw Error('Ozon: разные продажи одного кластера');old.daily=daily;}}
   else stocks.set(key,{sku,cluster,clusterId,name:i.name||names.get(sku),stock,daily});
  }
 }
 return {asOf:today,rows:[...stocks.values()],stockRequestedSkus:skus,supplies:parts,missingOrderIds:orderIds.filter(i=>!seen.has(i)),mappingWarning,compositionSync:{reused,downloaded,seconds:Math.round((now()-started)/1000)},updatedAt:new Date(now()).toISOString()};
}
