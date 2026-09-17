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

try{
  if(typeof financialSales==='function'){
    const baseFinancialSales=financialSales;
    let cachedFinancialSales=null,cachedFinancialSalesAt=0;
    financialSales=function(){
      const now=Date.now();
      if(cachedFinancialSales&&now-cachedFinancialSalesAt<2000)return cachedFinancialSales;
      cachedFinancialSales=baseFinancialSales();
      cachedFinancialSalesAt=now;
      return cachedFinancialSales;
    };
  }
}catch(error){console.warn('WB report sales cache hook failed',error);}

const wbReportApiCache=new Map();
try{
  if(typeof apiJson==='function'){
    const baseApiJson=apiJson;
    apiJson=async function(url){
      const key=String(url||'');
      const cacheable=key.includes('/api/wb-finance-summary')||key.includes('/api/wb-finance-products')||key.includes('/api/wb-dashboard-buyouts');
      if(!cacheable)return baseApiJson(url);
      const old=wbReportApiCache.get(key),now=Date.now();
      if(old?.data&&now-old.at<5000)return old.data;
      if(old?.promise)return old.promise;
      const promise=baseApiJson(url).then(data=>{wbReportApiCache.set(key,{at:Date.now(),data});return data;}).catch(error=>{wbReportApiCache.delete(key);throw error;});
      wbReportApiCache.set(key,{at:now,promise});
      return promise;
    };
  }
}catch(error){console.warn('WB report API cache hook failed',error);}

function uiOnlyCall(fn,args){
  if(typeof fn!=='function')return;
  const originalSave=window.save;
  try{if(typeof originalSave==='function')window.save=()=>true;return fn.apply(window,args);}
  finally{if(typeof originalSave==='function')window.save=originalSave;}
}
try{
  if(typeof window.setReportPeriod==='function'){
    const baseSetReportPeriod=window.setReportPeriod;
    window.setReportPeriod=function(){return uiOnlyCall(baseSetReportPeriod,arguments)};
  }
  if(typeof window.setReportMarket==='function'){
    const baseSetReportMarket=window.setReportMarket;
    window.setReportMarket=function(){return uiOnlyCall(baseSetReportMarket,arguments)};
  }
}catch(error){console.warn('Report UI save isolation hook failed',error);}

function wbMoney(value){return typeof fmt==='function'?fmt(Number(value)||0):new Intl.NumberFormat('ru-RU',{maximumFractionDigits:0}).format(Number(value)||0)+' ₸';}
function wbPaintFreshHeader(market){
  document.querySelectorAll('[data-report-market]').forEach(b=>b.classList.toggle('active',b.dataset.reportMarket===market));
  const title=document.getElementById('reportMarketTitle');if(title)title.textContent=market==='WB2'?'WB 2':'WB 1';
  const fees=document.getElementById('rFeesLabel');if(fees)fees.textContent='Расходы WB';
  const ads=document.getElementById('rAdsLabel');if(ads)ads.textContent='Реклама WB';
}
function wbFreshCost(market,days,dashboard){
  try{
    if(typeof wbLiveRealizedCostSummary==='function')return wbLiveRealizedCostSummary(market,days,dashboard);
    if(typeof wbLiveRealizedCost==='function')return {cost:Number(wbLiveRealizedCost(market,days,dashboard))||0,complete:false};
  }catch(error){console.warn('WB live cost fallback',error);}
  return {cost:0,complete:false};
}
function wbRenderFresh(market,days,summary,dashboard){
  wbPaintFreshHeader(market);
  const revenue=Number(dashboard?.buyoutSum)||0,qty=Number(dashboard?.buyoutCount)||0,ads=Number(summary?.advertising)||0,costInfo=wbFreshCost(market,days,dashboard),cost=Number(costInfo.cost)||0;
  const set=(id,value)=>{const el=document.getElementById(id);if(el)el.textContent=value;};
  set('rRevenue',wbMoney(revenue));
  set('rCost',costInfo.complete?wbMoney(cost):('≈ '+wbMoney(cost)));
  set('rFees','—');
  set('rAds',wbMoney(ads));
  set('rProfit','—');
  document.getElementById('reportConfidence')?.remove();
  const box=document.getElementById('mpReport'),name=market==='WB2'?'WB 2':'WB 1';
  if(box)box.innerHTML='<div class="item"><div class="row"><div class="grow"><b>'+name+' · свежие выкупы</b><div class="muted">'+qty+' шт. · данные WB Analytics</div></div><b>'+wbMoney(revenue)+'</b></div></div><div class="link-note"><b>Свежий период.</b> Продажи, себестоимость и реклама уже показаны. Комиссия, логистика и чистая прибыль появятся после того, как WB сформирует финансовый отчёт реализации за эти продажи.</div>';
}

try{
  if(typeof window.renderReports==='function'){
    const baseRenderReports=window.renderReports;
    let wbFreshSeq=0;
    window.renderReports=function(){
      const market=String(state?.settings?.reportMarket||''),days=Number(typeof reportPeriod!=='undefined'?reportPeriod:30);
      if(!/^WB2?$/.test(market)||days===0)return baseRenderReports.apply(this,arguments);
      const seq=++wbFreshSeq;
      wbPaintFreshHeader(market);
      for(const id of ['rRevenue','rCost','rFees','rAds','rProfit']){const el=document.getElementById(id);if(el)el.textContent='…';}
      const box=document.getElementById('mpReport');if(box)box.innerHTML='<div class="empty">Загружаю отчёт '+(market==='WB2'?'WB 2':'WB 1')+'…</div>';
      const q='?market='+encodeURIComponent(market)+'&days='+encodeURIComponent(days);
      Promise.all([
        apiJson(MILLIONER_API+'/api/wb-finance-summary'+q),
        apiJson(MILLIONER_API+'/api/wb-dashboard-buyouts'+q).catch(()=>null)
      ]).then(([summary,dashboard])=>{
        if(seq!==wbFreshSeq||String(state?.settings?.reportMarket||'')!==market||Number(reportPeriod)!==days)return;
        if(summary?.financeAvailable===true||Number(summary?.financeRowCount||0)>0){baseRenderReports.call(window);return;}
        if(dashboard?.ok&&dashboard?.available){wbRenderFresh(market,days,summary,dashboard);return;}
        baseRenderReports.call(window);
      }).catch(()=>{if(seq===wbFreshSeq)baseRenderReports.call(window);});
      return undefined;
    };
  }
  if(typeof window.refreshWbFinance==='function'){
    const baseRefreshWbFinance=window.refreshWbFinance;
    window.refreshWbFinance=function(){wbReportApiCache.clear();return baseRefreshWbFinance.apply(this,arguments)};
  }
}catch(error){console.warn('WB report rendering hook failed',error);}

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
  const el=document.getElementById('ozonTopStatus');if(!el)return;
  el.textContent=new Date(ozonLastFullSync).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'});
}
async function refreshOzonSyncTime(){
  try{const payload=await apiJson(MILLIONER_API+'/api/ozon-fbo');const stamp=ozonFullSyncFromPayload(payload);if(stamp)ozonLastFullSync=stamp;paintOzonSyncTime();}catch{}
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
