(function(){
'use strict';
if(typeof window==='undefined')return;

const BUSINESS_SUPPORTED_MARKETS=new Set(['Kaspi','WB','WB2']);
const BUSINESS_PERIODS=new Set(['day','week','month','year']);
const BUSINESS_METRICS=new Set(['orders','buyouts','orderProfit','buyoutProfit','netProfit']);
const BUSINESS_UI_KEY='milioner_business_dashboard_v1';
let businessRenderSeq=0,businessSummaryCache=new Map(),businessLastModel=null;
let businessPeriod='day',businessMetric='orders';
try{
 const saved=JSON.parse(localStorage.getItem(BUSINESS_UI_KEY)||'{}');
 if(BUSINESS_PERIODS.has(saved.period))businessPeriod=saved.period;
 if(BUSINESS_METRICS.has(saved.metric))businessMetric=saved.metric;
}catch(_){}

function businessSaveUi(){
 try{localStorage.setItem(BUSINESS_UI_KEY,JSON.stringify({period:businessPeriod,metric:businessMetric}))}catch(_){}
}
function businessDayStart(date=new Date()){const d=new Date(date);d.setHours(0,0,0,0);return d}
function businessPeriodBounds(period=businessPeriod){
 const today=businessDayStart(),end=new Date(today);end.setDate(end.getDate()+1);let start=new Date(today);
 if(period==='week'){const monday=(today.getDay()+6)%7;start.setDate(start.getDate()-monday)}
 else if(period==='month')start=new Date(today.getFullYear(),today.getMonth(),1);
 else if(period==='year')start=new Date(today.getFullYear(),0,1);
 return {start:start.getTime(),end:end.getTime(),days:Math.max(1,Math.round((end-start)/86400000)),label:period==='day'?'Сегодня':period==='week'?'Эта неделя':period==='month'?'Этот месяц':'Этот год'};
}
function businessBuckets(period,bounds){
 const rows=[],push=(start,end,label)=>rows.push({start,end,label,orders:0,orderQty:0,orderProfit:0,buyouts:0,buyoutQty:0,buyoutBaseProfit:0,buyoutProfit:0,financeExpense:0,netProfit:0});
 if(period==='day'){
  for(let h=0;h<24;h++){const s=bounds.start+h*3600000;push(s,s+3600000,String(h).padStart(2,'0'))}
 }else if(period==='year'){
  const first=new Date(bounds.start),last=new Date(bounds.end-1);
  for(let m=first.getMonth();m<=last.getMonth();m++){
   const s=new Date(first.getFullYear(),m,1).getTime(),e=Math.min(bounds.end,new Date(first.getFullYear(),m+1,1).getTime());
   push(s,e,new Date(s).toLocaleDateString('ru-RU',{month:'short'}).replace('.',''));
  }
 }else{
  for(let s=bounds.start;s<bounds.end;s+=86400000){
   const e=Math.min(bounds.end,s+86400000),d=new Date(s);
   push(s,e,period==='week'?d.toLocaleDateString('ru-RU',{weekday:'short'}).replace('.',''):String(d.getDate()));
  }
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
  ...(state?.wbOrderFeed||[]).map(x=>({...x,market:String(x?.market||'WB')}))
 ];
 return groupMarketplaceOrders(feed).filter(g=>{
  const market=String(g?.market||'');if(!BUSINESS_SUPPORTED_MARKETS.has(market))return false;
  const ts=Number(g?.creationDate)||0;if(!(ts>=bounds.start&&ts<bounds.end))return false;
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
function businessLocalBuyouts(bounds,buckets){
 const rows=(typeof financialSales==='function'?financialSales():[]).filter(s=>BUSINESS_SUPPORTED_MARKETS.has(String(s?.channel||''))&&Number(s?.date)>=bounds.start&&Number(s?.date)<bounds.end);
 let revenue=0,qty=0,baseProfit=0;
 for(const sale of rows){
  const q=Math.max(0,Number(sale?.qty)||0);if(!q)continue;
  const r=q*Math.max(0,Number(sale?.price)||0),p=q*((Number(sale?.price)||0)-(Number(sale?.cost)||0)-(Number(sale?.fee)||0)),bucket=businessBucketFor(buckets,Number(sale.date)||0);
  revenue+=r;qty+=q;baseProfit+=p;
  if(bucket){bucket.buyouts+=r;bucket.buyoutQty+=q;bucket.buyoutBaseProfit+=p}
 }
 return {revenue,qty,baseProfit};
}
function businessFinanceExpenses(bounds,buckets){
 const categories=new Map((typeof financeCategories==='function'?financeCategories():[]).map(x=>[String(x?.id||''),x]));
 const groups=new Map();let total=0,uncategorized=0,excluded=0;
 for(const tx of (typeof financeTransactions==='function'?financeTransactions():[])){
  const ts=typeof financeTransactionTime==='function'?financeTransactionTime(tx):Number(tx?.createdAt)||0;if(!(ts>=bounds.start&&ts<bounds.end))continue;
  const entry=typeof financeAnalyticsEntry==='function'?financeAnalyticsEntry(tx):null;
  if(!entry||entry.mode!=='expense'){
    const rawType=typeof financeTransactionType==='function'?financeTransactionType(tx):String(tx?.type||'');
    const counts=typeof financeCountsInIncomeExpense==='function'?financeCountsInIncomeExpense(tx):rawType==='expense';
    const effective=typeof financeEffectiveCategory==='function'?financeEffectiveCategory(tx):{categoryId:String(tx?.categoryId||''),category:String(tx?.category||'').trim()};
    if(rawType==='expense'&&counts&&!effective.categoryId&&!effective.category){
      const amount=typeof financeTransactionDefaultAmount==='function'?financeTransactionDefaultAmount(tx):Math.abs(Number(tx?.amount)||0);
      uncategorized+=amount;total+=amount;const bucket=businessBucketFor(buckets,ts);if(bucket)bucket.financeExpense+=amount;
      const key='__uncategorized__';if(!groups.has(key))groups.set(key,{name:'Без категории',amount:0});groups.get(key).amount+=amount;
    }
    continue
  }
  if(typeof financeAnalyticsEntryIncluded==='function'&&!financeAnalyticsEntryIncluded(entry)){excluded+=Number(entry.amount)||0;continue}
  const amount=Number(entry.amount)||0;total+=amount;const bucket=businessBucketFor(buckets,ts);if(bucket)bucket.financeExpense+=amount;
  const id=String(entry.categoryId||''),name=id?(categories.get(id)?.name||entry.category||'Без категории'):(entry.category||'Без категории'),key=id||('name:'+name);
  if(!groups.has(key))groups.set(key,{name,amount:0});groups.get(key).amount+=amount;
 }
 return {total,uncategorized,excluded,groups:[...groups.values()].filter(x=>Math.abs(x.amount)>0.001).sort((a,b)=>b.amount-a.amount)};
}
function businessNormalizeBuyoutBuckets(buckets,local,summary){
 const exactRevenue=Number(summary?.revenue)||0,exactProfit=Number(summary?.profit)||0,localRevenue=Number(local?.revenue)||0,baseProfit=Number(local?.baseProfit)||0;
 const revenueScale=localRevenue>0?exactRevenue/localRevenue:0,profitAdjustment=exactProfit-baseProfit;
 if(localRevenue>0){
  for(const b of buckets){const share=Math.max(0,Number(b.buyouts)||0)/localRevenue;b.buyouts*=revenueScale;b.buyoutProfit=b.buyoutBaseProfit+profitAdjustment*share}
 }else if(buckets.length){buckets[buckets.length-1].buyouts=exactRevenue;buckets[buckets.length-1].buyoutProfit=exactProfit}
 for(const b of buckets)b.netProfit=b.buyoutProfit-b.financeExpense;
}
function businessMoney(value){return typeof fmt==='function'?fmt(Number(value)||0):new Intl.NumberFormat('ru-RU',{maximumFractionDigits:0}).format(Number(value)||0)+' ₸'}
function businessMetricInfo(model){
 const map={
  orders:{label:'Заказы',value:model.orders.amount,meta:model.orders.qty.toLocaleString('ru-RU')+' шт. · '+model.orders.orderCount.toLocaleString('ru-RU')+' заказов',field:'orders'},
  buyouts:{label:'Выкупы',value:model.summary.revenue,meta:model.summary.qty.toLocaleString('ru-RU')+' шт.',field:'buyouts'},
  orderProfit:{label:'Прибыль с заказов · прогноз',value:model.orders.profit,meta:'покрытие расчётом '+Math.round(model.orders.coverage*100)+'%',field:'orderProfit'},
  buyoutProfit:{label:'Прибыль с выкупов',value:model.summary.profit,meta:model.summary.estimated?'≈ финансовый расчёт':'финансовый расчёт',field:'buyoutProfit'},
  netProfit:{label:'Чистая прибыль бизнеса',value:model.netProfit,meta:'расходы бизнеса '+businessMoney(model.finance.total),field:'netProfit'}
 };
 return map[businessMetric]||map.orders;
}
function businessEnsureStyle(){
 if(document.getElementById('businessDashboardStyle'))return;
 const style=document.createElement('style');style.id='businessDashboardStyle';style.textContent=`
 .business-dashboard{border:1px solid var(--line);border-radius:24px;padding:16px;margin:0 0 18px;background:var(--card)}
 .business-top{display:flex;align-items:center;justify-content:space-between;gap:10px}.business-top h3{margin:0}.business-sub{font-size:12px;color:var(--muted);margin-top:3px}
 .business-periods,.business-metrics{display:flex;gap:6px;overflow-x:auto;scrollbar-width:none}.business-periods{margin-top:14px}.business-metrics{margin-top:10px}.business-periods::-webkit-scrollbar,.business-metrics::-webkit-scrollbar{display:none}
 .business-periods button,.business-metrics button{white-space:nowrap;border:1px solid var(--line);background:var(--bg);border-radius:999px;padding:8px 12px;font:inherit}.business-periods button.active,.business-metrics button.active{background:#111;color:#fff;border-color:#111}
 .business-value-card{margin-top:14px;padding:14px;border-radius:18px;background:var(--bg)}.business-value-label{font-size:13px;color:var(--muted)}.business-value{font-size:30px;font-weight:800;margin-top:3px}.business-value-meta{font-size:13px;color:var(--muted);margin-top:4px}
 .business-chart{display:flex;align-items:flex-end;gap:5px;height:165px;margin-top:14px;padding:12px 4px 0;overflow-x:auto;border-top:1px dashed var(--line)}.business-bar-col{min-width:28px;flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;height:100%}.business-bar-track{width:100%;height:120px;display:flex;align-items:flex-end;justify-content:center}.business-bar{width:min(22px,80%);min-height:2px;border-radius:7px 7px 2px 2px;background:#111}.business-bar.negative{background:#9b1c1c}.business-bar-label{font-size:10px;color:var(--muted);margin-top:6px;white-space:nowrap}
 .business-foot{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:12px}.business-warning{font-size:12px;color:var(--muted);line-height:1.35}.business-detail-btn{border:1px solid var(--line);background:var(--bg);border-radius:12px;padding:8px 10px;font:inherit;white-space:nowrap}
 @media(max-width:560px){.business-dashboard{padding:13px;border-radius:20px}.business-value{font-size:27px}.business-chart{height:150px}.business-bar-track{height:106px}}
 `;document.head.appendChild(style);
}
function businessEnsureUi(){
 const reports=document.getElementById('reports');if(!reports)return null;let root=document.getElementById('businessDashboard');
 if(root)return root;businessEnsureStyle();root=document.createElement('div');root.id='businessDashboard';root.className='business-dashboard';
 root.innerHTML=`<div class="business-top"><div><h3>Бизнес</h3><div class="business-sub">Kaspi + WB1 + WB2 · прибыль после расходов</div></div><button class="business-detail-btn" type="button" onclick="renderBusinessDashboard(true)">↻</button></div>
 <div class="business-periods">${[['day','День'],['week','Неделя'],['month','Месяц'],['year','Год']].map(([k,v])=>`<button type="button" data-business-period="${k}" onclick="setBusinessDashboardPeriod('${k}')">${v}</button>`).join('')}</div>
 <div class="business-metrics">${[['orders','Заказы'],['buyouts','Выкупы'],['orderProfit','Прибыль заказов'],['buyoutProfit','Прибыль выкупов'],['netProfit','Чистая прибыль']].map(([k,v])=>`<button type="button" data-business-metric="${k}" onclick="setBusinessDashboardMetric('${k}')">${v}</button>`).join('')}</div>
 <div class="business-value-card"><div id="businessValueLabel" class="business_value-label">Загрузка…</div><div id="businessValue" class="business_value">—</div><div id="businessValueMeta" class="business_value-meta"></div></div>
 <div id="businessChart" class="business_chart"></div><div class="business-foot"><div id="businessWarning" class="business-warning">Считаю данные…</div><button class="business-detail-btn" type="button" onclick="openBusinessDashboardDetails()">Расшифровка</button></div>`;
 const title=reports.querySelector('h2');if(title)title.insertAdjacentElement('afterend',root);else reports.prepend(root);return root;
}
function businessPaintTabs(){
 document.querySelectorAll('[data-business-period]').forEach(x=>x.classList.toggle('active',x.dataset.businessPeriod===businessPeriod));
 document.querySelectorAll('[data-business-metric]').forEach(x=>x.classList.toggle('active',x.dataset.businessMetric===businessMetric));
}
function businessPaintChart(model,field){
 const box=document.getElementById('businessChart');if(!box)return;const values=model.buckets.map(x=>Number(x[field])||0),max=Math.max(1,...values.map(x=>Math.abs(x)));
 box.innerHTML=model.buckets.map((b,i)=>{const v=values[i],h=Math.max(v===0?2:5,Math.round(Math.abs(v)/max*112));return `<div class="business-bar-col" title="${b.label}: ${businessMoney(v)}"><div class="business-bar-track"><div class="business-bar ${v<0?'negative':''}" style="height:${h}px"></div></div><div class="business-bar-label">${b.label}</div></div>`}).join('');
}
async function businessLoadSummary(days,force=false){
 const key=String(days),old=businessSummaryCache.get(key);if(!force&&old?.data&&Date.now()-Number(old.at||0)<60000)return old.data;if(!force&&old?.promise)return old.promise;
 if(typeof window.loadBusinessMarketplaceSummary!=='function')throw new Error('Финансовый модуль ещё не загрузился');
 const promise=window.loadBusinessMarketplaceSummary(days,{force}).then(data=>{businessSummaryCache.set(key,{at:Date.now(),data});return data}).catch(e=>{businessSummaryCache.delete(key);throw e});
 businessSummaryCache.set(key,{at:Date.now(),promise});return promise;
}
async function businessBuildModel(force=false){
 const bounds=businessPeriodBounds(),buckets=businessBuckets(businessPeriod,bounds);
 if(typeof window.refreshAllMarketUnitProfit==='function'&&(!(window.allMarketUnitProfit30 instanceof Map)||force)){try{await window.refreshAllMarketUnitProfit()}catch(_){}}
 const groups=businessOrderGroups(bounds),orders=businessEstimateOrders(groups,buckets,window.allMarketUnitProfit30),local=businessLocalBuyouts(bounds,buckets),finance=businessFinanceExpenses(bounds,buckets),summary=await businessLoadSummary(bounds.days,force);
 businessNormalizeBuyoutBuckets(buckets,local,summary);
 const netProfit=(Number(summary?.profit)||0)-finance.total;
 return {period:businessPeriod,bounds,buckets,orders,local,finance,summary,netProfit};
}
window.setBusinessDashboardPeriod=function(period){if(!BUSINESS_PERIODS.has(period))return;businessPeriod=period;businessSaveUi();window.renderBusinessDashboard(false)};
window.setBusinessDashboardMetric=function(metric){if(!BUSINESS_METRICS.has(metric))return;businessMetric=metric;businessSaveUi();if(businessLastModel)businessPaint(businessLastModel);else window.renderBusinessDashboard(false)};
function businessPaint(model){
 businessLastModel=model;businessPaintTabs();const info=businessMetricInfo(model),label=document.getElementById('businessValueLabel'),value=document.getElementById('businessValue'),meta=document.getElementById('businessValueMeta'),warning=document.getElementById('businessWarning');
 if(label)label.textContent=info.label+' · '+model.bounds.label;if(value)value.textContent=businessMoney(info.value);if(meta)meta.textContent=info.meta;businessPaintChart(model,info.field);
 const notes=[];if(model.orders.coverage<.999)notes.push('прогноз заказов покрывает '+Math.round(model.orders.coverage*100)+'% суммы');if(model.finance.uncategorized>0)notes.push('расходы без категории включены: '+businessMoney(model.finance.uncategorized));if(model.summary.estimated)notes.push('часть прибыли оценочная');notes.push('Ozon пока не входит в прибыль');
 if(warning)warning.textContent=notes.join(' · ');
}
window.renderBusinessDashboard=async function(force=false){
 const root=businessEnsureUi();if(!root)return;if(!document.getElementById('reports')?.classList.contains('active')){businessPaintTabs();return}
 const seq=++businessRenderSeq;businessPaintTabs();const label=document.getElementById('businessValueLabel'),value=document.getElementById('businessValue'),meta=document.getElementById('businessValueMeta'),chart=document.getElementById('businessChart'),warning=document.getElementById('businessWarning');
 if(label)label.textContent='Считаю бизнес-показатели…';if(value)value.textContent='…';if(meta)meta.textContent='';if(chart)chart.innerHTML='';if(warning)warning.textContent='Загрузка финансовых данных…';
 try{const model=await businessBuildModel(force);if(seq!==businessRenderSeq)return;businessPaint(model)}
 catch(error){if(seq!==businessRenderSeq)return;if(label)label.textContent='Не удалось посчитать';if(value)value.textContent='—';if(warning)warning.textContent=String(error?.message||error)}
};
window.openBusinessDashboardDetails=function(){
 const m=businessLastModel;if(!m)return window.renderBusinessDashboard(false);
 const sourceRows=Object.entries(m.summary?.sources||{}).map(([name,x])=>`<div class="item" style="margin-top:8px"><div class="row"><div class="grow"><b>${name==='WB'?'WB1':esc(name)}</b><div class="muted">${Math.round(Number(x.qty)||0).toLocaleString('ru-RU')} шт. выкупов</div></div><b>${businessMoney(x.profit)}</b></div><div class="row" style="margin-top:6px"><span class="grow muted">Выручка</span><b>${businessMoney(x.revenue)}</b></div><div class="row" style="margin-top:4px"><span class="grow muted">Себестоимость</span><b>−${businessMoney(x.cost).replace(/^-/,'')}</b></div><div class="row" style="margin-top:4px"><span class="grow muted">Комиссии, логистика и услуги</span><b>−${businessMoney(x.fees).replace(/^-/,'')}</b></div><div class="row" style="margin-top:4px"><span class="grow muted">Реклама</span><b>−${businessMoney(x.ads).replace(/^-/,'')}</b></div></div>`).join('');
 const financeRows=m.finance.groups.length?m.finance.groups.map(x=>`<div class="row" style="margin-top:5px"><span class="grow muted">${esc(x.name)}</span><b>${businessMoney(x.amount)}</b></div>`).join(''):'<div class="muted" style="margin-top:6px">Расходов бизнеса за период нет.</div>';
 const coverage=Math.round(m.orders.coverage*100);
 showSheet(`<h3>Бизнес · ${esc(m.bounds.label)}</h3><div class="link-note"><b>Что считается.</b> Заказы — новые неотменённые заказы. Прибыль заказов — прогноз по фактической чистой прибыли/шт. последних 30 дней. Прибыль выкупов — финансовые данные Kaspi + WB1 + WB2 после себестоимости, комиссий, логистики, рекламы и возвратов. Чистая прибыль бизнеса дополнительно вычитает расходы из вкладки «Финансы».</div>
 <div class="item"><div class="row"><span class="grow">Заказы</span><b>${businessMoney(m.orders.amount)}</b></div><div class="muted">${m.orders.qty.toLocaleString('ru-RU')} шт. · ${m.orders.orderCount} заказов</div><div class="row" style="margin-top:8px"><span class="grow">Примерная прибыль с заказов</span><b>${businessMoney(m.orders.profit)}</b></div><div class="muted">Покрытие расчётом: ${coverage}%</div></div>
 <div class="item" style="margin-top:8px"><div class="row"><span class="grow">Выкупы</span><b>${businessMoney(m.summary.revenue)}</b></div><div class="row" style="margin-top:8px"><span class="grow"><b>Прибыль с выкупов</b></span><b>${businessMoney(m.summary.profit)}</b></div><div class="row" style="margin-top:5px"><span class="grow muted">Себестоимость</span><b>−${businessMoney(m.summary.cost).replace(/^-/,'')}</b></div><div class="row" style="margin-top:5px"><span class="grow muted">Комиссии, логистика и услуги</span><b>−${businessMoney(m.summary.fees).replace(/^-/,'')}</b></div><div class="row" style="margin-top:5px"><span class="grow muted">Реклама</span><b>−${businessMoney(m.summary.ads).replace(/^-/,'')}</b></div></div>
 <h3 style="margin-top:14px">По магазинам</h3>${sourceRows}
 <div class="item" style="margin-top:8px"><b>Расходы бизнеса из «Финансов»</b><div class="row" style="margin-top:7px"><span class="grow">Итого</span><b>${businessMoney(m.finance.total)}</b></div>${financeRows}${m.finance.uncategorized>0?`<div class="link-note" style="margin-top:8px">Есть расходы без категории на ${businessMoney(m.finance.uncategorized)}. Они включены в чистую прибыль, но лучше присвоить им категории.</div>`:''}</div>
 <div class="item" style="margin-top:8px"><div class="row"><span class="grow"><b>Чистая прибыль бизнеса</b></span><b>${businessMoney(m.netProfit)}</b></div></div>
 <div class="link-note"><b>Важно про двойной учёт.</b> Если закупка товара/себестоимость, комиссия, логистика или реклама маркетплейса уже учтена выше и одновременно занесена отдельным расходом в «Финансах», она будет вычтена второй раз. Такие категории в «Финансах» нужно выключить из «Итого». Ozon пока не входит в эту прибыль: его серверная финансовая история сейчас ограничена 30 днями.</div>`);
};

const baseRenderReports=window.renderReports;
window.renderReports=function(){
 const result=typeof baseRenderReports==='function'?baseRenderReports.apply(this,arguments):undefined;
 setTimeout(()=>window.renderBusinessDashboard(false),0);return result;
};
const init=()=>{businessEnsureUi();businessPaintTabs();if(document.getElementById('reports')?.classList.contains('active'))window.renderBusinessDashboard(false)};
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
