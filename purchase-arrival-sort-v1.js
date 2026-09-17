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

// WB reports used to rebuild all marketplace sales once per product while calculating
// FIFO cost. On a phone this can keep the report in the loading state even though the
// API requests have already finished. Reuse the same immutable result during one render.
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
}catch(error){
  console.warn('WB report sales cache hook failed',error);
}

// The report APIs are read-only and frequently requested again by UI redraws. Deduplicate
// identical calls briefly so a redraw cannot start another pair before the current model
// has painted. Manual WB refresh clears this cache before fetching fresh finance data.
const wbReportApiCache=new Map();
try{
  if(typeof apiJson==='function'){
    const baseApiJson=apiJson;
    apiJson=async function(url){
      const key=String(url||'');
      const cacheable=key.includes('/api/wb-finance-summary')||key.includes('/api/wb-finance-products');
      if(!cacheable)return baseApiJson(url);
      const old=wbReportApiCache.get(key),now=Date.now();
      if(old?.data&&now-old.at<5000)return old.data;
      if(old?.promise)return old.promise;
      const promise=baseApiJson(url).then(data=>{
        wbReportApiCache.set(key,{at:Date.now(),data});
        return data;
      }).catch(error=>{
        wbReportApiCache.delete(key);
        throw error;
      });
      wbReportApiCache.set(key,{at:now,promise});
      return promise;
    };
  }
}catch(error){
  console.warn('WB report API cache hook failed',error);
}

// Report market/period are UI preferences. Do not serialize and PUT the whole warehouse
// snapshot every time the user taps Today / Yesterday / 7 days / 30 days.
function uiOnlyCall(fn,args){
  if(typeof fn!=='function')return;
  const originalSave=window.save;
  try{
    if(typeof originalSave==='function')window.save=()=>true;
    return fn.apply(window,args);
  }finally{
    if(typeof originalSave==='function')window.save=originalSave;
  }
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
}catch(error){
  console.warn('Report UI save isolation hook failed',error);
}

// The shared loader text was Kaspi-specific even on WB tabs. Keep it market-specific.
try{
  if(typeof window.renderReports==='function'){
    const baseRenderReports=window.renderReports;
    window.renderReports=function(){
      const result=baseRenderReports.apply(this,arguments);
      const market=String(state?.settings?.reportMarket||'');
      const box=document.getElementById('mpReport');
      if(box&&/^WB2?$/.test(market)&&box.textContent.includes('Kaspi')){
        box.innerHTML='<div class="empty">Загружаю отчёт '+(market==='WB2'?'WB 2':'WB 1')+'…</div>';
      }
      return result;
    };
  }
  if(typeof window.refreshWbFinance==='function'){
    const baseRefreshWbFinance=window.refreshWbFinance;
    window.refreshWbFinance=function(){wbReportApiCache.clear();return baseRefreshWbFinance.apply(this,arguments)};
  }
}catch(error){
  console.warn('WB report rendering hook failed',error);
}

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
