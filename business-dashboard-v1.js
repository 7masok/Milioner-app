(function(){
'use strict';
if(typeof window==='undefined')return;

const BUSINESS_SUPPORTED_MARKETS=new Set(['Kaspi','WB','WB2','Ozon']);
const BUSINESS_PERIODS=new Set(['today','yesterday','week','prevweek']);
const BUSINESS_METRICS=new Set(['orders','buyouts','orderProfit','buyoutProfit']);
const BUSINESS_UI_KEY='milioner_business_dashboard_v2';
let businessRenderSeq=0,businessSummaryCache=new Map(),businessLastModel=null;
let businessPeriod='today',businessMetric='orders';
try{
 const saved=JSON.parse(localStorage.getItem(BUSINESS_UI_KEY)||'{}');
 if(BUSINESS_PERIODS.has(saved.period))businessPeriod=saved.period;
 if(saved.metric==='netProfit')businessMetric='buyoutProfit';
 else if(BUSINESS_METRICS.has(saved.metric))businessMetric=saved.metric;
}catch(_){}

function businessSaveUi(){
 try{localStorage.setItem(BUSINESS_UI_KEY,JSON.stringify({period:businessPeriod,metric:businessMetric}))}catch(_){}
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
 const start=businessDayStart();start.setDate(start.getDate()+Number(offset||0));const end=new Date(start);end.setDate(end.getDate()+1);
 return {start:start.getTime(),end:end.getTime(),days:offset===-1?-1:1,label:offset===0?'Сегодня':offset===-1?'Вчера':businessShortDate(start.getTime())};
}
function businessMondayStart(date=new Date()){
 const d=businessDayStart(date),shift=(d.getDay()+6)%7;d.setDate(d.getDate()-shift);return d;
}
function businessWeekBounds(offsetWeeks=0){
 const start=businessMondayStart();start.setDate(start.getDate()+Number(offsetWeeks||0)*7);const end=new Date(start);end.setDate(end.getDate()+7);
 return {start:start.getTime(),end:end.getTime(),days:7,label:offsetWeeks===0?'Неделя':'Прошлая неделя'};
}
function businessLocalDate(ts){
 const d=new Date(ts),y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,'0'),day=String(d.getDate()).padStart(2,'0');return y+'-'+m+'-'+day;
}
function businessRangeForBounds(bounds,endTs=bounds.end){
 const last=Math.max(bounds.start,Math.min(bounds.end-1,Number(endTs)-1));return {from:businessLocalDate(bounds.start),to:businessLocalDate(last)};
}
function businessPeriodBounds(){return businessPeriod==='week'?businessWeekBounds(0):businessPeriod==='prevweek'?businessWeekBounds(-1):businessPeriod==='yesterday'?businessDayBounds(-1):businessDayBounds(0)}
function businessBuckets(period,bounds){
 const rows=[],push=(start,end,label)=>rows.push({start,end,label,orders:0,orderQty:0,orderProfit:0,buyouts:0,buyoutQty:0,buyoutBaseProfit:0,buyoutProfit:0,coreBuyouts:0,coreBuyoutQty:0,coreBuyoutBaseProfit:0,coreBuyoutProfit:0,ozonBuyouts:0,ozonBuyoutQty:0,ozonBuyoutBaseProfit:0,ozonBuyoutProfit:0,netProfit:0});
 if(period==='week'){
  const labels=['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];
  for(let i=0;i<7;i++){const d=new Date(bounds.start);d.setDate(d.getDate()+i);const next=new Date(d);next.setDate(next.getDate()+1);push(d.getTime(),next.getTime(),labels[i])}
 }else{
  for(let h=0;h<24;h++){const s=bounds.start+h*3600000;push(s,s+3600000,String(h).padStart(2,'0'))}
 }
 return rows;
}
function businessBucketFor(rows,ts){return rows.find(x=>ts>=x.start&&ts<x.end)||null}
function businessLineAmount(line,qty=Math.max(0,Number(line?.qty)||0)){
 const total=Math.max(0,Number(line?.totalPrice)||0);if(total>0)return total;
 return qty*Math.max(0,Number(line?.unitPrice)||0);
}
function businessOrderGroups(bounds){
 const feed=[
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
 .business-top{display:flex;align-items:center;justify-content:space-between;gap:10px}.business-top h3{margin:0}.business-sub{font-size:12px;color:var(--muted);margin-top:3px}
 .business-periods{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:5px;margin-top:11px}.business-periods button{min-width:0;border:1px solid var(--line);background:var(--bg);border-radius:11px;padding:7px 3px;font:inherit;font-size:11px;line-height:1.1;white-space:nowrap}.business-periods button.active{background:#111;color:#fff;border-color:#111}
 .business-metrics{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:9px}.business-metrics button{min-width:0;border:1px solid var(--line);background:var(--bg);border-radius:14px;padding:9px 7px;font:inherit;font-size:13px;line-height:1.15}.business-metrics button.active{background:#111;color:#fff;border-color:#111}
 .business-value-card{margin-top:12px;padding:13px 14px;border-radius:18px;background:var(--bg)}.business-value-title{font-size:13px;color:var(--muted);margin-bottom:8px}.business-value-grid{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,.9fr);gap:18px;align-items:start}.business-value-side{min-width:0}.business-yesterday-side{text-align:right}.business-value-label{font-size:12px;color:var(--muted)}.business-value{font-size:28px;font-weight:800;margin-top:3px;white-space:nowrap}.business-yesterday-side .business-value{font-size:20px;color:#666}.business-value-meta{font-size:12px;color:var(--muted);margin-top:4px}.business-compare{font-size:12px;margin-top:9px;display:flex;gap:6px;align-items:center;flex-wrap:wrap}.business-compare-label{color:var(--muted)}.business-compare-delta{font-weight:700}.business-compare-delta.up{color:#138a55}.business-compare-delta.down{color:#b42318}.business-compare-delta.flat{color:var(--muted)}
 .business-chart{margin-top:13px}.business-chart-legend{display:flex;justify-content:flex-end;gap:12px;align-items:center;font-size:10px;color:var(--muted);margin:0 48px 5px 0}.business-legend-today,.business-legend-yesterday{display:inline-flex;align-items:center;gap:5px}.business-legend-today:before{content:'';width:8px;height:8px;border-radius:2px;background:#111;display:inline-block}.business-legend-yesterday:before{content:'';width:8px;height:8px;border-radius:2px;background:#d1d1d6;border-top:2px solid #9d9da3;box-sizing:border-box;display:inline-block}.business-chart-frame{display:grid;grid-template-columns:minmax(0,1fr) 48px;grid-template-rows:172px 25px;column-gap:4px;width:100%}
 .business-plot{position:relative;grid-column:1;grid-row:1;min-width:0;border-bottom:1px solid var(--line)}
 .business-grid-line{position:absolute;left:0;right:0;border-top:1px dashed var(--line);pointer-events:none}
 .business-bars{position:absolute;inset:0;display:grid;grid-template-columns:repeat(24,minmax(0,1fr));align-items:stretch}
 .business-hour{position:relative;min-width:0}.business-yesterday-bar,.business-bar{position:absolute;left:24%;width:52%;min-height:1px}.business-yesterday-bar{border-radius:5px 5px 1px 1px;background:#d1d1d6;border-top:3px solid #9d9da3;box-sizing:border-box}.business-yesterday-bar.negative{border-radius:1px 1px 5px 5px;border-top:0;border-bottom:3px solid #9d9da3}.business-bar{border-radius:5px 5px 1px 1px;background:#111}.business-bar.negative{border-radius:1px 1px 5px 5px;background:#8d2222}
 .business-y-axis{grid-column:2;grid-row:1;position:relative;font-size:10px;color:var(--muted)}.business-y-tick{position:absolute;right:0;transform:translateY(50%);white-space:nowrap}
 .business-x-axis{grid-column:1;grid-row:2;position:relative;height:24px;padding-top:6px;font-size:9px;color:var(--muted)}.business-x-label{position:absolute;top:6px;white-space:nowrap;transform:translateX(-50%);text-align:center}
 .business-axis-caption{grid-column:2;grid-row:2;font-size:9px;color:var(--muted);padding-top:6px;text-align:right}
 .business-detail-btn{border:1px solid var(--line);background:var(--bg);border-radius:12px;padding:8px 10px;font:inherit;white-space:nowrap}
 @media(max-width:560px){.business-dashboard{padding:12px;border-radius:20px}.business-value{font-size:25px}.business-chart-frame{grid-template-columns:minmax(0,1fr) 42px;grid-template-rows:158px 24px}.business-periods button{font-size:10.5px;padding:7px 2px}.business-metrics button{font-size:12px;padding:8px 5px}.business-bar,.business-yesterday-bar{left:20%;width:60%}}
 `;document.head.appendChild(style);
}
function businessEnsureUi(){
 const reports=document.getElementById('reports');if(!reports)return null;let root=document.getElementById('businessDashboard');
 if(root)return root;businessEnsureStyle();root=document.createElement('div');root.id='businessDashboard';root.className='business-dashboard';
 root.innerHTML=`<div class="business-top"><div><h3 id="businessPeriodTitle">Сегодня</h3><div id="businessPeriodSub" class="business-sub">Kaspi + WB1 + WB2 + Ozon · по часам</div></div><button class="business-detail-btn" type="button" onclick="renderBusinessDashboard(true)">↻</button></div>
 <div class="business-periods">${[['today','Сегодня'],['yesterday','Вчера'],['week','Неделя'],['prevweek','Прошлая']].map(([k,v])=>`<button type="button" data-business-period="${k}" onclick="setBusinessDashboardPeriod('${k}')">${v}</button>`).join('')}</div>
 <div class="business-metrics">${[['orders','Заказы'],['buyouts','Выкупы'],['orderProfit','Прибыль заказов'],['buyoutProfit','Прибыль выкупов']].map(([k,v])=>`<button type="button" data-business-metric="${k}" onclick="setBusinessDashboardMetric('${k}')">${v}</button>`).join('')}</div>
 <div class="business-value-card"><div id="businessValueMetric" class="business-value-title">Загрузка…</div><div class="business-value-grid"><div class="business-value-side"><div id="businessValueLabel" class="business-value-label">Сегодня</div><div id="businessValue" class="business-value">—</div><div id="businessValueMeta" class="business-value-meta"></div></div><div class="business-value-side business-yesterday-side"><div id="businessYesterdayLabel" class="business-value-label">Вчера</div><div id="businessYesterdayValue" class="business-value">—</div><div id="businessYesterdayMeta" class="business-value-meta"></div></div></div><div id="businessYesterdayCompare" class="business-compare"></div></div>
 <div id="businessChart" class="business-chart"></div>`;
 const title=reports.querySelector('h2');if(title)title.insertAdjacentElement('afterend',root);else reports.prepend(root);return root;
}
function businessPaintTabs(){
 document.querySelectorAll('[data-business-period]').forEach(x=>x.classList.toggle('active',x.dataset.businessPeriod===businessPeriod));
 document.querySelectorAll('[data-business-metric]').forEach(x=>x.classList.toggle('active',x.dataset.businessMetric===businessMetric));
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
 const comparison=model.comparison||model.yesterday||null,
  values=model.buckets.map(x=>Number(x[field])||0),yesterdayValues=(comparison?.buckets||[]).map(x=>Number(x[field])||0),
  scale=businessChartScale([...values,...yesterdayValues]),range=Math.max(1e-9,scale.max-scale.min),toPct=v=>(v-scale.min)/range*100,zeroPct=toPct(0),
  isWeek=model.chartMode==='week',currentLegend=model.legendCurrent||(isWeek?'эта неделя':'сегодня'),comparisonLegend=model.legendComparison||(isWeek?'прошлая':'вчера');
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
    todayHeight=equal?`calc(${Math.max(0,height)}% - 3px)`:`${Math.max(v===0?0:1.2,height)}%`,
    tipLabel=isWeek?b.label:(b.label+':00');
  return `<div class="business-hour" title="${tipLabel} · ${currentLegend} ${businessMoney(v)} · ${comparisonLegend} ${businessMoney(yv)}"><div class="business-yesterday-bar ${yv<0?'negative':''}" style="bottom:${yBottom}%;height:${Math.max(yv===0?0:1.2,yHeight)}%;z-index:${yesterdayZ}"></div><div class="business-bar ${v<0?'negative':''}" style="bottom:${todayBottom};height:${todayHeight};z-index:${todayZ}"></div></div>`;
 }).join('');
 const labels=isWeek?model.buckets.map((b,i)=>`<div class="business-x-label" style="left:${((i+.5)/Math.max(1,model.buckets.length))*100}%">${b.label}</div>`).join(''):[3,6,9,12,15,18,21,24].map(h=>`<div class="business-x-label" style="left:${h===24?100:((h-.5)/24*100)}%">${String(h).padStart(2,'0')}</div>`).join('');
 box.innerHTML=`<div class="business-chart-legend"><span class="business-legend-today">${currentLegend}</span><span class="business-legend-yesterday">${comparisonLegend}</span></div><div class="business-chart-frame"><div class="business-plot">${lines}<div class="business-bars" style="grid-template-columns:repeat(${Math.max(1,model.buckets.length)},minmax(0,1fr))">${bars}</div></div><div class="business-y-axis">${ticks}</div><div class="business-x-axis">${labels}</div><div class="business-axis-caption">₸</div></div>`;
}

async function businessLoadSummary(days,force=false){
 const key=String(days),old=businessSummaryCache.get(key);if(!force&&old?.data&&Date.now()-Number(old.at||0)<60000)return old.data;if(!force&&old?.promise)return old.promise;
 if(typeof window.loadBusinessMarketplaceSummary!=='function')throw new Error('Финансовый модуль ещё не загрузился');
 const promise=window.loadBusinessMarketplaceSummary(days,{force}).then(data=>{businessSummaryCache.set(key,{at:Date.now(),data});return data}).catch(e=>{businessSummaryCache.delete(key);throw e});
 businessSummaryCache.set(key,{at:Date.now(),promise});return promise;
}
async function businessLoadRangeSummary(range,force=false){
 const key='range:'+String(range?.from||'')+':'+String(range?.to||''),old=businessSummaryCache.get(key);if(!force&&old?.data&&Date.now()-Number(old.at||0)<60000)return old.data;if(!force&&old?.promise)return old.promise;
 if(typeof window.loadBusinessMarketplaceRangeSummary!=='function')throw new Error('Финансовый модуль периода ещё не загрузился');
 const promise=window.loadBusinessMarketplaceRangeSummary(range,{force}).then(data=>{businessSummaryCache.set(key,{at:Date.now(),data});return data}).catch(e=>{businessSummaryCache.delete(key);throw e});
 businessSummaryCache.set(key,{at:Date.now(),promise});return promise;
}
async function businessBuildDaySnapshot(bounds,summaryDays,force=false){
 const buckets=businessBuckets('day',bounds),groups=businessOrderGroups(bounds),orders=businessEstimateOrders(groups,buckets,window.allMarketUnitProfit30),local=businessLocalBuyouts(bounds,buckets,window.allMarketUnitProfit30),summary=await businessLoadSummary(summaryDays,force),
  hourly=businessNormalizeBuyoutBuckets(buckets,local,summary);
 const netProfit=summary?.profit===null||summary?.profit===undefined||!Number.isFinite(Number(summary.profit))?null:Number(summary.profit);
 return {period:'day',bounds,buckets,orders,local,summary,netProfit,hourly};
}
async function businessBuildRangeSnapshot(bounds,range,period='week',force=false){
 const buckets=businessBuckets(period,bounds),groups=businessOrderGroups(bounds),orders=businessEstimateOrders(groups,buckets,window.allMarketUnitProfit30),local=businessLocalBuyouts(bounds,buckets,window.allMarketUnitProfit30),summary=await businessLoadRangeSummary(range,force),
  hourly=businessNormalizeBuyoutBuckets(buckets,local,summary);
 const netProfit=summary?.profit===null||summary?.profit===undefined||!Number.isFinite(Number(summary.profit))?null:Number(summary.profit);
 return {period,bounds,buckets,orders,local,summary,netProfit,hourly,range};
}
function businessElapsedTodayMs(){
 const start=businessDayStart().getTime();
 return Math.max(0,Math.min(86400000,Date.now()-start));
}
function businessHourMinute(ts){
 return new Date(ts).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'});
}
function businessShortDate(ts){
 return new Date(ts).toLocaleDateString('ru-RU',{day:'numeric',month:'short'}).replace(/\.$/,'');
}
function businessWeekLabel(bounds){return businessShortDate(bounds.start)+' – '+businessShortDate(bounds.end-1)}
function businessDayName(ts){return new Date(ts).toLocaleDateString('ru-RU',{weekday:'short'}).replace(/\.$/,'')}
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
function businessWeekSameTime(fullWeek,dayIndex){
 const dayStart=new Date(fullWeek.bounds.start);dayStart.setDate(dayStart.getDate()+Math.max(0,Math.min(6,Number(dayIndex)||0)));
 const elapsed=businessElapsedTodayMs(),cutoff=Math.min(fullWeek.bounds.end,dayStart.getTime()+elapsed),
  partialBounds={start:fullWeek.bounds.start,end:cutoff,days:7,label:'Прошлая неделя'},
  orderBuckets=businessBuckets('week',fullWeek.bounds),
  orders=businessEstimateOrders(businessOrderGroups(partialBounds),orderBuckets,window.allMarketUnitProfit30),
  buckets=fullWeek.buckets.map((row,i)=>{
   const factor=cutoff<=row.start?0:cutoff>=row.end?1:(cutoff-row.start)/Math.max(1,row.end-row.start),next={...row};
   for(const key of ['buyouts','buyoutQty','buyoutBaseProfit','buyoutProfit','coreBuyouts','coreBuyoutQty','coreBuyoutBaseProfit','coreBuyoutProfit','ozonBuyouts','ozonBuyoutQty','ozonBuyoutBaseProfit','ozonBuyoutProfit','netProfit'])next[key]=(Number(row[key])||0)*factor;
   next.orders=Number(orderBuckets[i]?.orders)||0;next.orderQty=Number(orderBuckets[i]?.orderQty)||0;next.orderProfit=Number(orderBuckets[i]?.orderProfit)||0;return next;
  });
 const revenue=buckets.reduce((n,x)=>n+(Number(x.buyouts)||0),0),qty=buckets.reduce((n,x)=>n+(Number(x.buyoutQty)||0),0),profit=buckets.reduce((n,x)=>n+(Number(x.buyoutProfit)||0),0),
  summary={...fullWeek.summary,revenue,qty:Math.round(qty),profit},netProfit=profit;
 return {...fullWeek,bounds:partialBounds,buckets,orders,summary,netProfit,comparisonCutoff:cutoff,comparisonElapsed:elapsed};
}
async function businessWarmSupportingData(force=false){
 const warm=[];
 if(typeof window.ozonFboRefreshStatus==='function')warm.push(Promise.resolve().then(()=>window.ozonFboRefreshStatus()));
 if(typeof window.refreshAllMarketUnitProfit==='function'&&(!(window.allMarketUnitProfit30 instanceof Map)||force))warm.push(Promise.resolve().then(()=>window.refreshAllMarketUnitProfit()));
 if(warm.length)await Promise.allSettled(warm);
}
async function businessBuildModel(force=false){
 const warm=[];
 if(typeof window.ozonFboRefreshStatus==='function')warm.push(Promise.resolve().then(()=>window.ozonFboRefreshStatus()));
 if(typeof window.refreshAllMarketUnitProfit==='function'&&(!(window.allMarketUnitProfit30 instanceof Map)||force))warm.push(Promise.resolve().then(()=>window.refreshAllMarketUnitProfit()));
 if(warm.length)await Promise.allSettled(warm);
 const [today,yesterday]=await Promise.all([businessBuildDaySnapshot(businessDayBounds(0),1,force),businessBuildDaySnapshot(businessDayBounds(-1),-1,force)]),yesterdayCompare=businessYesterdaySameTime(yesterday);
 return {...today,yesterday,yesterdayCompare,periodKey:'today',chartMode:'day',legendCurrent:'сегодня',legendComparison:'вчера'};
}
async function businessBuildYesterdayModel(force=false){
 await businessWarmSupportingData(force);
 const currentBounds=businessDayBounds(-1),comparisonBounds=businessDayBounds(-2),comparisonRange=businessRangeForBounds(comparisonBounds);
 const [current,comparison]=await Promise.all([businessBuildDaySnapshot(currentBounds,-1,force),businessBuildRangeSnapshot(comparisonBounds,comparisonRange,'day',force)]);
 return {...current,periodKey:'yesterday',chartMode:'day',comparison,comparisonSame:comparison,legendCurrent:'вчера',legendComparison:'позавчера'};
}
async function businessBuildWeekModel(force=false){
 await businessWarmSupportingData(force);
 const currentBounds=businessWeekBounds(0),comparisonBounds=businessWeekBounds(-1),todayStart=businessDayStart().getTime(),dayIndex=Math.max(0,Math.min(6,Math.round((todayStart-currentBounds.start)/86400000))),
  currentRange=businessRangeForBounds(currentBounds,Date.now()+1),comparisonDayEnd=new Date(comparisonBounds.start);
 comparisonDayEnd.setDate(comparisonDayEnd.getDate()+dayIndex+1);
 const comparisonRange=businessRangeForBounds(comparisonBounds,comparisonDayEnd.getTime()),
  [current,comparisonFull]=await Promise.all([businessBuildRangeSnapshot(currentBounds,currentRange,'week',force),businessBuildRangeSnapshot(comparisonBounds,comparisonRange,'week',force)]),
  comparison=businessWeekSameTime(comparisonFull,dayIndex);
 return {...current,periodKey:'week',chartMode:'week',comparison,comparisonFull,legendCurrent:'эта неделя',legendComparison:'прошлая'};
}
async function businessBuildPreviousWeekModel(force=false){
 await businessWarmSupportingData(force);
 const currentBounds=businessWeekBounds(-1),comparisonBounds=businessWeekBounds(-2),
  currentRange=businessRangeForBounds(currentBounds),comparisonRange=businessRangeForBounds(comparisonBounds),
  [current,comparison]=await Promise.all([businessBuildRangeSnapshot(currentBounds,currentRange,'week',force),businessBuildRangeSnapshot(comparisonBounds,comparisonRange,'week',force)]);
 return {...current,periodKey:'prevweek',chartMode:'week',comparison,comparisonSame:comparison,legendCurrent:'прошлая',legendComparison:'до неё'};
}
async function businessBuildSelectedModel(force=false){
 if(businessPeriod==='yesterday')return businessBuildYesterdayModel(force);
 if(businessPeriod==='week')return businessBuildWeekModel(force);
 if(businessPeriod==='prevweek')return businessBuildPreviousWeekModel(force);
 return businessBuildModel(force);
}

window.setBusinessDashboardPeriod=function(period){
 if(!BUSINESS_PERIODS.has(period)||period===businessPeriod)return;
 businessPeriod=period;businessLastModel=null;businessSaveUi();businessPaintTabs();window.renderBusinessDashboard(false);
};
window.setBusinessDashboardMetric=function(metric){if(!BUSINESS_METRICS.has(metric))return;businessMetric=metric;businessSaveUi();if(businessLastModel)businessPaint(businessLastModel);else window.renderBusinessDashboard(false)};
function businessComparison(current,previous){
 if(current===null||current===undefined||previous===null||previous===undefined||!Number.isFinite(Number(current))||!Number.isFinite(Number(previous)))return {html:''};
 const now=Number(current),prev=Number(previous),delta=now-prev,cls=Math.abs(delta)<.005?'flat':delta>0?'up':'down',sign=delta>0?'+':'',pct=prev!==0?delta/Math.abs(prev)*100:null,pctText=pct===null?'':(' · '+(pct>0?'+':'')+Math.round(pct)+'%');
 return {html:'<span class="business-compare-label">разница</span><span class="business-compare-delta '+cls+'">'+sign+businessMoney(delta)+pctText+'</span>'};
}
function businessPaint(model){
 businessLastModel=model;businessPaintTabs();
 const info=businessMetricInfo(model),full=model.comparisonFull||model.comparison||model.yesterday||null,same=model.comparisonSame||model.comparison||model.yesterdayCompare||full,
  displayPrevious=model.periodKey==='week'?same:full,displayPreviousInfo=displayPrevious?businessMetricInfo(displayPrevious):null,sameInfo=same?businessMetricInfo(same):null,
  metric=document.getElementById('businessValueMetric'),label=document.getElementById('businessValueLabel'),value=document.getElementById('businessValue'),meta=document.getElementById('businessValueMeta'),
  yLabel=document.getElementById('businessYesterdayLabel'),yValue=document.getElementById('businessYesterdayValue'),yMeta=document.getElementById('businessYesterdayMeta'),
  compare=document.getElementById('businessYesterdayCompare'),title=document.getElementById('businessPeriodTitle'),sub=document.getElementById('businessPeriodSub'),
  isWeek=model.chartMode==='week',periodTitle=model.periodKey==='yesterday'?'Вчера':model.periodKey==='week'?'Неделя':model.periodKey==='prevweek'?'Прошлая неделя':'Сегодня';
 if(title)title.textContent=periodTitle;if(sub)sub.textContent='Kaspi + WB1 + WB2 + Ozon · '+(isWeek?'по дням':'по часам');
 if(metric)metric.textContent=info.label;
 if(label){
  if(model.periodKey==='week')label.textContent=businessWeekLabel(model.bounds)+' · текущая';
  else if(model.periodKey==='prevweek')label.textContent=businessWeekLabel(model.bounds)+' · прошлая';
  else label.textContent=businessShortDate(model.bounds.start)+(model.periodKey==='yesterday'?' · весь день':' · сегодня');
 }
 if(value)value.textContent=businessMaybeMoney(info.value,Boolean(info.estimated));if(meta)meta.textContent=info.meta;
 if(yLabel){
  if(model.periodKey==='week'&&full&&same){const until=businessHourMinute(same.comparisonCutoff||same.bounds.end),day=businessDayName(same.comparisonCutoff||same.bounds.end);yLabel.textContent=businessWeekLabel(full.bounds)+' · до '+day+' '+until}
  else if(model.periodKey==='prevweek'&&displayPrevious)yLabel.textContent=businessWeekLabel(displayPrevious.bounds);
  else if(displayPrevious)yLabel.textContent=businessShortDate(displayPrevious.bounds.start)+' · весь день';
  else yLabel.textContent='Сравнение';
 }
 if(yValue)yValue.textContent=displayPreviousInfo?businessMaybeMoney(displayPreviousInfo.value,Boolean(displayPreviousInfo.estimated)):'—';if(yMeta)yMeta.textContent=displayPreviousInfo?displayPreviousInfo.meta:'';
 if(compare){
  compare.innerHTML=sameInfo?businessComparison(info.value,sameInfo.value).html:'';
  if(model.periodKey==='today'&&sameInfo){const until=businessHourMinute(same.comparisonCutoff||same.bounds.end);compare.innerHTML+='<span class="business-compare-label">вчера до '+until+' · '+businessMaybeMoney(sameInfo.value,Boolean(sameInfo.estimated))+'</span>'}
 }
 businessPaintChart(model,info.field);
}
window.renderBusinessDashboard=async function(force=false){
 const root=businessEnsureUi();if(!root)return;if(!document.getElementById('reports')?.classList.contains('active')){businessPaintTabs();return}
 const seq=++businessRenderSeq;businessPaintTabs(),periodTitle=businessPeriod==='yesterday'?'Вчера':businessPeriod==='week'?'Неделя':businessPeriod==='prevweek'?'Прошлая неделя':'Сегодня',
  metric=document.getElementById('businessValueMetric'),label=document.getElementById('businessValueLabel'),value=document.getElementById('businessValue'),meta=document.getElementById('businessValueMeta'),yLabel=document.getElementById('businessYesterdayLabel'),yValue=document.getElementById('businessYesterdayValue'),yMeta=document.getElementById('businessYesterdayMeta'),compare=document.getElementById('businessYesterdayCompare'),chart=document.getElementById('businessChart'),title=document.getElementById('businessPeriodTitle'),sub=document.getElementById('businessPeriodSub');
 if(title)title.textContent=periodTitle;if(sub)sub.textContent='Kaspi + WB1 + WB2 + Ozon · '+((businessPeriod==='week'||businessPeriod==='prevweek')?'по дням':'по часам');
 if(metric)metric.textContent='Считаю бизнес-показатели…';if(label)label.textContent=periodTitle;if(value)value.textContent='…';if(meta)meta.textContent='';if(yLabel)yLabel.textContent='Сравнение';if(yValue)yValue.textContent='…';if(yMeta)yMeta.textContent='';if(compare)compare.innerHTML='';if(chart)chart.innerHTML='';
 try{const model=await businessBuildSelectedModel(force);if(seq!==businessRenderSeq)return;businessPaint(model)}
 catch(error){if(seq!==businessRenderSeq)return;if(label)label.textContent='Не удалось посчитать';if(value)value.textContent='—'}
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
