(function(){
'use strict';
if(typeof window==='undefined')return;

const BUSINESS_SUPPORTED_MARKETS=new Set(['Kaspi','WB','WB2','Ozon']);
const BUSINESS_PERIODS=new Set(['day','week','month']);
const BUSINESS_WEEKDAYS=['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];
const BUSINESS_METRICS=new Set(['orders','buyouts','orderProfit','buyoutProfit']);
const BUSINESS_UI_KEY='milioner_business_dashboard_v1';
const BUSINESS_DAY_HISTORY=7;
const BUSINESS_WEEK_HISTORY=5;
let businessRenderSeq=0,businessSummaryCache=new Map(),businessLastModel=null;
let businessPeriod='day',businessMetric='orders',businessModels=new Map(),businessDayDate='',businessWeekDate='',businessWeekOrderCache=new Map();
try{
 const saved=JSON.parse(localStorage.getItem(BUSINESS_UI_KEY)||'{}');
 businessPeriod=saved.period==='week'||saved.period==='month'?saved.period:'day';
 if(saved.metric==='netProfit')businessMetric='buyoutProfit';
 else if(BUSINESS_METRICS.has(saved.metric))businessMetric=saved.metric;
 if(/^\d{4}-\d{2}-\d{2}$/.test(saved.dayDate||''))businessDayDate=saved.dayDate;
 if(/^\d{4}-\d{2}-\d{2}$/.test(saved.weekDate||''))businessWeekDate=saved.weekDate;
}catch(_){}

function businessSaveUi(){
 try{localStorage.setItem(BUSINESS_UI_KEY,JSON.stringify({period:businessPeriod,metric:businessMetric,dayDate:businessDayDate,weekDate:businessWeekDate}))}catch(_){}
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
function businessModelKey(period=businessPeriod,offset=period==='week'?businessSelectedWeekOffset():businessSelectedDayOffset()){
 const bounds=period==='month'?businessMonthBounds(0):period==='week'?businessWeekBounds(offset):businessDayBounds(offset);
 return period+':'+bounds.start;
}
function businessPeriodBounds(){return businessPeriod==='month'?businessMonthBounds(0):businessPeriod==='week'?businessWeekBounds(businessSelectedWeekOffset()):businessDayBounds(businessSelectedDayOffset())}
function businessIsoDate(ts){const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Almaty',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(ts)),part=type=>parts.find(x=>x.type===type)?.value;return part('year')+'-'+part('month')+'-'+part('day')}
function businessWeekStart(which=0){
 const today=businessDayBounds(0).start,mondayOffset=(new Date(today+5*3600000).getUTCDay()+6)%7;
 return new Date(today-mondayOffset*86400000+Number(which||0)*7*86400000);
}
function businessWeekBounds(which=0){
 const start=businessWeekStart(which).getTime();
 return {start,end:start+7*86400000,days:7,label:which===0?'Эта неделя':'Вся неделя'};
}
function businessMonthStart(which=0){const today=businessDayStart();return new Date(today.getFullYear(),today.getMonth()+Number(which||0),1)}
function businessMonthBounds(which=0){
 const start=businessMonthStart(which),end=new Date(start.getFullYear(),start.getMonth()+1,1);
 return {start:start.getTime(),end:end.getTime(),days:Math.round((end-start)/86400000),label:which===-1?'Прошлый месяц':'Этот месяц'};
}
function businessEmptyBucket(start,end,label){return {start,end,label,orders:0,orderQty:0,orderProfit:0,buyouts:0,buyoutQty:0,buyoutBaseProfit:0,buyoutProfit:0,coreBuyouts:0,coreBuyoutQty:0,coreBuyoutBaseProfit:0,coreBuyoutProfit:0,ozonBuyouts:0,ozonBuyoutQty:0,ozonBuyoutBaseProfit:0,ozonBuyoutProfit:0,netProfit:0}}
function businessBuckets(period,bounds){
 const rows=[];
 if(period==='week'){for(let i=0;i<7;i++){const s=bounds.start+i*86400000;rows.push(businessEmptyBucket(s,s+86400000,BUSINESS_WEEKDAYS[i]))}return rows}
 if(period==='month'){const cursor=new Date(bounds.start);while(cursor.getTime()<bounds.end){const s=cursor.getTime();cursor.setDate(cursor.getDate()+1);rows.push(businessEmptyBucket(s,cursor.getTime(),String(new Date(s).getDate())))}return rows}
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
function businessLocalBuyouts(bounds,buckets,unitMap){
 const rows=(typeof financialSales==='function'?financialSales():[]).filter(s=>{
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
 const ozonHourlyNote=model?.hourly?.ozonHourlyComplete===false?' · Ozon без точного часа выкупа':'';
 const map={
  orders:{label:'Заказы',value:model.orders.amount,meta:model.orders.qty.toLocaleString('ru-RU')+' шт. · '+model.orders.orderCount.toLocaleString('ru-RU')+' заказов',field:'orders'},
  buyouts:{label:'Выкупы',value:model.summary.revenue,meta:model.summary.qty.toLocaleString('ru-RU')+' шт.'+ozonHourlyNote,field:'buyouts'},
  orderProfit:{label:'Прибыль с заказов · прогноз',value:model.orders.profit,meta:'покрытие расчётом '+Math.round(model.orders.coverage*100)+'%',field:'orderProfit'},
  buyoutProfit:{label:'Прибыль с выкупов',value:model.summary.profit,estimated:Boolean(model.summary.estimated),meta:(model.summary.estimated?'≈ по данным маркетплейсов':'по данным маркетплейсов')+ozonHourlyNote,field:'buyoutProfit'}
 };
 return map[businessMetric]||map.orders;
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
 .business-axis-caption{grid-column:2;grid-row:2;font-size:9px;color:var(--muted);padding-top:6px;text-align:right}
 .business-detail-btn{border:1px solid var(--line);background:var(--bg);border-radius:12px;padding:8px 10px;font:inherit;white-space:nowrap}
 @media(max-width:560px){.business-dashboard{padding:12px;border-radius:20px}.business-value{font-size:25px}.business-chart-frame{grid-template-columns:minmax(0,1fr) 42px;grid-template-rows:158px 24px}.business-metrics button{font-size:12px;padding:8px 5px}.business-bar,.business-yesterday-bar{left:20%;width:60%}}
 `;document.head.appendChild(style);
}
function businessEnsureUi(){
 const reports=document.getElementById('reports');if(!reports)return null;let root=document.getElementById('businessDashboard');
 if(root){businessInstallDaySwipe();return root}businessEnsureStyle();root=document.createElement('div');root.id='businessDashboard';root.className='business-dashboard';
 root.innerHTML=`<div class="business-top"><div><h3 id="businessPeriodTitle">Сегодня</h3><div id="businessPeriodSub" class="business-sub">Kaspi + WB1 + WB2 + Ozon · по часам</div></div><div class="business-periods"><button type="button" data-business-period="day" onclick="setBusinessDashboardPeriod('day')">Сегодня</button><button type="button" data-business-period="week" onclick="setBusinessDashboardPeriod('week')">Неделя</button><button type="button" data-business-period="month" onclick="setBusinessDashboardPeriod('month')">Месяц</button><button class="business-detail-btn" type="button" onclick="renderBusinessDashboard(true)">↻</button></div></div>
 <div class="business-metrics">${[['orders','Заказы'],['buyouts','Выкупы'],['orderProfit','Прибыль заказов'],['buyoutProfit','Прибыль выкупов']].map(([k,v])=>`<button type="button" data-business-metric="${k}" onclick="setBusinessDashboardMetric('${k}')">${v}</button>`).join('')}</div>
 <div id="businessDayNav" class="business-day-nav"><button id="businessDayPrevious" type="button" aria-label="Предыдущий день" onclick="shiftBusinessDashboardSelection(-1)">‹</button><span id="businessDayDate"></span><button id="businessDayNext" type="button" aria-label="Следующий день" onclick="shiftBusinessDashboardSelection(1)">›</button></div>
 <div class="business-value-card"><div id="businessValueMetric" class="business-value-title">Загрузка…</div><div class="business-value-grid"><div class="business-value-side"><div id="businessValueLabel" class="business-value-label">Сегодня</div><div id="businessValue" class="business-value">—</div><div id="businessValueMeta" class="business-value-meta"></div></div><div class="business-value-side business-yesterday-side"><div id="businessYesterdayLabel" class="business-value-label">Вчера</div><div id="businessYesterdayValue" class="business-value">—</div><div id="businessYesterdayMeta" class="business-value-meta"></div></div></div><div id="businessYesterdayCompare" class="business-compare"></div></div>
 <div id="businessChart" class="business-chart"></div>`;
 const title=reports.querySelector('h2');if(title)title.insertAdjacentElement('afterend',root);else reports.prepend(root);businessInstallDaySwipe();return root;
}
function businessInstallDaySwipe(){
 const chart=document.getElementById('businessChart');if(!chart||chart.dataset.daySwipe==='1')return;chart.dataset.daySwipe='1';
 let gesture=null;
 chart.addEventListener('touchstart',event=>{gesture=null;if(!['day','week'].includes(businessPeriod)||event.touches.length!==1)return;const t=event.touches[0];gesture={id:t.identifier,x:t.clientX,y:t.clientY,vertical:false,key:businessModelKey()};},{passive:true});
 chart.addEventListener('touchmove',event=>{if(!gesture)return;if(event.touches.length!==1){gesture=null;return}const t=event.touches[0],dx=t.clientX-gesture.x,dy=t.clientY-gesture.y;if(Math.abs(dy)>12&&Math.abs(dy)>Math.abs(dx))gesture.vertical=true;if(!gesture.vertical&&Math.abs(dx)>12&&Math.abs(dx)>Math.abs(dy)*1.5&&event.cancelable)event.preventDefault();},{passive:false});
 chart.addEventListener('touchend',event=>{const start=gesture;gesture=null;if(!start||start.vertical||!['day','week'].includes(businessPeriod)||start.key!==businessModelKey()||event.touches.length)return;const t=Array.from(event.changedTouches).find(x=>x.identifier===start.id);if(!t)return;const dx=t.clientX-start.x,dy=t.clientY-start.y;if(Math.abs(dx)>=50&&Math.abs(dx)>Math.abs(dy)*1.5)window.shiftBusinessDashboardSelection(dx>0?-1:1);},{passive:true});
 chart.addEventListener('touchcancel',()=>{gesture=null;},{passive:true});
}
function businessPaintTabs(){
 document.querySelectorAll('[data-business-metric]').forEach(x=>x.classList.toggle('active',x.dataset.businessMetric===businessMetric));
 document.querySelectorAll('[data-business-period]').forEach(x=>x.classList.toggle('active',x.dataset.businessPeriod===businessPeriod));
 const title=document.getElementById('businessPeriodTitle'),sub=document.getElementById('businessPeriodSub');
 const week=businessPeriod==='week',offset=week?businessSelectedWeekOffset():businessSelectedDayOffset(),bounds=week?businessWeekBounds(offset):businessDayBounds(offset),nav=document.getElementById('businessDayNav'),dayDate=document.getElementById('businessDayDate'),previous=document.getElementById('businessDayPrevious'),next=document.getElementById('businessDayNext');
 if(nav)nav.hidden=businessPeriod==='month';if(previous){previous.disabled=offset<=-(week?BUSINESS_WEEK_HISTORY:BUSINESS_DAY_HISTORY);previous.setAttribute('aria-label',week?'Предыдущая неделя':'Предыдущий день')}if(next){next.disabled=offset>=0;next.setAttribute('aria-label',week?'Следующая неделя':'Следующий день')}
 if(dayDate)dayDate.innerHTML=(week?businessShortDate(bounds.start)+' – '+businessShortDate(bounds.end-86400000)+' · '+(offset===0?'эта неделя':'вся неделя'):businessShortDate(bounds.start)+' · '+(offset===0?'сегодня':offset===-1?'вчера':'весь день'))+'<small>Свайп по графику ← →</small>';
 if(title)title.textContent=businessPeriod==='month'?'Месяц':businessPeriod==='week'?'Неделя':offset===0?'Сегодня':bounds.label;
 if(sub)sub.textContent=businessPeriod==='day'?'Kaspi + WB1 + WB2 + Ozon · по часам':'Kaspi + WB1 + WB2 + Ozon · по дням';
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
 const month=model.period==='month',week=model.period==='week',past=Number(model.dayOffset)<0,pastWeek=week&&Number(model.weekOffset)<0,count=month||week?model.buckets.length:24,currentName=month?'этот':week?(pastWeek?businessShortDate(model.bounds.start)+' – '+businessShortDate(model.bounds.end-86400000):'эта'):past?businessShortDate(model.bounds.start):'сегодня',previousName=month?'прошлый':week?(pastWeek?businessShortDate(model.yesterday.bounds.start)+' – '+businessShortDate(model.yesterday.bounds.end-86400000):'прошлая'):past?businessShortDate(model.yesterday.bounds.start):'вчера';
 const values=model.buckets.map(x=>Number(x[field])||0),yesterdayValues=(model.yesterday?.buckets||[]).map(x=>Number(x[field])||0),scale=businessChartScale([...values,...yesterdayValues]),range=Math.max(1e-9,scale.max-scale.min),toPct=v=>(v-scale.min)/range*100,zeroPct=toPct(0);
 const lines=scale.ticks.map(v=>`<div class="business-grid-line" style="bottom:${toPct(v)}%"></div>`).join('');
 const ticks=scale.ticks.map(v=>`<div class="business-y-tick" style="bottom:${toPct(v)}%">${businessAxisNumber(v)}</div>`).join('');
 const bars=model.buckets.map((b,i)=>{
  const v=values[i],yv=Number(yesterdayValues[i])||0,
    vPct=toPct(v),bottom=Math.min(vPct,zeroPct),height=Math.abs(vPct-zeroPct),
    yPct=toPct(yv),yBottom=Math.min(yPct,zeroPct),yHeight=Math.abs(yPct-zeroPct),
    sameSide=(v>=0&&yv>=0)||(v<=0&&yv<=0),
    equal=sameSide&&Math.abs(v-yv)<0.005,
    yesterdayShorter=sameSide&&!equal&&Math.abs(yv)<Math.abs(v),
    todayShorter=sameSide&&!equal&&Math.abs(v)<Math.abs(yv),
    todayZ=todayShorter||equal?3:2,yesterdayZ=yesterdayShorter?3:1,
    todayBottom=equal&&v<0?`calc(${bottom}% + 3px)`:`${bottom}%`,
    todayHeight=equal?`calc(${Math.max(0,height)}% - 3px)`:`${Math.max(v===0?0:1.2,height)}%`;
  const title=month?b.label+' · этот '+businessMoney(v)+' · прошлый '+businessMoney(yv):week?b.label+' · '+currentName+' '+businessMoney(v)+' · '+previousName+' '+businessMoney(yv):b.label+':00 · '+currentName+' '+businessMoney(v)+' · '+previousName+' '+businessMoney(yv);
  return `<div class="business-hour" title="${title}"><div class="business-yesterday-bar ${yv<0?'negative':''}" style="bottom:${yBottom}%;height:${Math.max(yv===0?0:1.2,yHeight)}%;z-index:${yesterdayZ}"></div><div class="business-bar ${v<0?'negative':''}" style="bottom:${todayBottom};height:${todayHeight};z-index:${todayZ}"></div></div>`;
 }).join('');
 const labels=month?[1,8,15,22,count].filter((d,i,all)=>d>=1&&d<=count&&all.indexOf(d)===i).map(d=>`<div class="business-x-label" style="left:${(d-.5)/count*100}%">${d}</div>`).join(''):week?BUSINESS_WEEKDAYS.map((name,i)=>`<div class="business-x-label" style="left:${(i+.5)/count*100}%">${name}</div>`).join(''):[3,6,9,12,15,18,21,24].map(h=>`<div class="business-x-label" style="left:${h===24?100:((h-.5)/24*100)}%">${String(h).padStart(2,'0')}</div>`).join('');
 box.innerHTML=`<div class="business-chart-legend"><span class="business-legend-today">${currentName}</span><span class="business-legend-yesterday">${previousName}</span></div><div class="business-chart-frame"><div class="business-plot">${lines}<div class="business-bars${month?' month':week?' week':''}"${month?' style="grid-template-columns:repeat('+count+',minmax(0,1fr))"':''}>${bars}</div></div><div class="business-y-axis">${ticks}</div><div class="business-x-axis">${labels}</div><div class="business-axis-caption">₸</div></div>`;
}

async function businessLoadSummary(days,force=false,range=null){
 const spec=days&&typeof days==='object'?days:{days,range},span=spec.range||null,key=span?'range:'+span.from+':'+span.to:String(spec.days),old=businessSummaryCache.get(key);
 if(!force&&old?.data&&Date.now()-Number(old.at||0)<60000)return old.data;if(!force&&old?.promise)return old.promise;
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
 return {revenue,qty,profit:rows.length&&profitKnown?profit:null,estimated:estimated||!profitKnown};
}
async function businessApplyRangeBuyouts(buckets,bounds,force){
 const range={from:businessIsoDate(bounds.start),to:businessIsoDate(bounds.end-86400000)},local=businessLocalBuyouts(bounds,buckets,window.allMarketUnitProfit30),summary=await businessLoadSummary(0,force,range),hourly=businessNormalizeBuyoutBuckets(buckets,local,summary);
 return {local,summary,hourly};
}
async function businessBuildCalendarSnapshot(period,which,force=false,todaySnapshot=null,history=null){
 const bounds=period==='month'?businessMonthBounds(which):businessWeekBounds(which),buckets=businessBuckets(period,bounds),todayStart=period==='week'?businessDayBounds(0).start:businessDayStart().getTime(),activeEnd=which===0?Math.min(bounds.end,todayStart+86400000):bounds.end,orders=businessEstimateOrders(businessOrderGroups({start:bounds.start,end:activeEnd},history),buckets,window.allMarketUnitProfit30);
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
async function businessBuildMonthSnapshot(which,force=false,todaySnapshot=null){return businessBuildCalendarSnapshot('month',which,force,todaySnapshot)}
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
function businessCalendarSamePoint(fullSpan,period){
 const origin=period==='month'?businessMonthBounds(0).start:businessWeekStart(0).getTime(),elapsed=Math.max(0,Date.now()-origin),cutoff=Math.min(fullSpan.bounds.end,fullSpan.bounds.start+elapsed),
   orderBuckets=businessBuckets(period,fullSpan.bounds),orders=businessEstimateOrders(businessOrderGroups({start:fullSpan.bounds.start,end:cutoff}),orderBuckets,window.allMarketUnitProfit30);
 let revenue=0,qty=0,profit=0;
 for(const bucket of fullSpan.buckets){const factor=cutoff<=bucket.start?0:cutoff>=bucket.end?1:(cutoff-bucket.start)/Math.max(1,bucket.end-bucket.start);revenue+=(Number(bucket.buyouts)||0)*factor;qty+=(Number(bucket.buyoutQty)||0)*factor;profit+=(Number(bucket.buyoutProfit)||0)*factor}
 const summary={...fullSpan.summary,revenue,qty:Math.round(qty),profit};
 return {...fullSpan,bounds:{...fullSpan.bounds,end:cutoff},orders,summary,netProfit:profit,comparisonCutoff:cutoff};
}
function businessWeekSamePoint(fullWeek){return businessCalendarSamePoint(fullWeek,'week')}
function businessMonthSamePoint(fullMonth){return businessCalendarSamePoint(fullMonth,'month')}
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
 const key=String(bounds.start),cached=businessWeekOrderCache.get(key);
 if(!force&&cached&&Date.now()-cached.at<60000)return cached.rows;
 const data=await apiJson(MILLIONER_API+'/api/orders?limit=15000&after='+encodeURIComponent(bounds.start));
 if(data?.ok===false||!Array.isArray(data?.orders)||data.orders.length>=15000)throw new Error('Не удалось загрузить полную историю заказов');
 const rows=data.orders.filter(row=>['Kaspi','WB','WB2'].includes(String(row.market)));
 businessWeekOrderCache.set(key,{rows,at:Date.now()});return rows;
}
async function businessBuildModel(force=false,period=businessPeriod,dayOffset=businessSelectedDayOffset(),weekOffset=businessSelectedWeekOffset()){
 const selectedBounds=businessDayBounds(dayOffset),previousBounds=businessDayBounds(dayOffset-1);
 const warm=[];
 if(typeof window.ozonFboRefreshStatus==='function')warm.push(Promise.resolve().then(()=>window.ozonFboRefreshStatus()));
 if(typeof window.refreshAllMarketUnitProfit==='function'&&(!(window.allMarketUnitProfit30 instanceof Map)||force))warm.push(Promise.resolve().then(()=>window.refreshAllMarketUnitProfit()));
 if(warm.length)await Promise.allSettled(warm);
 if(period==='week'||period==='month'){
  const selected=period==='week'?weekOffset:0,build=period==='month'?businessBuildMonthSnapshot:businessBuildWeekSnapshot,samePoint=period==='month'?businessMonthSamePoint:businessWeekSamePoint;
  let history=null;
  if(period==='week'&&selected<0){const span={start:businessWeekBounds(selected-1).start,end:businessWeekBounds(selected).end};
   if(typeof window.ozonFboOrderHistoryCovers==='function'&&!window.ozonFboOrderHistoryCovers(span)){const error=new Error('История Ozon для этой недели загружается');error.businessHistoryPending=true;throw error}
   history=[...await businessLoadWeekOrderHistory(span,force),...(state.ozonOrderFeed||[]).map(row=>({...row,market:'Ozon'}))];
  }
  const today=selected===0?await businessBuildDaySnapshot(businessDayBounds(0),1,force):null,[current,previous]=await Promise.all([build(selected,force,today,history),build(selected-1,force,null,history)]),previousCompare=selected===0?samePoint(previous):previous;
  return {...current,weekOffset:period==='week'?selected:undefined,yesterday:previous,yesterdayCompare:previousCompare};
 }
 const [today,yesterday]=await Promise.all([businessBuildDaySnapshot(selectedBounds,businessDaySummarySpec(dayOffset,selectedBounds),force),businessBuildDaySnapshot(previousBounds,businessDaySummarySpec(dayOffset-1,previousBounds),force)]),yesterdayCompare=businessYesterdaySameTime(yesterday);
 return {...today,dayOffset,yesterday,yesterdayCompare:dayOffset===0?yesterdayCompare:yesterday};
}

function businessShowSelection(){businessRenderSeq++;businessLastModel=null;businessSaveUi();businessPaintTabs();const cached=businessModels.get(businessModelKey());if(cached)businessPaint(cached);else return window.renderBusinessDashboard(false)}
window.shiftBusinessDashboardDay=function(direction){if(businessPeriod!=='day'||![-1,1].includes(direction))return;const current=businessSelectedDayOffset(),next=Math.max(-BUSINESS_DAY_HISTORY,Math.min(0,current+direction));if(next===current)return;businessDayDate=next===0?'':businessIsoDate(businessDayBounds(next).start);return businessShowSelection()};
window.shiftBusinessDashboardWeek=function(direction){if(businessPeriod!=='week'||![-1,1].includes(direction))return;const current=businessSelectedWeekOffset(),next=Math.max(-BUSINESS_WEEK_HISTORY,Math.min(0,current+direction));if(next===current)return;businessWeekDate=next===0?'':businessIsoDate(businessWeekBounds(next).start);return businessShowSelection()};
window.shiftBusinessDashboardSelection=function(direction){return businessPeriod==='week'?window.shiftBusinessDashboardWeek(direction):window.shiftBusinessDashboardDay(direction)};
window.setBusinessDashboardMetric=function(metric){if(!BUSINESS_METRICS.has(metric))return;businessMetric=metric;businessSaveUi();if(businessLastModel&&businessLastModel.period+':'+businessLastModel.bounds.start===businessModelKey())businessPaint(businessLastModel);else return window.renderBusinessDashboard(false)};
window.setBusinessDashboardPeriod=function(period){if(!BUSINESS_PERIODS.has(period))return;if(period===businessPeriod&&(period==='month'||(period==='day'?businessSelectedDayOffset():businessSelectedWeekOffset())===0))return;businessPeriod=period;if(period==='day')businessDayDate='';if(period==='week')businessWeekDate='';return businessShowSelection()};
function businessComparison(current,previous){
 if(current===null||current===undefined||previous===null||previous===undefined||!Number.isFinite(Number(current))||!Number.isFinite(Number(previous)))return {html:''};
 const now=Number(current),prev=Number(previous),delta=now-prev,cls=Math.abs(delta)<.005?'flat':delta>0?'up':'down',sign=delta>0?'+':'',pct=prev!==0?delta/Math.abs(prev)*100:null,pctText=pct===null?'':(' · '+(pct>0?'+':'')+Math.round(pct)+'%');
 return {html:'<span class="business-compare-label">разница</span><span class="business-compare-delta '+cls+'">'+sign+businessMoney(delta)+pctText+'</span>'};
}
function businessPaint(model){
 businessLastModel=model;if(model?.period)businessModels.set(model.period+':'+model.bounds.start,model);businessPaintTabs();const week=model.period==='week',month=model.period==='month',past=Number(model.dayOffset)<0,pastWeek=week&&Number(model.weekOffset)<0,info=businessMetricInfo(model),full=model.yesterday,same=model.yesterdayCompare||full,fullInfo=full?businessMetricInfo(full):null,sameInfo=same?businessMetricInfo(same):null,
 metric=document.getElementById('businessValueMetric'),label=document.getElementById('businessValueLabel'),value=document.getElementById('businessValue'),meta=document.getElementById('businessValueMeta'),
 yLabel=document.getElementById('businessYesterdayLabel'),yValue=document.getElementById('businessYesterdayValue'),yMeta=document.getElementById('businessYesterdayMeta'),
 compare=document.getElementById('businessYesterdayCompare');
 if(metric)metric.textContent=info.label;if(label)label.textContent=month?businessShortDate(model.bounds.start)+' – '+businessShortDate(Math.min(Date.now(),model.bounds.end-1))+' · этот месяц':week?businessShortDate(model.bounds.start)+' – '+businessShortDate(Math.min(Date.now(),model.bounds.end-1))+(pastWeek?' · вся неделя':' · эта неделя'):businessShortDate(model.bounds.start)+(past?' · весь день':' · сегодня');if(value)value.textContent=businessMaybeMoney(info.value,Boolean(info.estimated));if(meta)meta.textContent=info.meta;
 if(yLabel)yLabel.textContent=full?(month?businessShortDate(full.bounds.start)+' – '+businessShortDate(full.bounds.end-86400000)+' · весь месяц':week?businessShortDate(full.bounds.start)+' – '+businessShortDate(full.bounds.end-86400000)+' · вся неделя':businessShortDate(full.bounds.start)+' · весь день'):(month?'Прошлый месяц':week?'Прошлая неделя':'Вчера');
 if(yValue)yValue.textContent=fullInfo?businessMaybeMoney(fullInfo.value,Boolean(fullInfo.estimated)):'—';if(yMeta)yMeta.textContent=fullInfo?fullInfo.meta:'';
 if(compare){const until=same?businessHourMinute(same.comparisonCutoff||same.bounds.end):'',mark=same?same.comparisonCutoff||same.bounds.end:0,phrase=month?'прошлый до '+new Date(mark).getDate()+' '+until:week?(pastWeek?businessShortDate(full.bounds.start)+' – '+businessShortDate(full.bounds.end-86400000)+' · вся неделя':'прошлая до '+businessWeekdayName(mark)+' '+until):past?businessShortDate(full.bounds.start)+' · весь день':'вчера до '+until;compare.innerHTML=(sameInfo?businessComparison(info.value,sameInfo.value).html:'')+(until&&sameInfo?'<span class="business-compare-label">'+phrase+' · '+businessMaybeMoney(sameInfo.value,Boolean(sameInfo.estimated))+'</span>':'')}
 businessPaintChart(model,info.field);
}
window.renderBusinessDashboard=async function(force=false){
 const root=businessEnsureUi();if(!root)return;if(!document.getElementById('reports')?.classList.contains('active')){businessPaintTabs();return}
 const seq=++businessRenderSeq,key=businessModelKey(),offset=businessSelectedDayOffset();businessLastModel=null;businessPaintTabs();const metric=document.getElementById('businessValueMetric'),label=document.getElementById('businessValueLabel'),value=document.getElementById('businessValue'),meta=document.getElementById('businessValueMeta'),yLabel=document.getElementById('businessYesterdayLabel'),yValue=document.getElementById('businessYesterdayValue'),yMeta=document.getElementById('businessYesterdayMeta'),compare=document.getElementById('businessYesterdayCompare'),chart=document.getElementById('businessChart');
 if(force)businessModels.delete(key);if(metric)metric.textContent='Считаю бизнес-показатели…';if(label)label.textContent=businessPeriod==='month'?'Этот месяц':businessPeriod==='week'?businessWeekBounds(businessSelectedWeekOffset()).label:businessDayBounds(offset).label;if(value)value.textContent='…';if(meta)meta.textContent='';if(yLabel)yLabel.textContent=businessPeriod==='month'?'Прошлый месяц':businessPeriod==='week'?businessWeekBounds(businessSelectedWeekOffset()-1).label:businessDayBounds(offset-1).label;if(yValue)yValue.textContent='…';if(yMeta)yMeta.textContent='';if(compare)compare.innerHTML='';if(chart)chart.innerHTML='';
 try{const model=await businessBuildModel(force);if(seq!==businessRenderSeq||key!==businessModelKey())return;businessPaint(model)}
 catch(error){if(seq!==businessRenderSeq||key!==businessModelKey())return;if(label)label.textContent=error.businessHistoryPending?error.message:'Не удалось посчитать';if(value)value.textContent='—'}
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
