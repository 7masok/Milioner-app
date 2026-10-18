(function(){
'use strict';
if(typeof window==='undefined')return;

const BUSINESS_SUPPORTED_MARKETS=new Set(['Kaspi','WB','WB2','Ozon']);
const BUSINESS_PERIODS=new Set(['day','week','month','year']);
const BUSINESS_WEEKDAYS=['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];
const BUSINESS_METRICS=new Set(['orders','buyouts','orderProfit','buyoutProfit']);
const BUSINESS_UI_KEY='milioner_business_dashboard_v1';
const BUSINESS_DAY_HISTORY=7;
const BUSINESS_WEEK_HISTORY=5;
const BUSINESS_MONTH_HISTORY=3;
const BUSINESS_YEAR_HISTORY=2;
const BUSINESS_MONTH_NAMES=['янв','фев','мар','апр','май','июн','июл','авг','сен','окт','ноя','дек'];
const BUSINESS_CACHE_VERSION='calendar-v2',BUSINESS_CACHE_KEY='milioner_business_snapshots_calendar_v2';
const businessModelMeta=new Map(),businessBuildJobs=new Map();let businessCacheHydrated=false;
let businessRenderSeq=0,businessSummaryCache=new Map(),businessLastModel=null;
let businessPeriod='day',businessMetric='orders',businessModels=new Map(),businessDayDate='',businessWeekDate='',businessMonthDate='',businessYearDate='',businessWeekOrderCache=new Map();
try{
 const saved=JSON.parse(localStorage.getItem(BUSINESS_UI_KEY)||'{}');
 businessPeriod=saved.period==='week'||saved.period==='month'||saved.period==='year'?saved.period:'day';
 if(saved.metric==='netProfit')businessMetric='buyoutProfit';
 else if(BUSINESS_METRICS.has(saved.metric))businessMetric=saved.metric;
 if(/^\d{4}-\d{2}-\d{2}$/.test(saved.dayDate||''))businessDayDate=saved.dayDate;
 if(/^\d{4}-\d{2}-\d{2}$/.test(saved.weekDate||''))businessWeekDate=saved.weekDate;
 if(/^\d{4}-\d{2}-01$/.test(saved.monthDate||''))businessMonthDate=saved.monthDate;
 if(/^\d{4}-01-01$/.test(saved.yearDate||''))businessYearDate=saved.yearDate;
}catch(_){}

function businessSaveUi(){
 try{localStorage.setItem(BUSINESS_UI_KEY,JSON.stringify({period:businessPeriod,metric:businessMetric,dayDate:businessDayDate,weekDate:businessWeekDate,monthDate:businessMonthDate,yearDate:businessYearDate}))}catch(_){}
}
function businessRemoveLegacyStoreNote(){
 const root=document.getElementById('reports');if(!root)return;
 for(const el of root.querySelectorAll('.muted,.link-note,p')){
  const text=String(el.textContent||'').replace(/\s+/g,' ').trim().toLowerCase();
  if(text.includes('часть себестоимости не определена')||text.includes('налоги, аренда, зарплаты'))el.remove();
 }
}
let businessLegacyNoteObserver=null;
function businessInstallLegacyNoteCleanup(){
 const root=document.getElementById('reports');if(!root)return;
 businessRemoveLegacyStoreNote();
 if(businessLegacyNoteObserver)return;
 businessLegacyNoteObserver=new MutationObserver(()=>businessRemoveLegacyStoreNote());
 businessLegacyNoteObserver.observe(root,{childList:true,subtree:true});
}
function businessDayStart(date=new Date()){const d=new Date(date);d.setHours(0,0,0,0);return d}
function businessDayBounds(offset=0){
 const start=Date.parse(businessIsoDate(Date.now())+'T00:00:00+05:00')+Number(offset||0)*86400000;
 return {start,end:start+86400000,days:offset===-1?-1:offset===0?1:0,label:offset===0?'Сегодня':offset===-1?'Вчера':businessShortDate(start)};
}
function businessSelectedDayOffset(){
 const selected=Date.parse(businessDayDate+'T00:00:00+05:00');
 return Number.isFinite(selected)?Math.max(-BUSINESS_DAY_HISTORY,Math.min(0,Math.round((selected-businessDayBounds(0).start)/86400000))):0;
}
function businessSelectedWeekOffset(){
 const selected=Date.parse(businessWeekDate+'T00:00:00+05:00');
 return Number.isFinite(selected)?Math.max(-BUSINESS_WEEK_HISTORY,Math.min(0,Math.floor((selected-businessWeekBounds(0).start)/(7*86400000)))):0;
}
function businessSelectedMonthOffset(){const selected=Date.parse(businessMonthDate+'T00:00:00+05:00');if(!Number.isFinite(selected))return 0;const a=new Date(selected+5*3600000),b=new Date(businessMonthBounds(0).start+5*3600000);return Math.max(-BUSINESS_MONTH_HISTORY,Math.min(0,(a.getUTCFullYear()-b.getUTCFullYear())*12+a.getUTCMonth()-b.getUTCMonth()))}
function businessSelectedYearOffset(){const selected=Number(businessYearDate.slice(0,4)),current=new Date(businessYearBounds(0).start+18000000).getUTCFullYear();return selected?Math.max(-BUSINESS_YEAR_HISTORY,Math.min(0,selected-current)):0}
function businessBounds(period,offset=0){return period==='year'?businessYearBounds(offset):period==='month'?businessMonthBounds(offset):period==='week'?businessWeekBounds(offset):businessDayBounds(offset)}
function businessSelectedOffset(period=businessPeriod){return period==='year'?businessSelectedYearOffset():period==='month'?businessSelectedMonthOffset():period==='week'?businessSelectedWeekOffset():businessSelectedDayOffset()}
function businessModelKey(period=businessPeriod,offset=businessSelectedOffset(period)){
 const bounds=businessBounds(period,offset);
 return period+':'+bounds.start;
}
function businessPeriodBounds(){return businessBounds(businessPeriod,businessSelectedOffset())}
const businessDateFormatter=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Almaty',year:'numeric',month:'2-digit',day:'2-digit'});
function businessIsoDate(ts){const parts=businessDateFormatter.formatToParts(new Date(ts)),part=type=>parts.find(x=>x.type===type)?.value;return part('year')+'-'+part('month')+'-'+part('day')}
function businessWeekStart(which=0){
 const today=businessDayBounds(0).start,mondayOffset=(new Date(today+5*3600000).getUTCDay()+6)%7;
 return new Date(today-mondayOffset*86400000+Number(which||0)*7*86400000);
}
function businessWeekBounds(which=0){
 const start=businessWeekStart(which).getTime();
 return {start,end:start+7*86400000,days:7,label:which===0?'Эта неделя':'Вся неделя'};
}
function businessMonthStart(which=0){const local=new Date(businessDayBounds(0).start+5*3600000);return new Date(Date.UTC(local.getUTCFullYear(),local.getUTCMonth()+Number(which||0),1)-5*3600000)}
function businessMonthBounds(which=0){
 const start=businessMonthStart(which).getTime(),local=new Date(start+5*3600000),end=Date.UTC(local.getUTCFullYear(),local.getUTCMonth()+1,1)-5*3600000;
 return {start,end,days:Math.round((end-start)/86400000),label:which===0?'Этот месяц':'Весь месяц'};
}
function businessYearBounds(which=0){const year=new Date(businessDayBounds(0).start+18000000).getUTCFullYear()+Number(which||0),start=Date.UTC(year,0,1)-18000000,end=Date.UTC(year+1,0,1)-18000000;return{start,end,days:Math.round((end-start)/86400000),label:which===0?'Этот год':'Весь год'}}
function businessEmptyBucket(start,end,label){return {start,end,label,orders:0,orderQty:0,orderProfit:0,buyouts:0,buyoutQty:0,buyoutBaseProfit:0,buyoutProfit:0,coreBuyouts:0,coreBuyoutQty:0,coreBuyoutBaseProfit:0,coreBuyoutProfit:0,ozonBuyouts:0,ozonBuyoutQty:0,ozonBuyoutBaseProfit:0,ozonBuyoutProfit:0,netProfit:0}}
function businessBuckets(period,bounds){
 const rows=[];
 if(period==='year'){const year=new Date(bounds.start+18000000).getUTCFullYear();for(let i=0;i<12;i++)rows.push(businessEmptyBucket(Date.UTC(year,i,1)-18000000,Date.UTC(year,i+1,1)-18000000,BUSINESS_MONTH_NAMES[i]));return rows}
 if(period==='week'){for(let i=0;i<7;i++){const s=bounds.start+i*86400000;rows.push(businessEmptyBucket(s,s+86400000,BUSINESS_WEEKDAYS[i]))}return rows}
 if(period==='month'){for(let t=bounds.start,i=1;t<bounds.end;t+=86400000,i++)rows.push(businessEmptyBucket(t,t+86400000,String(i)));return rows}
 for(let h=0;h<24;h++){const s=bounds.start+h*3600000;rows.push(businessEmptyBucket(s,s+3600000,String(h).padStart(2,'0')))}
 return rows;
}
function businessBucketFor(rows,ts){return rows.find(x=>ts>=x.start&&ts<x.end)||null}
function businessLineAmount(line,qty=Math.max(0,Number(line?.qty)||0)){
 const total=Math.max(0,Number(line?.totalPrice)||0);if(total>0)return total;
 return qty*Math.max(0,Number(line?.unitPrice)||0);
}
function businessOrderGroups(bounds,history=null){
 const feed=history||[
  ...(state?.kaspiOrderFeed||[]).map(x=>({...x,market:String(x?.market||'Kaspi')})),
  ...(state?.wbOrderFeed||[]).map(x=>({...x,market:String(x?.market||'WB')})),
  ...(state?.ozonOrderFeed||[]).map(x=>({...x,market:'Ozon'}))
 ];
 return groupMarketplaceOrders(feed).filter(g=>{
  const market=String(g?.market||'');if(!BUSINESS_SUPPORTED_MARKETS.has(market))return false;
  const ts=Number(g?.creationDate)||0;if(!(ts>=bounds.start&&ts<bounds.end))return false;
  if(market==='Ozon')return !/cancel/.test(String(g?.status||g?.state||'').toLowerCase());
  return marketplaceLifecycleStage(market,g?.status,g?.state)!=='cancelled';
 });
}
function businessEstimateOrders(groups,buckets,unitMap){
 let amount=0,qty=0,profit=0,coveredAmount=0,coveredQty=0,orderCount=groups.length;
 for(const g of groups){
  const market=String(g.market||'');
  for(const line of g.lines||[]){
   if(typeof isPendingMarketplaceLine==='function'&&isPendingMarketplaceLine(line))continue;
   const q=Math.max(0,Number(line?.qty)||0);if(!q)continue;
   const lineAmount=businessLineAmount(line,q),bucket=businessBucketFor(buckets,Number(g.creationDate)||0);
   qty+=q;amount+=lineAmount;if(bucket){bucket.orders+=lineAmount;bucket.orderQty+=q}
   const pid=String(line?.productId||''),stats=pid&&unitMap instanceof Map?unitMap.get(pid):null,source=stats?.sources?.[market];
   let unitProfit=NaN;
   if(source&&Number(source.qty)>0)unitProfit=Number(source.profit)/Number(source.qty);
   else if(stats&&Number(stats.qty)>0)unitProfit=Number(stats.unitProfit);
   if(Number.isFinite(unitProfit)){
    const p=q*unitProfit;profit+=p;coveredAmount+=lineAmount;coveredQty+=q;if(bucket)bucket.orderProfit+=p;
   }
  }
 }
 return {amount,qty,profit,coveredAmount,coveredQty,orderCount,coverage:amount>0?coveredAmount/amount:1};
}
function businessUnitProfit(unitMap,pid,market){
 const stats=pid&&unitMap instanceof Map?unitMap.get(String(pid)):null,source=stats?.sources?.[market];
 if(source&&Number(source.qty)>0)return Number(source.profit)/Number(source.qty);
 if(stats&&Number(stats.qty)>0)return Number(stats.unitProfit);
 return NaN;
}
function businessLocalBuyouts(bounds,buckets,unitMap,preparedSales=null){
 const rows=(preparedSales||(typeof financialSales==='function'?financialSales():[])).filter(s=>{
  const market=String(s?.channel||'');
  return market!=='Ozon'&&BUSINESS_SUPPORTED_MARKETS.has(market)&&Number(s?.date)>=bounds.start&&Number(s?.date)<bounds.end;
 });
 const core={revenue:0,qty:0,baseProfit:0},ozon={revenue:0,qty:0,baseProfit:0};
 for(const sale of rows){
  const q=Math.max(0,Number(sale?.qty)||0);if(!q)continue;
  const r=q*Math.max(0,Number(sale?.price)||0),p=q*((Number(sale?.price)||0)-(Number(sale?.cost)||0)-(Number(sale?.fee)||0)),bucket=businessBucketFor(buckets,Number(sale.date)||0);
  core.revenue+=r;core.qty+=q;core.baseProfit+=p;
  if(bucket){bucket.coreBuyouts+=r;bucket.coreBuyoutQty+=q;bucket.coreBuyoutBaseProfit+=p}
 }
 for(const line of state?.ozonOrderFeed||[]){
  if(String(line?.status||'').toLowerCase()!=='delivered')continue;
  const ts=Number(line?.deliveredDate)||0;if(!(ts>=bounds.start&&ts<bounds.end))continue;
  const q=Math.max(0,Number(line?.qty)||0);if(!q)continue;
  const r=businessLineAmount(line,q),unitProfit=businessUnitProfit(unitMap,line?.productId,'Ozon'),
    p=Number.isFinite(unitProfit)?q*unitProfit:0,bucket=businessBucketFor(buckets,ts);
  ozon.revenue+=r;ozon.qty+=q;ozon.baseProfit+=p;
  if(bucket){bucket.ozonBuyouts+=r;bucket.ozonBuyoutQty+=q;bucket.ozonBuyoutBaseProfit+=p}
 }
 return {core,ozon,revenue:core.revenue+ozon.revenue,qty:core.qty+ozon.qty,baseProfit:core.baseProfit+ozon.baseProfit};
}
function businessSummaryPart(summary,markets){
 const sources=summary?.sources||{};let revenue=0,profit=0,profitKnown=true,found=false;
 for(const market of markets){
  const source=sources[market];if(!source)continue;found=true;revenue+=Number(source.revenue)||0;
  if(source.profit===null||source.profit===undefined||!Number.isFinite(Number(source.profit)))profitKnown=false;
  else profit+=Number(source.profit)||0;
 }
 return {revenue,profit:found&&profitKnown?profit:null};
}
function businessNormalizeBuyoutPart(buckets,local,exact,revenueField,baseProfitField,profitField,{fallbackToLast=false}={}){
 const exactRevenue=Number(exact?.revenue)||0,localRevenue=Number(local?.revenue)||0,baseProfit=Number(local?.baseProfit)||0,
  profitKnown=exact?.profit!==null&&exact?.profit!==undefined&&Number.isFinite(Number(exact.profit)),exactProfit=profitKnown?Number(exact.profit):baseProfit,
  revenueScale=localRevenue>0?exactRevenue/localRevenue:0,profitAdjustment=exactProfit-baseProfit;
 if(localRevenue>0){
  for(const b of buckets){const share=Math.max(0,Number(b[revenueField])||0)/localRevenue;b[revenueField]*=revenueScale;b[profitField]=(Number(b[baseProfitField])||0)+profitAdjustment*share}
 }else if(fallbackToLast&&buckets.length){
  buckets[buckets.length-1][revenueField]=exactRevenue;buckets[buckets.length-1][profitField]=exactProfit;
 }
}
function businessNormalizeBuyoutBuckets(buckets,local,summary){
 const coreExact=businessSummaryPart(summary,['Kaspi','WB','WB2']),ozonExact=businessSummaryPart(summary,['Ozon']);
 businessNormalizeBuyoutPart(buckets,local.core,coreExact,'coreBuyouts','coreBuyoutBaseProfit','coreBuyoutProfit',{fallbackToLast:true});
 businessNormalizeBuyoutPart(buckets,local.ozon,ozonExact,'ozonBuyouts','ozonBuyoutBaseProfit','ozonBuyoutProfit');
 for(const b of buckets){
  b.buyouts=(Number(b.coreBuyouts)||0)+(Number(b.ozonBuyouts)||0);
  b.buyoutQty=(Number(b.coreBuyoutQty)||0)+(Number(b.ozonBuyoutQty)||0);
  b.buyoutBaseProfit=(Number(b.coreBuyoutBaseProfit)||0)+(Number(b.ozonBuyoutBaseProfit)||0);
  b.buyoutProfit=(Number(b.coreBuyoutProfit)||0)+(Number(b.ozonBuyoutProfit)||0);
  b.netProfit=b.buyoutProfit;
 }
 return {ozonHourlyComplete:Math.abs(Number(ozonExact.revenue)||0)<0.005||Number(local?.ozon?.revenue)>0};
}
function businessMoney(value){const raw=Number(value),n=Number.isFinite(raw)&&Math.abs(raw)>=.005?raw:0;return typeof fmt==='function'?fmt(n):new Intl.NumberFormat('ru-RU',{maximumFractionDigits:0}).format(n)+' ₸'}
function businessMaybeMoney(value,estimated=false){if(value===null||value===undefined||!Number.isFinite(Number(value)))return '—';return (estimated?'≈ ':'')+businessMoney(value)}
function businessExpenseMoney(value,estimated=false){if(value===null||value===undefined||!Number.isFinite(Number(value)))return '—';const n=Math.abs(Number(value));return n<.005?businessMoney(0):(estimated?'≈ −':'−')+businessMoney(n)}
function businessMetricInfo(model){
 const ozonHourlyNote=model?.hourly?.ozonHourlyComplete===false?' · Ozon без точного часа выкупа':'',historyNote=model?.summary?.partialOzonHistory?' · неполная история Ozon':'';
 const map={
  orders:{label:'Заказы',value:model.orders.amount,meta:model.orders.qty.toLocaleString('ru-RU')+' шт. · '+model.orders.orderCount.toLocaleString('ru-RU')+' заказов',field:'orders'},
  buyouts:{label:'Выкупы',value:model.pending?null:model.summary.revenue,estimated:Boolean(model.summary.partialOzonHistory),incomplete:Boolean(model.summary.partialOzonHistory),meta:model.pending?'Финансовые данные загружаются…':Number(model.summary.qty||0).toLocaleString('ru-RU')+' шт.'+ozonHourlyNote+historyNote,field:'buyouts'},
  orderProfit:{label:'Прибыль с заказов · прогноз',value:model.orders.qty>0&&!(model.orders.coverage>0)?null:model.orders.profit,meta:'покрытие расчётом '+Math.round(model.orders.coverage*100)+'%',field:'orderProfit'},
  buyoutProfit:{label:'Прибыль с выкупов',value:model.pending?null:model.summary.profit,estimated:Boolean(model.summary.estimated),incomplete:Boolean(model.summary.partialOzonHistory),meta:(model.summary.estimated?'≈ по данным маркетплейсов':'по данным маркетплейсов')+ozonHourlyNote+historyNote,field:'buyoutProfit'}
 };
 const info=map[businessMetric]||map.orders;if(model.yearPartial){info.incomplete=true;info.estimated=true;info.meta+=' · неполный год: '+model.knownMonths+' из '+model.expectedMonths+' мес.'}return model.unavailable?{...info,value:null,meta:model.period==='year'?'Нет полной истории за этот год':'Нет полной истории для сравнения',incomplete:true}:info;
}
function businessEnsureStyle(){
 if(document.getElementById('businessDashboardStyle'))return;
 const style=document.createElement('style');style.id='businessDashboardStyle';style.textContent=`
 .business-dashboard{border:1px solid var(--line);border-radius:24px;padding:15px;margin:0 0 18px;background:var(--card);overflow:hidden}
 .business-top{display:flex;align-items:center;justify-content:space-between;gap:10px}.business-top h3{margin:0}.business-sub{font-size:12px;color:var(--muted);margin-top:3px}.business-periods{display:flex;gap:6px;align-items:center;flex-wrap:wrap;justify-content:flex-end}.business-periods button{border:1px solid var(--line);background:var(--bg);border-radius:12px;padding:8px 10px;font:inherit;font-size:13px}.business-periods button.active{background:#111;color:#fff;border-color:#111}
 .business-metrics{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:13px}.business-metrics button{min-width:0;border:1px solid var(--line);background:var(--bg);border-radius:14px;padding:9px 7px;font:inherit;font-size:13px;line-height:1.15}.business-metrics button.active{background:#111;color:#fff;border-color:#111}
 .business-value-card{margin-top:12px;padding:13px 14px;border-radius:18px;background:var(--bg)}.business-value-title{font-size:13px;color:var(--muted);margin-bottom:8px}.business-value-grid{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,.9fr);gap:18px;align-items:start}.business-value-side{min-width:0}.business-yesterday-side{text-align:right}.business-value-label{font-size:12px;color:var(--muted)}.business-value{font-size:28px;font-weight:800;margin-top:3px;white-space:nowrap}.business-yesterday-side .business-value{font-size:20px;color:#666}.business-value-meta{font-size:12px;color:var(--muted);margin-top:4px}.business-compare{font-size:12px;margin-top:9px;display:flex;gap:6px;align-items:center;flex-wrap:wrap}.business-compare-label{color:var(--muted)}.business-compare-delta{font-weight:700}.business-compare-delta.up{color:#138a55}.business-compare-delta.down{color:#b42318}.business-compare-delta.flat{color:var(--muted)}
 .business-day-nav{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:10px}.business-day-nav[hidden]{display:none}.business-day-nav button{min-width:44px;min-height:44px;border:1px solid var(--line);border-radius:12px;background:var(--bg);font:inherit;font-size:22px}.business-day-nav button:disabled{opacity:.35}.business-day-nav span{font-size:13px;text-align:center}.business-day-nav small{display:block;font-size:10px;color:var(--muted);margin-top:3px}
 .business-chart{margin-top:13px;touch-action:pan-y pinch-zoom}.business-chart-legend{display:flex;justify-content:flex-end;gap:12px;align-items:center;font-size:10px;color:var(--muted);margin:0 48px 5px 0}.business-legend-today,.business-legend-yesterday{display:inline-flex;align-items:center;gap:5px}.business-legend-today:before{content:'';width:8px;height:8px;border-radius:2px;background:#111;display:inline-block}.business-legend-yesterday:before{content:'';width:8px;height:8px;border-radius:2px;background:#d1d1d6;border-top:2px solid #9d9da3;box-sizing:border-box;display:inline-block}.business-chart-frame{display:grid;grid-template-columns:minmax(0,1fr) 48px;grid-template-rows:172px 25px;column-gap:4px;width:100%}
 .business-plot{position:relative;grid-column:1;grid-row:1;min-width:0;border-bottom:1px solid var(--line)}
 .business-grid-line{position:absolute;left:0;right:0;border-top:1px dashed var(--line);pointer-events:none}
 .business-bars{position:absolute;inset:0;display:grid;grid-template-columns:repeat(24,minmax(0,1fr));align-items:stretch}.business-bars.week{grid-template-columns:repeat(7,minmax(0,1fr))}
 .business-hour{position:relative;min-width:0}.business-yesterday-bar,.business-bar{position:absolute;left:24%;width:52%;min-height:1px}.business-yesterday-bar{border-radius:5px 5px 1px 1px;background:#d1d1d6;border-top:3px solid #9d9da3;box-sizing:border-box}.business-yesterday-bar.negative{border-radius:1px 1px 5px 5px;border-top:0;border-bottom:3px solid #9d9da3}.business-bar{border-radius:5px 5px 1px 1px;background:#111}.business-bar.negative{border-radius:1px 1px 5px 5px;background:#8d2222}
 .business-y-axis{grid-column:2;grid-row:1;position:relative;font-size:10px;color:var(--muted)}.business-y-tick{position:absolute;right:0;transform:translateY(50%);white-space:nowrap}
 .business-x-axis{grid-column:1;grid-row:2;position:relative;height:24px;padding-top:6px;font-size:9px;color:var(--muted)}.business-x-label{position:absolute;top:6px;white-space:nowrap;transform:translateX(-50%);text-align:center}
 .business-month-gap{position:absolute;bottom:3px;left:0;right:0;text-align:center;font-size:12px;color:var(--muted)}
 .business-axis-caption{grid-column:2;grid-row:2;font-size:9px;color:var(--muted);padding-top:6px;text-align:right}
 .business-detail-btn{border:1px solid var(--line);background:var(--bg);border-radius:12px;padding:8px 10px;font:inherit;white-space:nowrap}
 @media(max-width:560px){.business-dashboard{padding:12px;border-radius:20px}.business-value{font-size:25px}.business-chart-frame{grid-template-columns:minmax(0,1fr) 42px;grid-template-rows:158px 24px}.business-metrics button{font-size:12px;padding:8px 5px}.business-bar,.business-yesterday-bar{left:20%;width:60%}}
 `;document.head.appendChild(style);
}
function businessEnsureUi(){
 const reports=document.getElementById('reports');if(!reports)return null;let root=document.getElementById('businessDashboard');
 if(root){businessInstallDaySwipe();return root}businessEnsureStyle();root=document.createElement('div');root.id='businessDashboard';root.className='business-dashboard';
 root.innerHTML=`<div class="business-top"><div><h3 id="businessPeriodTitle">Сегодня</h3><div id="businessPeriodSub" class="business-sub">Kaspi + WB1 + WB2 + Ozon · по часам</div></div><div class="business-periods"><button type="button" data-business-period="day" onclick="setBusinessDashboardPeriod('day')">Сегодня</button><button type="button" data-business-period="week" onclick="setBusinessDashboardPeriod('week')">Неделя</button><button type="button" data-business-period="month" onclick="setBusinessDashboardPeriod('month')">Месяц</button><button type="button" data-business-period="year" onclick="setBusinessDashboardPeriod('year')">Год</button><button class="business-detail-btn" type="button" onclick="renderBusinessDashboard(true)">↻</button></div></div>
 <div class="business-metrics">${[['orders','Заказы'],['buyouts','Выкупы'],['orderProfit','Прибыль заказов'],['buyoutProfit','Прибыль выкупов']].map(([k,v])=>`<button type="button" data-business-metric="${k}" onclick="setBusinessDashboardMetric('${k}')">${v}</button>`).join('')}</div>
 <div id="businessDayNav" class="business-day-nav"><button id="businessDayPrevious" type="button" aria-label="Предыдущий день" onclick="shiftBusinessDashboardSelection(-1)">‹</button><span id="businessDayDate"></span><button id="businessDayNext" type="button" aria-label="Следующий день" onclick="shiftBusinessDashboardSelection(1)">›</button></div>
 <div class="business-value-card"><div id="businessValueMetric" class="business-value-title">Загрузка…</div><div class="business-value-grid"><div class="business-value-side"><div id="businessValueLabel" class="business-value-label">Сегодня</div><div id="businessValue" class="business-value">—</div><div id="businessValueMeta" class="business-value-meta"></div></div><div class="business-value-side business-yesterday-side"><div id="businessYesterdayLabel" class="business-value-label">Вчера</div><div id="businessYesterdayValue" class="business-value">—</div><div id="businessYesterdayMeta" class="business-value-meta"></div></div></div><div id="businessYesterdayCompare" class="business-compare"></div></div>
 <div id="businessChart" class="business-chart"></div><div id="businessCacheStatus" class="business-sub" aria-live="polite"></div><div id="businessFinanceHistory" class="business-sub" aria-live="polite"></div>`;
 const title=reports.querySelector('h2');if(title)title.insertAdjacentElement('afterend',root);else reports.prepend(root);businessInstallDaySwipe();return root;
}
let businessFinanceHistoryAt=0,businessFinanceHistoryLoading=false;
function businessFinanceHistoryText(rows){
 return (rows||[]).map(row=>{
  const name=row.market==='WB'?'WB1':row.market;
  const range=row.dateFrom&&row.dateTo?` (${row.dateFrom} — ${row.dateTo})`:'';
  if(row.status==='complete')return `${name}: финансовые отчёты за 365 дней загружены${range}`;
  if(row.status==='pending')return `${name}: финансовые отчёты за 365 дней ожидают загрузки`;
  const next=Number(row.nextAllowedAt)>Date.now()?` · продолжение после ${new Date(Number(row.nextAllowedAt)).toLocaleString('ru-RU',{timeZone:'Asia/Almaty',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}`:'';
  return `${name}: ${row.status==='retry'?'повтор загрузки':'загрузка'} финансовых отчётов за 365 дней · ${Number(row.rows)||0} строк${next}`;
 }).join(' · ');
}
async function businessLoadFinanceHistory(force=false){
 const el=document.getElementById('businessFinanceHistory');
 if(!el||typeof apiJson!=='function'||businessFinanceHistoryLoading||(!force&&Date.now()-businessFinanceHistoryAt<60000))return;
 businessFinanceHistoryLoading=true;
 try{
  const [finance,orders]=await Promise.allSettled([apiJson(MILLIONER_API+'/api/wb-finance-history'),apiJson(MILLIONER_API+'/api/wb-order-history')]);
  const parts=[finance.status==='fulfilled'?businessFinanceHistoryText(finance.value.markets):'Статус финансовых отчётов WB временно недоступен'];
  if(orders.status==='fulfilled')for(const row of orders.value.markets||[]){
   const name=row.market==='WB'?'WB1':row.market,date=row.from?new Date(row.from).toLocaleDateString('ru-RU',{timeZone:'Asia/Almaty'}):'';
   parts.push(name+': история заказов '+(row.status==='complete'?'загружена':row.status==='retry'?'ожидает повтора':'догружается')+' · '+Number(row.rows||0)+' заказов'+(date?' · проверено с '+date:'')+(row.error?' · '+row.error:''));
  }
  else parts.push('Статус истории заказов WB временно недоступен');
  el.textContent=parts.filter(Boolean).join(' · ');businessFinanceHistoryAt=Date.now();
 }catch{el.textContent='Статус загрузки истории WB временно недоступен'}
 finally{businessFinanceHistoryLoading=false}
}
function businessInstallDaySwipe(){
 const chart=document.getElementById('businessChart');if(!chart||chart.dataset.daySwipe==='1')return;chart.dataset.daySwipe='1';
 let gesture=null;
 chart.addEventListener('touchstart',event=>{gesture=null;if(!BUSINESS_PERIODS.has(businessPeriod)||event.touches.length!==1)return;const t=event.touches[0];gesture={id:t.identifier,x:t.clientX,y:t.clientY,vertical:false,key:businessModelKey()};},{passive:true});
 chart.addEventListener('touchmove',event=>{if(!gesture)return;if(event.touches.length!==1){gesture=null;return}const t=event.touches[0],dx=t.clientX-gesture.x,dy=t.clientY-gesture.y;if(Math.abs(dy)>12&&Math.abs(dy)>Math.abs(dx))gesture.vertical=true;if(!gesture.vertical&&Math.abs(dx)>12&&Math.abs(dx)>Math.abs(dy)*1.5&&event.cancelable)event.preventDefault();},{passive:false});
 chart.addEventListener('touchend',event=>{const start=gesture;gesture=null;if(!start||start.vertical||!BUSINESS_PERIODS.has(businessPeriod)||start.key!==businessModelKey()||event.touches.length)return;const t=Array.from(event.changedTouches).find(x=>x.identifier===start.id);if(!t)return;const dx=t.clientX-start.x,dy=t.clientY-start.y;if(Math.abs(dx)>=50&&Math.abs(dx)>Math.abs(dy)*1.5)window.shiftBusinessDashboardSelection(dx>0?-1:1);},{passive:true});
 chart.addEventListener('touchcancel',()=>{gesture=null;},{passive:true});
}
function businessPaintTabs(){
 document.querySelectorAll('[data-business-metric]').forEach(x=>x.classList.toggle('active',x.dataset.businessMetric===businessMetric));
 document.querySelectorAll('[data-business-period]').forEach(x=>x.classList.toggle('active',x.dataset.businessPeriod===businessPeriod));
 const title=document.getElementById('businessPeriodTitle'),sub=document.getElementById('businessPeriodSub');
 const year=businessPeriod==='year',week=businessPeriod==='week',month=businessPeriod==='month',offset=businessSelectedOffset(),bounds=businessPeriodBounds(),nav=document.getElementById('businessDayNav'),dayDate=document.getElementById('businessDayDate'),previous=document.getElementById('businessDayPrevious'),next=document.getElementById('businessDayNext');
 if(nav)nav.hidden=false;if(previous){previous.disabled=offset<=-(year?BUSINESS_YEAR_HISTORY:month?BUSINESS_MONTH_HISTORY:week?BUSINESS_WEEK_HISTORY:BUSINESS_DAY_HISTORY);previous.setAttribute('aria-label',year?'Предыдущий год':month?'Предыдущий месяц':week?'Предыдущая неделя':'Предыдущий день')}if(next){next.disabled=offset>=0;next.setAttribute('aria-label',year?'Следующий год':month?'Следующий месяц':week?'Следующая неделя':'Следующий день')}
 if(dayDate)dayDate.innerHTML=(year?new Date(bounds.start+18000000).getUTCFullYear()+' год':month?new Date(bounds.start).toLocaleDateString('ru-RU',{timeZone:'Asia/Almaty',month:'long',year:'numeric'}):week?businessShortDate(bounds.start)+' – '+businessShortDate(bounds.end-86400000)+' · '+(offset===0?'эта неделя':'вся неделя'):businessShortDate(bounds.start)+' · '+(offset===0?'сегодня':offset===-1?'вчера':'весь день'))+'<small>Свайп по графику ← →</small>';
 if(title)title.textContent=year?'Год':month?'Месяц':week?'Неделя':offset===0?'Сегодня':bounds.label;
 if(sub)sub.textContent=year?'Kaspi + WB1 + WB2 + Ozon · по месяцам':businessPeriod==='day'?'Kaspi + WB1 + WB2 + Ozon · по часам':'Kaspi + WB1 + WB2 + Ozon · по дням';
}
function businessNiceStep(raw){
 const n=Math.max(1e-9,Math.abs(Number(raw)||0)),pow=Math.pow(10,Math.floor(Math.log10(n))),f=n/pow;
 return (f<=1?1:f<=2?2:f<=5?5:10)*pow;
}
function businessChartScale(values){
 const min=Math.min(0,...values),max=Math.max(0,...values);
 if(min<0){
  const extent=Math.max(Math.abs(min),Math.abs(max),1),step=businessNiceStep(extent/2),limit=Math.max(step,Math.ceil(extent/step)*step);
  return {min:-limit,max:limit,ticks:[-limit,-limit/2,0,limit/2,limit]};
 }
 const step=businessNiceStep(Math.max(max,1)/3),top=Math.max(step,Math.ceil(Math.max(max,1)/step)*step),ticks=[];
 for(let v=0;v<=top+step*.001;v+=step)ticks.push(v);
 return {min:0,max:top,ticks:ticks.length>5?[0,top/3,top*2/3,top]:ticks};
}
function businessAxisNumber(value){
 const n=Number(value)||0,a=Math.abs(n);
 if(a>=1000000)return (n/1000000).toLocaleString('ru-RU',{maximumFractionDigits:1})+'м';
 if(a>=1000)return Math.round(n/1000).toLocaleString('ru-RU')+'к';
 return Math.round(n).toLocaleString('ru-RU');
}
function businessPaintChart(model,field){
 const box=document.getElementById('businessChart');if(!box)return;
 const year=model.period==='year',month=model.period==='month',week=model.period==='week',past=Number(model.dayOffset)<0,pastWeek=week&&Number(model.weekOffset)<0,pastMonth=month&&Number(model.monthOffset)<0,count=year?12:month?Math.max(model.buckets.length,model.yesterday?.buckets?.length||0):week?model.buckets.length:24,currentName=year?String(new Date(model.bounds.start+18000000).getUTCFullYear()):month?(pastMonth?businessShortDate(model.bounds.start):'этот'):week?(pastWeek?businessShortDate(model.bounds.start)+' – '+businessShortDate(model.bounds.end-86400000):'эта'):past?businessShortDate(model.bounds.start):'сегодня',previousName=year?String(new Date(model.yesterday.bounds.start+18000000).getUTCFullYear()):month?(pastMonth?businessShortDate(model.yesterday.bounds.start):'прошлый'):week?(pastWeek?businessShortDate(model.yesterday.bounds.start)+' – '+businessShortDate(model.yesterday.bounds.end-86400000):'прошлая'):past?businessShortDate(model.yesterday.bounds.start):'вчера';
 const values=model.buckets.map(x=>Number(x[field])||0),yesterdayValues=(model.yesterday?.unavailable?[]:model.yesterday?.buckets||[]).map(x=>Number(x[field])||0),scale=businessChartScale([...values,...yesterdayValues]),range=Math.max(1e-9,scale.max-scale.min),toPct=v=>(v-scale.min)/range*100,zeroPct=toPct(0);
 const lines=scale.ticks.map(v=>`<div class="business-grid-line" style="bottom:${toPct(v)}%"></div>`).join('');
 const ticks=scale.ticks.map(v=>`<div class="business-y-tick" style="bottom:${toPct(v)}%">${businessAxisNumber(v)}</div>`).join('');
 const bars=Array.from({length:count},(_,i)=>{
  const b=model.buckets[i]||{label:String(i+1)},v=Number(values[i])||0,yv=Number(yesterdayValues[i])||0,
    vPct=toPct(v),bottom=Math.min(vPct,zeroPct),height=Math.abs(vPct-zeroPct),
    yPct=toPct(yv),yBottom=Math.min(yPct,zeroPct),yHeight=Math.abs(yPct-zeroPct),
    sameSide=(v>=0&&yv>=0)||(v<=0&&yv<=0),
    equal=sameSide&&Math.abs(v-yv)<0.005,
    yesterdayShorter=sameSide&&!equal&&Math.abs(yv)<Math.abs(v),
    todayShorter=sameSide&&!equal&&Math.abs(v)<Math.abs(yv),
    todayZ=todayShorter||equal?3:2,yesterdayZ=yesterdayShorter?3:1,
    todayBottom=equal&&v<0?`calc(${bottom}% + 3px)`:`${bottom}%`,
    todayHeight=equal?`calc(${Math.max(0,height)}% - 3px)`:`${Math.max(v===0?0:1.2,height)}%`;
  const missing=x=>year&&(!x||x.unavailable||x.future||field==='buyouts'&&x.financeUnavailable||field==='buyoutProfit'&&x.profitUnavailable||field==='orderProfit'&&x.orderProfitUnavailable),currentMissing=missing(b),previousMissing=model.yesterday?.unavailable||missing(model.yesterday?.buckets?.[i]);
  const title=currentMissing?b.label+' · '+(b.future?'ещё не наступил':'нет полной истории'):previousMissing?b.label+' · '+currentName+' '+businessMoney(v):year||month?b.label+' · '+currentName+' '+businessMoney(v)+' · '+previousName+' '+businessMoney(yv):week?b.label+' · '+currentName+' '+businessMoney(v)+' · '+previousName+' '+businessMoney(yv):b.label+':00 · '+currentName+' '+businessMoney(v)+' · '+previousName+' '+businessMoney(yv);
  return `<div class="business-hour" title="${title}">${previousMissing?'':`<div class="business-yesterday-bar ${yv<0?'negative':''}" style="bottom:${yBottom}%;height:${Math.max(yv===0?0:1.2,yHeight)}%;z-index:${yesterdayZ}"></div>`}${currentMissing?(b.future?'':'<span class="business-month-gap" aria-label="Нет полной истории">—</span>'):`<div class="business-bar ${v<0?'negative':''}" style="bottom:${todayBottom};height:${todayHeight};z-index:${todayZ}"></div>`}</div>`;
 }).join('');
 const labels=year?BUSINESS_MONTH_NAMES.map((name,i)=>`<div class="business-x-label" style="left:${(i+.5)/12*100}%">${name}</div>`).join(''):month?[1,8,15,22,count].filter((d,i,all)=>d>=1&&d<=count&&all.indexOf(d)===i).map(d=>`<div class="business-x-label" style="left:${(d-.5)/count*100}%">${d}</div>`).join(''):week?BUSINESS_WEEKDAYS.map((name,i)=>`<div class="business-x-label" style="left:${(i+.5)/count*100}%">${name}</div>`).join(''):[3,6,9,12,15,18,21,24].map(h=>`<div class="business-x-label" style="left:${h===24?100:((h-.5)/24*100)}%">${String(h).padStart(2,'0')}</div>`).join('');
 box.innerHTML=`<div class="business-chart-legend"><span class="business-legend-today">${currentName}</span>${model.yesterday?.unavailable?'':`<span class="business-legend-yesterday">${previousName}</span>`}</div><div class="business-chart-frame"><div class="business-plot">${lines}<div class="business-bars${year?' year':month?' month':week?' week':''}"${month||year?' style="grid-template-columns:repeat('+count+',minmax(0,1fr))"':''}>${bars}</div></div><div class="business-y-axis">${ticks}</div><div class="business-x-axis">${labels}</div><div class="business-axis-caption">₸</div></div>`;
}

async function businessLoadSummary(days,force=false,range=null){
 const spec=days&&typeof days==='object'?days:{days,range},span=spec.range||null,key=span?'range:'+span.from+':'+span.to:String(spec.days),old=businessSummaryCache.get(key);
 if(!force&&old?.data&&Date.now()-Number(old.at||0)<60000)return old.data;if(old?.promise)return old.promise;
 if(typeof window.loadBusinessMarketplaceSummary!=='function')throw new Error('Финансовый модуль ещё не загрузился');
 const promise=window.loadBusinessMarketplaceSummary(span?0:spec.days,{force,range:span}).then(data=>{businessSummaryCache.set(key,{at:Date.now(),data});return data}).catch(e=>{businessSummaryCache.delete(key);throw e});
 businessSummaryCache.set(key,{at:Date.now(),promise});return promise;
}
async function businessBuildDaySnapshot(bounds,summaryDays,force=false){
 const buckets=businessBuckets('day',bounds),groups=businessOrderGroups(bounds),orders=businessEstimateOrders(groups,buckets,window.allMarketUnitProfit30),local=businessLocalBuyouts(bounds,buckets,window.allMarketUnitProfit30),summary=await businessLoadSummary(summaryDays,force),
  hourly=businessNormalizeBuyoutBuckets(buckets,local,summary);
 const netProfit=summary?.profit===null||summary?.profit===undefined||!Number.isFinite(Number(summary.profit))?null:Number(summary.profit);
 return {period:'day',bounds,buckets,orders,local,summary,netProfit,hourly};
}
function businessDaySummarySpec(offset,bounds){return offset===0?1:offset===-1?-1:{days:0,range:{from:businessIsoDate(bounds.start),to:businessIsoDate(bounds.start)}}}
function businessCopyBuyouts(target,sourceBuckets){
 const fields=['buyouts','buyoutQty','buyoutBaseProfit','buyoutProfit','coreBuyouts','coreBuyoutQty','coreBuyoutBaseProfit','coreBuyoutProfit','ozonBuyouts','ozonBuyoutQty','ozonBuyoutBaseProfit','ozonBuyoutProfit','netProfit'];
 for(const field of fields)target[field]=sourceBuckets.reduce((sum,bucket)=>sum+(Number(bucket[field])||0),0);
}
function businessCombineSummary(parts){
 const rows=parts.filter(Boolean);let revenue=0,qty=0,profit=0,profitKnown=true,estimated=false;
 for(const row of rows){revenue+=Number(row.revenue)||0;qty+=Number(row.qty)||0;if(row.profit===null||row.profit===undefined||!Number.isFinite(Number(row.profit)))profitKnown=false;else profit+=Number(row.profit);estimated=estimated||Boolean(row.estimated)}
 return {revenue:rows.some(r=>r.revenue===null)?null:revenue,qty:rows.some(r=>r.qty===null)?null:qty,profit:rows.length&&profitKnown?profit:null,estimated:estimated||!profitKnown,partialOzonHistory:rows.some(row=>row.partialOzonHistory)};
}
async function businessApplyRangeBuyouts(buckets,bounds,force){
 const range={from:businessIsoDate(bounds.start),to:businessIsoDate(bounds.end-86400000)},local=businessLocalBuyouts(bounds,buckets,window.allMarketUnitProfit30),summary=await businessLoadSummary(0,force,range),hourly=businessNormalizeBuyoutBuckets(buckets,local,summary);
 const partialOzonHistory=typeof window.ozonFboFinanceHistoryCovers==='function'&&!window.ozonFboFinanceHistoryCovers(bounds);
 return {local,summary:partialOzonHistory?{...summary,partialOzonHistory:true,estimated:true}:summary,hourly};
}
async function businessBuildCalendarSnapshot(period,which,force=false,todaySnapshot=null,history=null){
 const bounds=period==='month'?businessMonthBounds(which):businessWeekBounds(which),buckets=businessBuckets(period,bounds),todayStart=businessDayBounds(0).start,activeEnd=which===0?Math.min(bounds.end,todayStart+86400000):bounds.end,orders=businessEstimateOrders(businessOrderGroups({start:bounds.start,end:activeEnd},history),buckets,window.allMarketUnitProfit30);
 let summary,hourly={ozonHourlyComplete:true},local=null;
 if(which<0){const applied=await businessApplyRangeBuyouts(buckets,bounds,force);summary=applied.summary;hourly=applied.hourly;local=applied.local}
 else{
  const pastBuckets=buckets.filter(bucket=>bucket.end<=todayStart),parts=[];
  if(pastBuckets.length){const applied=await businessApplyRangeBuyouts(pastBuckets,{start:bounds.start,end:todayStart},force);parts.push(applied.summary);hourly=applied.hourly;local=applied.local}
  const today=todaySnapshot||await businessBuildDaySnapshot(businessDayBounds(0),1,force),todayBucket=buckets.find(bucket=>todayStart>=bucket.start&&todayStart<bucket.end);
  if(todayBucket)businessCopyBuyouts(todayBucket,today.buckets);
  parts.push(today.summary);summary=businessCombineSummary(parts);hourly={ozonHourlyComplete:hourly.ozonHourlyComplete!==false&&today.hourly?.ozonHourlyComplete!==false};
 }
 const netProfit=summary?.profit===null||summary?.profit===undefined||!Number.isFinite(Number(summary.profit))?null:Number(summary.profit);
 return {period,bounds,buckets,orders,local,summary,netProfit,hourly};
}
async function businessBuildWeekSnapshot(which,force=false,todaySnapshot=null,history=null){return businessBuildCalendarSnapshot('week',which,force,todaySnapshot,history)}
async function businessBuildMonthSnapshot(which,force=false,todaySnapshot=null,history=null){return businessBuildCalendarSnapshot('month',which,force,todaySnapshot,history)}
function businessElapsedTodayMs(){
 const start=businessDayBounds(0).start;
 return Math.max(0,Math.min(86400000,Date.now()-start));
}
function businessHourMinute(ts){
 return new Date(ts).toLocaleTimeString('ru-RU',{timeZone:'Asia/Almaty',hour:'2-digit',minute:'2-digit'});
}
function businessShortDate(ts){
 return new Date(ts).toLocaleDateString('ru-RU',{timeZone:'Asia/Almaty',day:'numeric',month:'short'}).replace(/\.$/,'');
}
function businessWeekdayName(ts){return BUSINESS_WEEKDAYS[(new Date(ts+5*3600000).getUTCDay()+6)%7]}
function businessCalendarSamePoint(fullSpan,period,history=null){
 const origin=period==='month'?businessMonthBounds(0).start:businessWeekStart(0).getTime(),elapsed=Math.max(0,Date.now()-origin),cutoff=Math.min(fullSpan.bounds.end,fullSpan.bounds.start+elapsed),
   orderBuckets=businessBuckets(period,fullSpan.bounds),orders=businessEstimateOrders(businessOrderGroups({start:fullSpan.bounds.start,end:cutoff},history),orderBuckets,window.allMarketUnitProfit30);
 let revenue=0,qty=0,profit=0;
 for(const bucket of fullSpan.buckets){const factor=cutoff<=bucket.start?0:cutoff>=bucket.end?1:(cutoff-bucket.start)/Math.max(1,bucket.end-bucket.start);revenue+=(Number(bucket.buyouts)||0)*factor;qty+=(Number(bucket.buyoutQty)||0)*factor;profit+=(Number(bucket.buyoutProfit)||0)*factor}
 const summary={...fullSpan.summary,revenue,qty:Math.round(qty),profit};
 return {...fullSpan,bounds:{...fullSpan.bounds,end:cutoff},orders,summary,netProfit:profit,comparisonCutoff:cutoff};
}
function businessWeekSamePoint(fullWeek,history=null){return businessCalendarSamePoint(fullWeek,'week',history)}
function businessMonthSamePoint(fullMonth,history=null){return businessCalendarSamePoint(fullMonth,'month',history)}
function businessYesterdaySameTime(fullYesterday){
 const elapsed=businessElapsedTodayMs(),cutoff=Math.min(fullYesterday.bounds.end,fullYesterday.bounds.start+elapsed),
   partialBounds={start:fullYesterday.bounds.start,end:cutoff,days:-1,label:'Вчера'},
   orderBuckets=businessBuckets('day',fullYesterday.bounds),
   orders=businessEstimateOrders(businessOrderGroups(partialBounds),orderBuckets,window.allMarketUnitProfit30);
 let revenue=0,qty=0,profit=0;
 for(const b of fullYesterday.buckets){
  const factor=cutoff<=b.start?0:cutoff>=b.end?1:(cutoff-b.start)/Math.max(1,b.end-b.start);
  revenue+=(Number(b.buyouts)||0)*factor;
  qty+=(Number(b.buyoutQty)||0)*factor;
  profit+=(Number(b.buyoutProfit)||0)*factor;
 }
 const summary={...fullYesterday.summary,revenue,qty:Math.round(qty),profit},
   netProfit=profit;
 return {...fullYesterday,bounds:partialBounds,orders,summary,netProfit,comparisonCutoff:cutoff,comparisonElapsed:elapsed};
}
async function businessLoadWeekOrderHistory(bounds,force=false){
 const key=bounds.start+':'+Math.min(bounds.end,businessDayBounds(0).end),cached=businessWeekOrderCache.get(key);
 if(!force&&cached&&Date.now()-cached.at<60000)return cached.rows;
 const data=await apiJson(MILLIONER_API+'/api/orders?limit=15000&history=1&before='+encodeURIComponent(bounds.end)+'&after='+encodeURIComponent(bounds.start));
 if(data?.ok===false||!Array.isArray(data?.orders)||data.orders.length>=15000)throw new Error('Не удалось загрузить полную историю заказов');
 if(Array.isArray(data.historyCoverage))for(const item of data.historyCoverage){if(!(Number(item.from)>0)||Number(item.from)>bounds.start){const error=new Error('Нет полной истории '+(item.market==='WB'?'WB1':item.market)+' за этот период');error.businessHistoryPending=true;throw error}}
 const rows=data.orders.filter(row=>['Kaspi','WB','WB2'].includes(String(row.market)));
 businessWeekOrderCache.set(key,{rows,at:Date.now()});return rows;
}
const businessDays=new Map(),businessDayJobs=new Map(),BUSINESS_DAYS_KEY='milioner_business_days_v2';let businessDaysHydrated=false;
function businessHydrateDays(){if(businessDaysHydrated)return;businessDaysHydrated=true;try{const value=JSON.parse(localStorage.getItem(BUSINESS_DAYS_KEY)||'null');if(value?.version===BUSINESS_CACHE_VERSION)for(const row of value.days||[])if(row?.data?.period==='day'&&row.data.buckets?.length===24&&Number(row.at)>0)businessDays.set(row.data.bounds.start,row)}catch(_){}}
function businessSaveDays(bounds=null){if(bounds)for(let t=bounds.start;t<bounds.end;t+=86400000){const row=businessDays.get(t);if(row){businessDays.delete(t);businessDays.set(t,row)}}while(businessDays.size>80)businessDays.delete(businessDays.keys().next().value);try{let rows=[...businessDays.values()].filter(r=>!r.data.pending),text=JSON.stringify({version:BUSINESS_CACHE_VERSION,days:rows});while(text.length>1500000&&rows.length){rows.shift();text=JSON.stringify({version:BUSINESS_CACHE_VERSION,days:rows})}localStorage.setItem(BUSINESS_DAYS_KEY,text)}catch(_){}}
function businessDaysBounds(period,offset){const b=period==='month'?businessMonthBounds(offset):period==='week'?businessWeekBounds(offset):businessDayBounds(offset),previous=period==='month'?businessMonthBounds(offset-1):period==='week'?businessWeekBounds(offset-1):businessDayBounds(offset-1);return{start:previous.start-(period==='day'?0:86400000),end:Math.min(b.end,businessDayBounds(0).end)}}
function businessOrderEvents(groups,unitMap){return groups.map(g=>{const x=businessEstimateOrders([g],[],unitMap);return[Number(g.creationDate),x.amount,x.qty,x.profit,x.orderCount,x.coveredAmount,x.coveredQty]})}
function businessOrdersBefore(records,cutoff){const x={amount:0,qty:0,profit:0,orderCount:0,coveredAmount:0,coveredQty:0};for(const r of records)for(const e of r.events||[])if(e[0]<cutoff){x.amount+=e[1];x.qty+=e[2];x.profit+=e[3];x.orderCount+=e[4];x.coveredAmount+=e[5];x.coveredQty+=e[6]}return{...x,coverage:x.amount>0?x.coveredAmount/x.amount:1}}
function businessRecords(bounds){const rows=[];for(let t=bounds.start;t<Math.min(bounds.end,businessDayBounds(0).end);t+=86400000){const row=businessDays.get(t)?.data;if(!row)return null;rows.push(row)}return rows}
function businessCalendarFromDays(period,offset){const bounds=period==='week'?businessWeekBounds(offset):businessMonthBounds(offset),records=businessRecords(bounds);if(!records)return null;const buckets=businessBuckets(period,bounds);for(const row of records){const bucket=buckets.find(b=>b.start===row.bounds.start);if(bucket){for(const field of ['orders','orderQty','orderProfit'])bucket[field]=row.buckets.reduce((n,h)=>n+(Number(h[field])||0),0);businessCopyBuyouts(bucket,row.buckets)}}const summary=businessCombineSummary(records.map(r=>r.summary)),orders=businessOrdersBefore(records,Infinity);return{period,bounds,buckets,orders,summary,netProfit:summary.profit,hourly:{ozonHourlyComplete:records.every(r=>r.hourly?.ozonHourlyComplete!==false)},pending:records.some(r=>r.pending)}}
function businessPreviousPoint(previous,period,exactCutoff=null){const origin=period==='month'?businessMonthBounds(0).start:period==='week'?businessWeekBounds(0).start:businessDayBounds(0).start,cutoff=exactCutoff===null?Math.min(previous.bounds.end,previous.bounds.start+Math.max(0,Date.now()-origin)):Math.max(previous.bounds.start,Math.min(previous.bounds.end,exactCutoff)),records=businessRecords(previous.bounds);if(!records)return previous;let revenue=0,qty=0,profit=0;for(const r of records)for(const h of r.buckets){const factor=Math.max(0,Math.min(1,(cutoff-h.start)/(h.end-h.start)));revenue+=(Number(h.buyouts)||0)*factor;qty+=(Number(h.buyoutQty)||0)*factor;profit+=(Number(h.buyoutProfit)||0)*factor}const known=previous.summary.profit!==null,summary={...previous.summary,revenue,qty:Math.round(qty),profit:known?profit:null};return{...previous,bounds:{...previous.bounds,end:cutoff},summary,orders:businessOrdersBefore(records,cutoff),netProfit:summary.profit,comparisonCutoff:cutoff}}
function businessMissingComparison(period,offset){const bounds=businessBounds(period,offset);return{period,bounds,buckets:businessBuckets(period,bounds),orders:{amount:0,qty:0,profit:0,orderCount:0,coverage:0},summary:{revenue:0,qty:0,profit:null},unavailable:true,pending:false}}
function businessModelFromDays(period,offset){if(period==='year')return null;businessHydrateDays();let current,previous;if(period==='day'){current=businessDays.get(businessDayBounds(offset).start)?.data;previous=businessDays.get(businessDayBounds(offset-1).start)?.data;if(!current)return null}else{current=businessCalendarFromDays(period,offset);previous=businessCalendarFromDays(period,offset-1);if(!current)return null}previous=previous||businessMissingComparison(period,offset-1);return{...current,dayOffset:period==='day'?offset:undefined,weekOffset:period==='week'?offset:undefined,monthOffset:period==='month'?offset:undefined,yesterday:previous,yesterdayCompare:offset===0&&!previous.unavailable?businessPreviousPoint(previous,period):previous,pending:Boolean(current.pending||previous.pending)}}
function businessYieldUi(){return typeof window.setTimeout==='function'?new Promise(resolve=>window.setTimeout(resolve,0)):Promise.resolve()}
function businessMakeDay(start,groups,summary=null,preparedSales=null){const bounds={start,end:start+86400000,days:0,label:businessShortDate(start)},selected=groups.filter(g=>Number(g.creationDate)>=start&&Number(g.creationDate)<start+86400000),buckets=businessBuckets('day',bounds),orders=businessEstimateOrders(selected,buckets,window.allMarketUnitProfit30),local=summary?businessLocalBuyouts(bounds,buckets,window.allMarketUnitProfit30,preparedSales):null,hourly=summary?businessNormalizeBuyoutBuckets(buckets,local,summary):{ozonHourlyComplete:false};return{period:'day',bounds,buckets,orders,events:businessOrderEvents(selected,window.allMarketUnitProfit30),local,summary:summary||{revenue:null,qty:null,profit:null},netProfit:summary?.profit??null,hourly,pending:!summary}}
async function businessLoadDayBase(bounds,force=false,preview=null){businessHydrateDays();const key=bounds.start+':'+bounds.end;if(businessDayJobs.has(key))return businessDayJobs.get(key);for(const [span,job]of businessDayJobs){const [start,end]=span.split(':').map(Number);if(bounds.start>=start&&bounds.end<=end)return job}const task=(async()=>{
 let online=null;try{if(typeof fetch==='function'){const r=await fetch(MILLIONER_API+'/api/business-dashboard-days?from='+bounds.start+'&to='+bounds.end,{cache:'no-store'});if(r.ok)online=await r.json()}}catch(_){}
 let all=true;for(let t=bounds.start;t<bounds.end;t+=86400000){const remote=online?.days?.find(r=>r.day?.bounds?.start===t),prior=businessDays.get(t);if(remote&&remote.day.buckets?.length===24&&(!prior||Number(remote.generatedAt)>prior.at))businessDays.set(t,{data:remote.day,at:remote.generatedAt,revision:remote.fresh?online.sourceRevision:null});const local=businessDays.get(t),ttl=t+86400000>Date.now()?60000:15*60000,ready=local&&!local.data.pending&&Date.now()-local.at<ttl&&(!online||local.revision===online.sourceRevision);if(force||!(remote?.fresh||ready))all=false}
 if(all){businessSaveDays(bounds);return}
 // One source read for the interval; individual day views reuse these records.
 if(typeof window.ozonFboRefreshStatus==='function')await window.ozonFboRefreshStatus();
 const coverage={start:bounds.start,end:Math.min(bounds.end,businessDayBounds(0).start)};if(typeof window.ozonFboOrderHistoryCovers==='function'&&!window.ozonFboOrderHistoryCovers(coverage)){const error=Error('История Ozon для этого периода загружается');error.businessHistoryPending=true;throw error}
 const history=[...await businessLoadWeekOrderHistory(bounds,force),...(state.ozonOrderFeed||[]).map(x=>({...x,market:'Ozon'}))],groups=businessOrderGroups(bounds,history);
 const span={from:businessIsoDate(bounds.start),to:businessIsoDate(bounds.end-86400000)},financeTask=window.loadBusinessMarketplaceDaily(span,{force}).then(value=>({value}),error=>({error})),unitTask=typeof window.refreshAllMarketUnitProfit==='function'&&(!(window.allMarketUnitProfit30 instanceof Map)||force)?window.refreshAllMarketUnitProfit().catch(()=>null):Promise.resolve();
 const grouped=new Map();for(const g of groups){const day=Math.floor((Number(g.creationDate)+18000000)/86400000)*86400000-18000000;const rows=grouped.get(day)||[];rows.push(g);grouped.set(day,rows)}
 for(let t=bounds.start;t<bounds.end;t+=86400000){await businessYieldUi();if(!businessDays.get(t)||businessDays.get(t).data.pending)businessDays.set(t,{data:businessMakeDay(t,grouped.get(t)||[]),at:Date.now(),revision:online?.sourceRevision})}
 if(preview)preview();const result=await financeTask;await unitTask;if(result.error)throw result.error;
 await businessYieldUi();const preparedSales=typeof financialSales==='function'?financialSales():[];
 for(let t=bounds.start;t<bounds.end;t+=86400000){await businessYieldUi();const day=businessIsoDate(t),summary=result.value.find(x=>x.day===day)?.summary;if(!summary)throw Error('Нет дневной финансовой основы '+day);businessDays.set(t,{data:businessMakeDay(t,grouped.get(t)||[],summary,preparedSales),at:Date.now(),revision:online?.sourceRevision})}
 businessSaveDays(bounds);if(typeof fetch==='function'&&online?.sourceRevision){const days=[];for(let t=bounds.start;t<bounds.end;t+=86400000)days.push(businessDays.get(t).data);void fetch(MILLIONER_API+'/api/business-dashboard-days',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({days,version:BUSINESS_CACHE_VERSION,sourceRevision:online.sourceRevision})}).catch(()=>{})}
 })().finally(()=>businessDayJobs.delete(key));businessDayJobs.set(key,task);return task}
async function businessBuildSharedModel(force,period,offset){const bounds=businessDaysBounds(period,offset),key=businessModelKey(period,offset),selected=period==='month'?businessMonthBounds(offset):period==='week'?businessWeekBounds(offset):businessDayBounds(offset),candidates=[bounds,...(period==='day'?[]:[{start:bounds.start+86400000,end:bounds.end}]),{start:selected.start,end:Math.min(selected.end,businessDayBounds(0).end)}],preview=()=>{if(key===businessModelKey()&&document.getElementById('reports')?.classList.contains('active')){const m=businessModelFromDays(period,offset);if(m){businessPaint(m);businessCacheStatus(key,'updating')}}};for(let i=0;i<candidates.length;i++){try{await businessLoadDayBase(candidates[i],force,preview);break}catch(error){if(!error.businessHistoryPending||i===candidates.length-1)throw error}}const model=businessModelFromDays(period,offset);if(!model)throw Error('Дневная основа ещё не загружена');return model}

function businessYearComparisonCutoff(year){const local=new Date(Date.now()+18000000),day=Math.min(local.getUTCDate(),new Date(Date.UTC(year,local.getUTCMonth()+1,0)).getUTCDate());return Date.UTC(year,local.getUTCMonth(),day,local.getUTCHours(),local.getUTCMinutes(),local.getUTCSeconds())-18000000}
async function businessLoadYearMonth(bounds,force){
 const active={start:bounds.start,end:Math.min(bounds.end,businessDayBounds(0).end)},current=businessMonthBounds(0),a=new Date(bounds.start+18000000),b=new Date(current.start+18000000),offset=(a.getUTCFullYear()-b.getUTCFullYear())*12+a.getUTCMonth()-b.getUTCMonth();
 if(typeof window.loadBusinessMarketplaceDaily==='function'){
  await businessLoadDayBase(active,force);
  const month=businessCalendarFromDays('month',offset);
  if(!month)throw Error('Месячная основа ещё не загружена');
  return{month,samePoint:a.getUTCMonth()===b.getUTCMonth()?businessPreviousPoint(month,'month',businessYearComparisonCutoff(a.getUTCFullYear())):month};
 }
 const history=[...await businessLoadWeekOrderHistory(active,force),...(state.ozonOrderFeed||[]).map(row=>({...row,market:'Ozon'}))];
 const month=await businessBuildMonthSnapshot(offset,force,null,history);
 // Without daily records there is no exact same-date financial comparison.
 return{month,samePoint:null};
}
function businessYearFromMonths(bounds,parts){
 const buckets=businessBuckets('year',bounds),rows=[],orders={amount:0,qty:0,profit:0,orderCount:0,coveredAmount:0,coveredQty:0};let knownMonths=0,expectedMonths=0;
 for(let i=0;i<12;i++){
  const bucket=buckets[i];if(bucket.start>=Math.min(Date.now(),bounds.end)){bucket.future=true;continue}expectedMonths++;
  const month=parts[i];if(!month){bucket.unavailable=true;continue}knownMonths++;rows.push(month.summary);
  for(const field of ['orders','orderQty','orderProfit'])bucket[field]=month.buckets.reduce((n,b)=>n+(Number(b[field])||0),0);
  businessCopyBuyouts(bucket,month.buckets);bucket.financeUnavailable=month.pending||month.summary.revenue===null;bucket.profitUnavailable=month.pending||month.summary.profit===null;bucket.orderProfitUnavailable=month.orders.qty>0&&!(month.orders.coverage>0);
  for(const field of ['amount','qty','profit','orderCount'])orders[field]+=Number(month.orders[field])||0;
  orders.coveredAmount+=(Number(month.orders.amount)||0)*(Number(month.orders.coverage)||0);
 }
 orders.coverage=orders.amount>0?orders.coveredAmount/orders.amount:1;
 const summary=businessCombineSummary(rows);
 return{period:'year',bounds,buckets,orders,summary,netProfit:summary.profit,knownMonths,expectedMonths,yearPartial:knownMonths<expectedMonths,unavailable:knownMonths===0,hourly:{ozonHourlyComplete:true},pending:false};
}
async function businessBuildYearModel(force,offset,loadMonth=businessLoadYearMonth){
 const bounds=businessYearBounds(offset),previousBounds=businessYearBounds(offset-1),currentParts=[],previousParts=[],alignedParts=[],key='year:'+bounds.start,currentMonth=new Date(Date.now()+18000000).getUTCMonth(),watchSelection=key===businessModelKey();
 for(const [span,parts]of [[previousBounds,previousParts],[bounds,currentParts]]){
  const buckets=businessBuckets('year',span);
  for(let i=0;i<12;i++){
   if(buckets[i].start>Date.now())continue;
   await businessYieldUi();
   if(watchSelection&&key!==businessModelKey())throw Error('Выбран другой период');
   try{const loaded=await loadMonth(buckets[i],force);parts[i]=loaded.month;if(span===previousBounds&&i<=currentMonth)alignedParts[i]=i===currentMonth?loaded.samePoint:loaded.month}
   catch(error){if(!error.businessHistoryPending)console.warn('Годовой отчёт: месяц недоступен',businessIsoDate(buckets[i].start),error)}
   if(span===bounds&&key===businessModelKey()&&document.getElementById('reports')?.classList.contains('active')){
    const preview=businessYearFromMonths(bounds,currentParts),previous=businessMissingComparison('year',offset-1);
    businessPaint({...preview,pending:true,yearOffset:offset,yesterday:previous,yesterdayCompare:previous});businessCacheStatus(key,'updating');
   }
  }
 }
 const current=businessYearFromMonths(bounds,currentParts),previous=businessYearFromMonths(previousBounds,previousParts);
 let compare=previous;
 if(offset===0){
  const cutoff=businessYearComparisonCutoff(new Date(previousBounds.start+18000000).getUTCFullYear());
  compare=businessYearFromMonths({...previousBounds,end:cutoff},alignedParts);compare.comparisonCutoff=cutoff;
 }
 return{...current,yearOffset:offset,yesterday:previous,yesterdayCompare:compare};
}

async function businessBuildModel(force=false,period=businessPeriod,dayOffset=businessSelectedDayOffset(),weekOffset=businessSelectedWeekOffset(),monthOffset=businessSelectedMonthOffset(),yearOffset=businessSelectedYearOffset()){
 if(period==='year')return businessBuildYearModel(force,yearOffset);
 if(typeof window.loadBusinessMarketplaceDaily==='function')return businessBuildSharedModel(force,period,period==='month'?monthOffset:period==='week'?weekOffset:dayOffset);
 const selectedBounds=businessDayBounds(dayOffset),previousBounds=businessDayBounds(dayOffset-1);
 if(force){businessSummaryCache.clear();businessWeekOrderCache.clear()}
 if(period==='month'||period==='week'&&weekOffset<0){const selected=period==='month'?monthOffset:weekOffset,getBounds=period==='month'?businessMonthBounds:businessWeekBounds,span={start:getBounds(selected-1).start,end:selected===0?Date.now():getBounds(selected).end};
  if(typeof window.ozonFboOrderHistoryCovers==='function'&&!window.ozonFboOrderHistoryCovers(span)){if(typeof window.ozonFboRefreshStatus==='function')await window.ozonFboRefreshStatus();if(!window.ozonFboOrderHistoryCovers(span)){const error=new Error('История Ozon для этого периода загружается');error.businessHistoryPending=true;throw error}}}
 const warm=[];
 if(typeof window.ozonFboRefreshStatus==='function')warm.push(Promise.resolve().then(()=>window.ozonFboRefreshStatus()));
 if(typeof window.refreshAllMarketUnitProfit==='function'&&(!(window.allMarketUnitProfit30 instanceof Map)||force))warm.push(Promise.resolve().then(()=>window.refreshAllMarketUnitProfit()));
 const preload=[];
 if(period==='day'){for(const offset of [dayOffset,dayOffset-1])preload.push(businessLoadSummary(businessDaySummarySpec(offset,businessDayBounds(offset)),force))}
 else{const selected=period==='month'?monthOffset:weekOffset,getBounds=period==='month'?businessMonthBounds:businessWeekBounds;
  for(const which of [selected,selected-1]){const b=getBounds(which),end=which===0?businessDayBounds(0).start:b.end;if(end>b.start)preload.push(businessLoadSummary(0,force,{from:businessIsoDate(b.start),to:businessIsoDate(end-86400000)}))}if(selected===0)preload.push(businessLoadSummary(1,force));}
 if(warm.length||preload.length)await Promise.allSettled([...warm,...preload]);
 force=false;
 if(period==='week'||period==='month'){
  const selected=period==='week'?weekOffset:monthOffset,build=period==='month'?businessBuildMonthSnapshot:businessBuildWeekSnapshot,samePoint=period==='month'?businessMonthSamePoint:businessWeekSamePoint;
  let history=null;
  if(selected<0||period==='month'){const getBounds=period==='month'?businessMonthBounds:businessWeekBounds,span={start:getBounds(selected-1).start,end:selected===0?Date.now():getBounds(selected).end};
   if(typeof window.ozonFboOrderHistoryCovers==='function'&&!window.ozonFboOrderHistoryCovers(span)){const error=new Error('История Ozon для этого периода загружается');error.businessHistoryPending=true;throw error}
   history=[...await businessLoadWeekOrderHistory(span,force),...(state.ozonOrderFeed||[]).map(row=>({...row,market:'Ozon'}))];
  }
  const today=selected===0?await businessBuildDaySnapshot(businessDayBounds(0),1,force):null,[current,previous]=await Promise.all([build(selected,force,today,history),build(selected-1,force,null,history)]),previousCompare=selected===0?samePoint(previous,history):previous;
  return {...current,weekOffset:period==='week'?selected:undefined,monthOffset:period==='month'?selected:undefined,yesterday:previous,yesterdayCompare:previousCompare};
 }
 const [today,yesterday]=await Promise.all([businessBuildDaySnapshot(selectedBounds,businessDaySummarySpec(dayOffset,selectedBounds),force),businessBuildDaySnapshot(previousBounds,businessDaySummarySpec(dayOffset-1,previousBounds),force)]),yesterdayCompare=businessYesterdaySameTime(yesterday);
 return {...today,dayOffset,yesterday,yesterdayCompare:dayOffset===0?yesterdayCompare:yesterday};
}

function businessShowSelection(){businessRenderSeq++;businessLastModel=null;businessSaveUi();businessPaintTabs();return window.renderBusinessDashboard(false)}
window.shiftBusinessDashboardDay=function(direction){if(businessPeriod!=='day'||![-1,1].includes(direction))return;const current=businessSelectedDayOffset(),next=Math.max(-BUSINESS_DAY_HISTORY,Math.min(0,current+direction));if(next===current)return;businessDayDate=next===0?'':businessIsoDate(businessDayBounds(next).start);return businessShowSelection()};
window.shiftBusinessDashboardWeek=function(direction){if(businessPeriod!=='week'||![-1,1].includes(direction))return;const current=businessSelectedWeekOffset(),next=Math.max(-BUSINESS_WEEK_HISTORY,Math.min(0,current+direction));if(next===current)return;businessWeekDate=next===0?'':businessIsoDate(businessWeekBounds(next).start);return businessShowSelection()};
window.shiftBusinessDashboardMonth=function(direction){if(businessPeriod!=='month'||![-1,1].includes(direction))return;const current=businessSelectedMonthOffset(),next=Math.max(-BUSINESS_MONTH_HISTORY,Math.min(0,current+direction));if(next===current)return;businessMonthDate=next===0?'':businessIsoDate(businessMonthBounds(next).start);return businessShowSelection()};
window.shiftBusinessDashboardYear=function(direction){if(businessPeriod!=='year'||![-1,1].includes(direction))return;const current=businessSelectedYearOffset(),next=Math.max(-BUSINESS_YEAR_HISTORY,Math.min(0,current+direction));if(next===current)return;businessYearDate=next===0?'':businessIsoDate(businessYearBounds(next).start);return businessShowSelection()};
window.shiftBusinessDashboardSelection=function(direction){return businessPeriod==='year'?window.shiftBusinessDashboardYear(direction):businessPeriod==='month'?window.shiftBusinessDashboardMonth(direction):businessPeriod==='week'?window.shiftBusinessDashboardWeek(direction):window.shiftBusinessDashboardDay(direction)};
window.setBusinessDashboardMetric=function(metric){if(!BUSINESS_METRICS.has(metric))return;businessMetric=metric;businessSaveUi();if(businessLastModel&&businessLastModel.period+':'+businessLastModel.bounds.start===businessModelKey())businessPaint(businessLastModel);else return window.renderBusinessDashboard(false)};
window.setBusinessDashboardPeriod=function(period){if(!BUSINESS_PERIODS.has(period))return;if(period===businessPeriod&&businessSelectedOffset(period)===0)return;businessPeriod=period;if(period==='day')businessDayDate='';if(period==='week')businessWeekDate='';if(period==='month')businessMonthDate='';if(period==='year')businessYearDate='';return businessShowSelection()};
function businessComparison(current,previous){
 if(current===null||current===undefined||previous===null||previous===undefined||!Number.isFinite(Number(current))||!Number.isFinite(Number(previous)))return {html:''};
 const now=Number(current),prev=Number(previous),delta=now-prev,cls=Math.abs(delta)<.005?'flat':delta>0?'up':'down',sign=delta>0?'+':'',pct=prev!==0?delta/Math.abs(prev)*100:null,pctText=pct===null?'':(' · '+(pct>0?'+':'')+Math.round(pct)+'%');
 return {html:'<span class="business-compare-label">разница</span><span class="business-compare-delta '+cls+'">'+sign+businessMoney(delta)+pctText+'</span>'};
}
function businessPaint(model){
 if(model.period==='month'&&model.bounds.start<businessMonthBounds(0).start)model={...model,monthOffset:-1,yesterdayCompare:model.yesterday};
 if(model.period==='week'&&model.bounds.start<businessWeekBounds(0).start)model={...model,weekOffset:-1,yesterdayCompare:model.yesterday};
 if(model.period==='day'&&model.bounds.start<businessDayBounds(0).start)model={...model,dayOffset:-1,yesterdayCompare:model.yesterday};
 businessLastModel=model;if(model?.period&&!model.pending)businessModels.set(model.period+':'+model.bounds.start,model);businessPaintTabs();const year=model.period==='year',week=model.period==='week',month=model.period==='month',past=Number(model.dayOffset)<0,pastWeek=week&&Number(model.weekOffset)<0,pastMonth=month&&Number(model.monthOffset)<0,info=businessMetricInfo(model),full=model.yesterday,same=model.yesterdayCompare||full,fullInfo=full?businessMetricInfo(full):null,sameInfo=same?businessMetricInfo(same):null,
 metric=document.getElementById('businessValueMetric'),label=document.getElementById('businessValueLabel'),value=document.getElementById('businessValue'),meta=document.getElementById('businessValueMeta'),
 yLabel=document.getElementById('businessYesterdayLabel'),yValue=document.getElementById('businessYesterdayValue'),yMeta=document.getElementById('businessYesterdayMeta'),
 compare=document.getElementById('businessYesterdayCompare');
 if(metric)metric.textContent=info.label;if(label)label.textContent=year?new Date(model.bounds.start+18000000).getUTCFullYear()+' · '+(Number(model.yearOffset)<0?'весь год':'этот год'):month?businessShortDate(model.bounds.start)+' – '+businessShortDate(Math.min(Date.now(),model.bounds.end-1))+(pastMonth?' · весь месяц':' · этот месяц'):week?businessShortDate(model.bounds.start)+' – '+businessShortDate(Math.min(Date.now(),model.bounds.end-1))+(pastWeek?' · вся неделя':' · эта неделя'):businessShortDate(model.bounds.start)+(past?' · весь день':' · сегодня');if(value)value.textContent=businessMaybeMoney(info.value,Boolean(info.estimated));if(meta)meta.textContent=info.meta;
 if(yLabel)yLabel.textContent=full?(year?new Date(full.bounds.start+18000000).getUTCFullYear()+' · весь год':month?businessShortDate(full.bounds.start)+' – '+businessShortDate(full.bounds.end-86400000)+' · весь месяц':week?businessShortDate(full.bounds.start)+' – '+businessShortDate(full.bounds.end-86400000)+' · вся неделя':businessShortDate(full.bounds.start)+' · весь день'):(year?'Прошлый год':month?'Прошлый месяц':week?'Прошлая неделя':'Вчера');
 if(yValue)yValue.textContent=fullInfo?businessMaybeMoney(fullInfo.value,Boolean(fullInfo.estimated)):'—';if(yMeta)yMeta.textContent=fullInfo?fullInfo.meta:'';
 if(compare&&full?.unavailable)compare.textContent='Нет полной истории для сравнения';
 else if(compare){const until=same?businessHourMinute(same.comparisonCutoff||same.bounds.end):'',mark=same?same.comparisonCutoff||same.bounds.end:0,phrase=year?(Number(model.yearOffset)<0?'прошлый год целиком':'прошлый год до '+businessShortDate(mark)+' '+until):month?(pastMonth?businessShortDate(full.bounds.start)+' – '+businessShortDate(full.bounds.end-86400000)+' · весь месяц':same?.comparisonCutoff>=full?.bounds?.end?'прошлый месяц целиком':'прошлый до '+new Date(mark+5*3600000).getUTCDate()+' '+until):week?(pastWeek?businessShortDate(full.bounds.start)+' – '+businessShortDate(full.bounds.end-86400000)+' · вся неделя':'прошлая до '+businessWeekdayName(mark)+' '+until):past?businessShortDate(full.bounds.start)+' · весь день':'вчера до '+until;compare.innerHTML=(sameInfo&&!info.incomplete&&!sameInfo.incomplete?businessComparison(info.value,sameInfo.value).html:'')+(until&&sameInfo?'<span class="business-compare-label">'+phrase+' · '+businessMaybeMoney(sameInfo.value,Boolean(sameInfo.estimated))+'</span>':'')}
 businessPaintChart(model,info.field);
}
function businessHydrateModels(){
 if(businessCacheHydrated)return;businessCacheHydrated=true;
 try{const saved=JSON.parse(localStorage.getItem(BUSINESS_CACHE_KEY)||'null');if(saved?.version!==BUSINESS_CACHE_VERSION||!Array.isArray(saved.entries))return;
  for(const [key,row]of saved.entries.slice(-16))if(row?.model&&row.model.period+':'+row.model.bounds?.start===key&&Array.isArray(row.model.buckets)&&row.model.yesterday&&row.model.yesterdayCompare&&Number(row.at)>0){businessModels.set(key,row.model);businessModelMeta.set(key,{at:row.at})}
 }catch(_){}
}
function businessRememberModel(key,model,at=Date.now()){
 businessModels.delete(key);businessModels.set(key,model);businessModelMeta.set(key,{at});
 while(businessModels.size>16){const oldest=businessModels.keys().next().value;businessModels.delete(oldest);businessModelMeta.delete(oldest)}
 try{const entries=[...businessModels].map(([key,model])=>[key,{model,at:businessModelMeta.get(key)?.at||Date.now()}]),text=JSON.stringify({version:BUSINESS_CACHE_VERSION,entries});if(text.length<1500000)localStorage.setItem(BUSINESS_CACHE_KEY,text)}catch(_){}
}
function businessCacheStatus(key,state='ready'){
 const el=document.getElementById('businessCacheStatus');if(!el)return;const at=businessModelMeta.get(key)?.at;
 el.textContent=(at?'Сводка '+new Date(at).toLocaleString('ru-RU',{timeZone:'Asia/Almaty',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}):'')+(state==='updating'?(at?' · обновляю…':'Считаю…'):state==='history'?(at?' · история заказов ещё догружается':'История заказов ещё догружается'):state==='offline'?' · не удалось обновить':'');
}
async function businessReadOnline(period,start){
 if(typeof fetch!=='function')return null;
 const response=await fetch(MILLIONER_API+'/api/business-dashboard-cache?period='+period+'&start='+start,{cache:'no-store'});if(!response.ok)throw new Error('Сводка недоступна');const data=await response.json();return data?.ok&&data.version===BUSINESS_CACHE_VERSION?data:null;
}
function businessStoreOnline(model,revision){
 if(typeof fetch!=='function'||!revision)return;
 void fetch(MILLIONER_API+'/api/business-dashboard-cache',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({period:model.period,start:model.bounds.start,snapshot:model,sourceRevision:revision,version:BUSINESS_CACHE_VERSION})}).catch(()=>{});
}
async function businessResolveModel(force,period,offset,key){
 let online=null;
 try{online=await businessReadOnline(period,Number(key.split(':')[1]));}catch(_){}
 const remote=online?.snapshot;if(remote&&remote.period+':'+remote.bounds?.start===key){const newer=businessModels.get(key)&&Number(businessModelMeta.get(key)?.at)>Number(online.generatedAt),chosen=newer?businessModels.get(key):remote;if(!newer)businessRememberModel(key,remote,online.generatedAt);if(key===businessModelKey()&&document.getElementById('reports')?.classList.contains('active')){businessPaint(chosen);businessCacheStatus(key,online.stale||force?'updating':'ready')}if(!force&&!online.stale){if(period!=='year'&&typeof window.loadBusinessMarketplaceDaily==='function')return businessBuildSharedModel(false,period,offset);return chosen}}
 const model=await businessBuildModel(force||Boolean(online?.stale&&remote&&typeof window.loadBusinessMarketplaceDaily!=='function'),period,period==='day'?offset:0,period==='week'?offset:0,period==='month'?offset:0,period==='year'?offset:0);
 businessRememberModel(key,model);businessStoreOnline(model,online?.sourceRevision);return model;
}
window.renderBusinessDashboard=async function(force=false){
 const root=businessEnsureUi();if(!root)return;if(!document.getElementById('reports')?.classList.contains('active')){businessPaintTabs();return}
 void businessLoadFinanceHistory(force);
 const seq=++businessRenderSeq,period=businessPeriod,key=businessModelKey(),offset=businessSelectedOffset();businessHydrateModels();businessLastModel=null;businessPaintTabs();
 const shared=typeof window.loadBusinessMarketplaceDaily==='function'?businessModelFromDays(period,offset):null,cached=shared||businessModels.get(key),metaRow=businessModelMeta.get(key);
 if(cached){businessPaint(cached);businessCacheStatus(key,'updating');if(!force&&!cached.pending&&Date.now()-Number(metaRow?.at||0)<30000&&typeof fetch!=='function'){businessCacheStatus(key);return cached}}
 else{const metric=document.getElementById('businessValueMetric'),label=document.getElementById('businessValueLabel'),value=document.getElementById('businessValue'),meta=document.getElementById('businessValueMeta'),yValue=document.getElementById('businessYesterdayValue'),compare=document.getElementById('businessYesterdayCompare'),chart=document.getElementById('businessChart');
  if(metric)metric.textContent='Считаю бизнес-показатели…';if(label)label.textContent=businessPeriodBounds().label;if(value)value.textContent='…';if(meta)meta.textContent='';if(yValue)yValue.textContent='…';const yLabel=document.getElementById('businessYesterdayLabel'),yMeta=document.getElementById('businessYesterdayMeta');if(yLabel)yLabel.textContent=period==='year'?'Прошлый год':period==='month'?'Прошлый месяц':period==='week'?'Прошлая неделя':'Вчера';if(yMeta)yMeta.textContent='';if(compare)compare.innerHTML='';if(chart)chart.innerHTML='';businessCacheStatus(key,'updating');}
 let job=businessBuildJobs.get(key);if(!job){job=businessResolveModel(force,period,offset,key).finally(()=>{businessBuildJobs.delete(key)});businessBuildJobs.set(key,job)}
 try{const model=await job;if(seq!==businessRenderSeq||key!==businessModelKey())return;businessPaint(model);businessCacheStatus(key);return model}
 catch(error){if(seq!==businessRenderSeq||key!==businessModelKey())return;const pendingHere=businessLastModel?.pending&&businessLastModel.period+':'+businessLastModel.bounds?.start===key?businessLastModel:null;if(cached||pendingHere){const keep=cached||pendingHere;businessPaint(keep);businessCacheStatus(key,error.businessHistoryPending?'history':'offline');return keep}const label=document.getElementById('businessValueLabel'),value=document.getElementById('businessValue');if(label)label.textContent=error.businessHistoryPending?error.message:'Не удалось посчитать';if(value)value.textContent='—';businessCacheStatus(key,error.businessHistoryPending?'history':'offline')}
};


const baseRenderReports=window.renderReports;
window.renderReports=function(){
 const result=typeof baseRenderReports==='function'?baseRenderReports.apply(this,arguments):undefined;
 businessRemoveLegacyStoreNote();
 setTimeout(()=>{businessRemoveLegacyStoreNote();window.renderBusinessDashboard(false)},0);return result;
};
const init=()=>{businessEnsureUi();businessInstallLegacyNoteCleanup();businessPaintTabs();if(document.getElementById('reports')?.classList.contains('active'))window.renderBusinessDashboard(false)};
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
