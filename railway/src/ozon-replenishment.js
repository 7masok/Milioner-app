const DAY_MS=86_400_000;

function num(value){
  const parsed=Number(value);
  return Number.isFinite(parsed)?parsed:0;
}
function text(value){return String(value??'').trim();}
function median(values){
  const rows=values.map(Number).filter(Number.isFinite).sort((a,b)=>a-b);
  if(!rows.length)return null;
  const mid=Math.floor(rows.length/2);
  return rows.length%2?rows[mid]:(rows[mid-1]+rows[mid])/2;
}
function warehouseKey(row,index){
  return text(row?.warehouse_id)||text(row?.warehouse_name)||('row:'+index);
}

export function normalizeOzonClusterAnalytics(items=[]){
  const groups=new Map();
  (Array.isArray(items)?items:[]).forEach((raw,index)=>{
    const sku=text(raw?.sku);
    const clusterId=text(raw?.cluster_id);
    if(!sku||!clusterId)return;
    const key=sku+'|'+clusterId;
    let group=groups.get(key);
    if(!group){
      group={
        sku,
        offerId:text(raw?.offer_id),
        name:text(raw?.name)||sku,
        clusterId,
        clusterName:text(raw?.cluster_name)||('Кластер '+clusterId),
        adsCluster:0,
        idcCluster:null,
        daysWithoutSalesCluster:null,
        turnoverGradeCluster:'',
        warehouses:new Map()
      };
      groups.set(key,group);
    }
    if(!group.offerId&&raw?.offer_id)group.offerId=text(raw.offer_id);
    if((!group.name||group.name===group.sku)&&raw?.name)group.name=text(raw.name);
    if((!group.clusterName||group.clusterName===('Кластер '+clusterId))&&raw?.cluster_name)group.clusterName=text(raw.cluster_name);
    group.adsCluster=Math.max(group.adsCluster,Math.max(0,num(raw?.ads_cluster)));
    const idc=Number(raw?.idc_cluster);
    if(Number.isFinite(idc)&&idc>=0)group.idcCluster=group.idcCluster===null?idc:Math.max(group.idcCluster,idc);
    const noSales=Number(raw?.days_without_sales_cluster);
    if(Number.isFinite(noSales)&&noSales>=0)group.daysWithoutSalesCluster=group.daysWithoutSalesCluster===null?noSales:Math.max(group.daysWithoutSalesCluster,noSales);
    if(raw?.turnover_grade_cluster)group.turnoverGradeCluster=text(raw.turnover_grade_cluster);
    const wKey=warehouseKey(raw,index);
    const prev=group.warehouses.get(wKey)||{
      warehouseId:text(raw?.warehouse_id),
      warehouseName:text(raw?.warehouse_name),
      available:0,transit:0,requested:0,valid:0,waitingDocs:0,other:0
    };
    // API can repeat cluster metrics for several warehouses. Stock buckets are
    // warehouse-specific; duplicate rows for one warehouse must not multiply them.
    prev.available=Math.max(prev.available,Math.max(0,num(raw?.available_stock_count)));
    prev.transit=Math.max(prev.transit,Math.max(0,num(raw?.transit_stock_count)));
    prev.requested=Math.max(prev.requested,Math.max(0,num(raw?.requested_stock_count)));
    prev.valid=Math.max(prev.valid,Math.max(0,num(raw?.valid_stock_count)));
    prev.waitingDocs=Math.max(prev.waitingDocs,Math.max(0,num(raw?.waiting_docs_stock_count)));
    prev.other=Math.max(prev.other,Math.max(0,num(raw?.other_stock_count)));
    group.warehouses.set(wKey,prev);
  });
  return [...groups.values()].map(group=>{
    const warehouses=[...group.warehouses.values()];
    const sum=field=>warehouses.reduce((total,row)=>total+Math.max(0,num(row[field])),0);
    const available=sum('available');
    const transit=sum('transit');
    const requested=sum('requested');
    const valid=sum('valid');
    const waitingDocs=sum('waitingDocs');
    const other=sum('other');
    const incomingKnown=transit+requested+valid;
    return {
      sku:group.sku,
      offerId:group.offerId,
      name:group.name,
      clusterId:group.clusterId,
      clusterName:group.clusterName,
      adsCluster:group.adsCluster,
      idcCluster:group.idcCluster,
      daysWithoutSalesCluster:group.daysWithoutSalesCluster,
      turnoverGradeCluster:group.turnoverGradeCluster,
      available,transit,requested,valid,waitingDocs,other,incomingKnown,
      warehouses:warehouses.map(row=>({
        warehouseId:row.warehouseId,
        warehouseName:row.warehouseName,
        available:row.available,
        transit:row.transit,
        requested:row.requested,
        valid:row.valid
      }))
    };
  }).sort((a,b)=>a.name.localeCompare(b.name,'ru')||a.clusterName.localeCompare(b.clusterName,'ru'));
}

export function estimateOzonLeadTimes(supplyOrders=[]){
  const warehouseSamples=new Map();
  const globalSamples=[];
  for(const order of Array.isArray(supplyOrders)?supplyOrders:[]){
    if(text(order?.state)!=='COMPLETED')continue;
    const started=Date.parse(order?.created_date||order?.created_at||'');
    const completed=Date.parse(order?.state_updated_date||'');
    if(!Number.isFinite(started)||!Number.isFinite(completed)||completed<=started)continue;
    const days=(completed-started)/DAY_MS;
    if(days<0.25||days>45)continue;
    globalSamples.push(days);
    for(const supply of order?.supplies||[]){
      const warehouseId=text(supply?.storage_warehouse?.warehouse_id);
      if(!warehouseId)continue;
      if(!warehouseSamples.has(warehouseId))warehouseSamples.set(warehouseId,[]);
      warehouseSamples.get(warehouseId).push(days);
    }
  }
  const globalMedian=globalSamples.length>=3?median(globalSamples):null;
  const byWarehouse={};
  for(const [warehouseId,samples] of warehouseSamples){
    const value=samples.length>=2?median(samples):null;
    if(value!==null)byWarehouse[warehouseId]={leadDays:Math.max(1,Math.ceil(value)),samples:samples.length,source:'warehouse-history'};
  }
  return {
    global:globalMedian===null?null:{leadDays:Math.max(1,Math.ceil(globalMedian)),samples:globalSamples.length,source:'global-history'},
    byWarehouse
  };
}

function leadForRow(row,leadTimes){
  const values=[];
  let samples=0;
  for(const warehouse of row?.warehouses||[]){
    const hit=leadTimes?.byWarehouse?.[text(warehouse?.warehouseId)];
    if(hit?.leadDays>0){values.push(hit.leadDays);samples+=Number(hit.samples||0);}
  }
  if(values.length){
    return {leadDays:Math.max(...values),samples,source:'warehouse-history'};
  }
  if(leadTimes?.global?.leadDays>0)return leadTimes.global;
  return null;
}

export function buildOzonReplenishmentRows(items=[],supplyOrders=[],options={}){
  const targetDays=Math.max(1,Math.min(60,Math.trunc(Number(options.targetDays)||14)));
  const now=Number(options.now)||Date.now();
  const normalized=normalizeOzonClusterAnalytics(items);
  const leadTimes=estimateOzonLeadTimes(supplyOrders);
  return normalized.map(row=>{
    const daily=Math.max(0,num(row.adsCluster));
    const available=Math.max(0,num(row.available));
    const incoming=Math.max(0,num(row.incomingKnown));
    const coverageQty=available+incoming;
    const ozonIdc=Number(row.idcCluster);
    const daysLeft=Number.isFinite(ozonIdc)&&ozonIdc>=0?ozonIdc:(daily>0?available/daily:null);
    const daysWithIncoming=daily>0?coverageQty/daily:null;
    const targetQty=daily>0?Math.ceil(daily*targetDays):0;
    const shortageNow=daily>0?Math.max(0,Math.ceil(targetQty-coverageQty)):0;
    const lead=leadForRow(row,leadTimes);
    let sendQty=null,sendAt=null,remainingAtArrival=null,reason='';
    if(!(daily>0)){
      reason='Нет среднесуточных продаж по кластеру';
    }else if(!lead){
      reason='Срок поставки ещё не подтверждён историей';
    }else{
      const leadDays=Math.max(1,Number(lead.leadDays)||1);
      const daysUntilSend=Math.max(0,(daysWithIncoming??0)-leadDays);
      sendAt=now+Math.floor(daysUntilSend*DAY_MS);
      const arrivalDays=daysUntilSend+leadDays;
      remainingAtArrival=Math.max(0,coverageQty-daily*arrivalDays);
      sendQty=Math.max(0,Math.ceil(targetQty-remainingAtArrival));
      if(sendQty===0)reason='Запаса с учётом поставок достаточно';
    }
    return {
      ...row,
      targetDays,
      dailySales:daily,
      daysLeft,
      daysWithIncoming,
      targetQty,
      shortageNow,
      leadDays:lead?.leadDays??null,
      leadSamples:lead?.samples??0,
      leadSource:lead?.source??'',
      remainingAtArrival,
      sendQty,
      sendAt,
      exact:Boolean(lead&&daily>0),
      reason
    };
  });
}

export function mergeAnalyticsCycleRows(previous=[],incoming=[]){
  const byKey=new Map();
  for(const row of [...(Array.isArray(previous)?previous:[]),...(Array.isArray(incoming)?incoming:[])]){
    const key=[text(row?.sku),text(row?.cluster_id),text(row?.warehouse_id),text(row?.offer_id)].join('|');
    if(!text(row?.sku)||!text(row?.cluster_id))continue;
    byKey.set(key,row);
  }
  return [...byKey.values()];
}
