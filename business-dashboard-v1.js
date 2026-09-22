(function(){
'use strict';
if(typeof window==='undefined')return;

const BUSINESS_SUPPORTED_MARKETS=new Set(['Kaspi','WB','WB2']);
const BUSINESS_PERIODS=new Set(['day']);
const BUSINESS_METRICS=new Set(['orders','buyouts','orderProfit','buyoutProfit','netProfit']);
const BUSINESS_UI_KEY='milioner_business_dashboard_v1';
let businessRenderSeq=0,businessSummaryCache=new Map(),businessLastModel=null;
let businessPeriod='day',businessMetric='orders';
try{
 const saved=JSON.parse(localStorage.getItem(BUSINESS_UI_KEY)||'{}');
 businessPeriod='day';
 if(BUSINESS_METRICS.has(saved.metric))businessMetric=saved.metric;
}catch(_){}

function businessSaveUi(){
 try{localStorage.setItem(BUSINESS_UI_KEY,JSON.stringify({period:'day',metric:businessMetric}))}catch(_){}
}
function businessDayStart(date=new Date()){const d=new Date(date);d.setHours(0,0,0,0);return d}
function businessDayBounds(offset=0){
 const start=businessDayStart();start.setDate(start.getDate()+Number(offset||0));const end=new Date(start);end.setDate(end.getDate()+1);
 return {start:start.getTime(),end:end.getTime(),days:offset===-1?-1:1,label:offset===-1?'Вчера':'Сегодня'};
}
function businessPeriodBounds(){return businessDayBounds(0)}
function businessBuckets(_period,bounds){
 const rows=[],push=(start,end,label)=>rows.push({start,end,label,orders:0,orderQty:0,orderProfit:0,buyouts:0,buyoutQty:0,buyoutBaseProfit:0,buyoutProfit:0,financeExpense:0,netProfit:0});
 for(let h=0;h<24;h++){const s=bounds.start+h*3600000;push(s,s+3600000,String(h).padStart(2,'0'))}
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
 .business-dashboard{border:1px solid var(--line);border-radius:24px;padding:15px;margin:0 0 18px;background:var(--card);overflow:hidden}
 .business-top{display:flex;align-items:center;justify-content:space-between;gap:10px}.business-top h3{margin:0}.business-sub{font-size:12px;color:var(--muted);margin-top:3px}
 .business-metrics{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:13px}.business-metrics button{min-width:0;border:1px solid var(--line);background:var(--bg);border-radius:14px;padding:9px 7px;font:inherit;font-size:13px;line-height:1.15}.business-metrics button.active{background:#111;color:#fff;border-color:#111}.business-metrics button:last-child{grid-column:1/-1}
 .business-value-card{margin-top:12px;padding:13px 14px;border-radius:18px;background:var(--bg)}.business-value-title{font-size:13px;color:var(--muted);margin-bottom:8px}.business-value-grid{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,.9fr);gap:18px;align-items:start}.business-value-side{min-width:0}.business-yesterday-side{text-align:right}.business-value-label{font-size:12px;color:var(--muted)}.business-value{font-size:28px;font-weight:800;margin-top:3px;white-space:nowrap}.business-yesterday-side .business-value{font-size:20px;color:#666}.business-value-meta{font-size:12px;color:var(--muted);margin-top:4px}.business-compare{font-size:12px;margin-top:9px;display:flex;gap:6px;align-items:center;flex-wrap:wrap}.business-compare-label{color:var(--muted)}.business-compare-delta{font-weight:700}.business-compare-delta.up{color:#138a55}.business-compare-delta.down{color:#b42318}.business-compare-delta.flat{color:var(--muted)}
 .business-chart{margin-top:13px}.business-chart-legend{display:flex;justify-content:flex-end;gap:12px;align-items:center;font-size:10px;color:var(--muted);margin:0 48px 5px 0}.business-legend-today,.business-legend-yesterday{display:inline-flex;align-items:center;gap:5px}.business-legend-today:before{content:'';width:8px;height:8px;border-radius:2px;background:#111;display:inline-block}.business-legend-yesterday:before{content:'';width:8px;height:8px;border-radius:2px;background:#d1d1d6;border-top:2px solid #9d9da3;box-sizing:border-box;display:inline-block}.business-chart-frame{display:grid;grid-template-columns:minmax(0,1fr) 48px;grid-template-rows:172px 25px;column-gap:4px;width:100%}
 .business-plot{position:relative;grid-column:1;grid-row:1;min-width:0;border-bottom:1px solid var(--line)}
 .business-grid-line{position:absolute;left:0;right:0;border-top:1px dashed var(--line);pointer-events:none}
 .business-bars{position:absolute;inset:0;display:grid;grid-template-columns:repeat(24,minmax(0,1fr));align-items:stretch}
 .business-hour{position:relative;min-width:0}.business-yesterday-bar,.business-bar{position:absolute;left:24%;width:52%;min-height:1px}.business-yesterday-bar{border-radius:5px 5px 1px 1px;background:#d1d1d6;border-top:3px solid #9d9da3;box-sizing:border-box}.business-yesterday-bar.negative{border-radius:1px 1px 5px 5px;border-top:0;border-bottom:3px solid #9d9da3}.business-bar{border-radius:5px 5px 1px 1px;background:#111}.business-bar.negative{border-radius:1px 1px 5px 5px;background:#8d2222}
 .business-y-axis{grid-column:2;grid-row:1;position:relative;font-size:10px;color:var(--muted)}.business-y-tick{position:absolute;right:0;transform:translateY(50%);white-space:nowrap}
 .business-x-axis{grid-column:1;grid-row:2;position:relative;height:24px;padding-top:6px;font-size:9px;color:var(--muted)}.business-x-label{position:absolute;top:6px;white-space:nowrap;transform:translateX(-50%);text-align:center}
 .business-axis-caption{grid-column:2;grid-row:2;font-size:9px;color:var(--muted);padding-top:6px;text-align:right}
 .business-foot{display:flex;justify-content:flex-end;align-items:flex-start;gap:10px;margin-top:9px}.business-detail-btn{border:1px solid var(--line);background:var(--bg);border-radius:12px;padding:8px 10px;font:inherit;white-space:nowrap}
 @media(max-width:560px){.business-dashboard{padding:12px;border-radius:20px}.business-value{font-size:25px}.business-chart-frame{grid-template-columns:minmax(0,1fr) 42px;grid-template-rows:158px 24px}.business-metrics button{font-size:12px;padding:8px 5px}.business-bar,.business-yesterday-bar{left:20%;width:60%}}
 `;document.head.appendChild(style);
}
function businessEnsureUi(){
 const reports=document.getElementById('reports');if(!reports)return null;let root=document.getElementById('businessDashboard');
 if(root)return root;businessEnsureStyle();root=document.createElement('div');root.id='businessDashboard';root.className='business-dashboard';
 root.innerHTML=`<div class="business-top"><div><h3>Сегодня</h3><div class="business-sub">Kaspi + WB1 + WB2 · по часам</div></div><button class="business-detail-btn" type="button" onclick="renderBusinessDashboard(true)">↻</button></div>
 <div class="business-metrics">${[['orders','Заказы'],['buyouts','Выкупы'],['orderProfit','Прибыль заказов'],['buyoutProfit','Прибыль выкупов'],['netProfit','Чистая прибыль']].map(([k,v])=>`<button type="button" data-business-metric="${k}" onclick="setBusinessDashboardMetric('${k}')">${v}</button>`).join('')}</div>
 <div class="business-value-card"><div id="businessValueMetric" class="business-value-title">Загрузка…</div><div class="business-value-grid"><div class="business-value-side"><div id="businessValueLabel" class="business-value-label">Сегодня</div><div id="businessValue" class="business-value">—</div><div id="businessValueMeta" class="business-value-meta"></div></div><div class="business-value-side business-yesterday-side"><div id="businessYesterdayLabel" class="business-value-label">Вчера</div><div id="businessYesterdayValue" class="business-value">—</div><div id="businessYesterdayMeta" class="business-value-meta"></div></div></div><div id="businessYesterdayCompare" class="business-compare"></div></div>
 <div id="businessChart" class="business-chart"></div><div class="business-foot"><button class="business-detail-btn" type="button" onclick="openBusinessDashboardDetails()">Расшифровка</button></div>`;
 const title=reports.querySelector('h2');if(title)title.insertAdjacentElement('afterend',root);else reports.prepend(root);return root;
}
function businessPaintTabs(){
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
  return `<div class="business-hour" title="${b.label}:00 · сегодня ${businessMoney(v)} · вчера ${businessMoney(yv)}"><div class="business-yesterday-bar ${yv<0?'negative':''}" style="bottom:${yBottom}%;height:${Math.max(yv===0?0:1.2,yHeight)}%;z-index:${yesterdayZ}"></div><div class="business-bar ${v<0?'negative':''}" style="bottom:${todayBottom};height:${todayHeight};z-index:${todayZ}"></div></div>`;
 }).join('');
 const labels=[3,6,9,12,15,18,21,24].map(h=>`<div class="business-x-label" style="left:${h===24?100:((h-.5)/24*100)}%">${String(h).padStart(2,'0')}</div>`).join('');
 box.innerHTML=`<div class="business-chart-legend"><span class="business-legend-today">сегодня</span><span class="business-legend-yesterday">вчера</span></div><div class="business-chart-frame"><div class="business-plot">${lines}<div class="business-bars">${bars}</div></div><div class="business-y-axis">${ticks}</div><div class="business-x-axis">${labels}</div><div class="business-axis-caption">₸</div></div>`;
}

async function businessLoadSummary(days,force=false){
 const key=String(days),old=businessSummaryCache.get(key);if(!force&&old?.data&&Date.now()-Number(old.at||0)<60000)return old.data;if(!force&&old?.promise)return old.promise;
 if(typeof window.loadBusinessMarketplaceSummary!=='function')throw new Error('Финансовый модуль ещё не загрузился');
 const promise=window.loadBusinessMarketplaceSummary(days,{force}).then(data=>{businessSummaryCache.set(key,{at:Date.now(),data});return data}).catch(e=>{businessSummaryCache.delete(key);throw e});
 businessSummaryCache.set(key,{at:Date.now(),promise});return promise;
}
async function businessBuildDaySnapshot(bounds,summaryDays,force=false){
 const buckets=businessBuckets('day',bounds),groups=businessOrderGroups(bounds),orders=businessEstimateOrders(groups,buckets,window.allMarketUnitProfit30),local=businessLocalBuyouts(bounds,buckets),finance=businessFinanceExpenses(bounds,buckets),summary=await businessLoadSummary(summaryDays,force);
 businessNormalizeBuyoutBuckets(buckets,local,summary);
 const netProfit=(Number(summary?.profit)||0)-finance.total;
 return {period:'day',bounds,buckets,orders,local,finance,summary,netProfit};
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
function businessYesterdaySameTime(fullYesterday){
 const elapsed=businessElapsedTodayMs(),cutoff=Math.min(fullYesterday.bounds.end,fullYesterday.bounds.start+elapsed),
   partialBounds={start:fullYesterday.bounds.start,end:cutoff,days:-1,label:'Вчера'},
   orderBuckets=businessBuckets('day',fullYesterday.bounds),
   orders=businessEstimateOrders(businessOrderGroups(partialBounds),orderBuckets,window.allMarketUnitProfit30),
   financeBuckets=businessBuckets('day',fullYesterday.bounds),
   finance=businessFinanceExpenses(partialBounds,financeBuckets);
 let revenue=0,qty=0,profit=0;
 for(const b of fullYesterday.buckets){
  const factor=cutoff<=b.start?0:cutoff>=b.end?1:(cutoff-b.start)/Math.max(1,b.end-b.start);
  revenue+=(Number(b.buyouts)||0)*factor;
  qty+=(Number(b.buyoutQty)||0)*factor;
  profit+=(Number(b.buyoutProfit)||0)*factor;
 }
 const summary={...fullYesterday.summary,revenue,qty:Math.round(qty),profit},
   netProfit=profit-finance.total;
 return {...fullYesterday,bounds:partialBounds,orders,finance,summary,netProfit,comparisonCutoff:cutoff,comparisonElapsed:elapsed};
}
async function businessBuildModel(force=false){
 if(typeof window.refreshAllMarketUnitProfit==='function'&&(!(window.allMarketUnitProfit30 instanceof Map)||force)){try{await window.refreshAllMarketUnitProfit()}catch(_){}}
 const [today,yesterday]=await Promise.all([businessBuildDaySnapshot(businessDayBounds(0),1,force),businessBuildDaySnapshot(businessDayBounds(-1),-1,force)]),yesterdayCompare=businessYesterdaySameTime(yesterday);
 return {...today,yesterday,yesterdayCompare};
}

window.setBusinessDashboardMetric=function(metric){if(!BUSINESS_METRICS.has(metric))return;businessMetric=metric;businessSaveUi();if(businessLastModel)businessPaint(businessLastModel);else window.renderBusinessDashboard(false)};
function businessComparison(current,previous){
 const now=Number(current)||0,prev=Number(previous)||0,delta=now-prev,cls=Math.abs(delta)<.005?'flat':delta>0?'up':'down',sign=delta>0?'+':'',pct=prev!==0?delta/Math.abs(prev)*100:null,pctText=pct===null?'':(' · '+(pct>0?'+':'')+Math.round(pct)+'%');
 return {html:'<span class="business-compare-label">разница</span><span class="business-compare-delta '+cls+'">'+sign+businessMoney(delta)+pctText+'</span>'};
}
function businessPaint(model){
 businessLastModel=model;businessPaintTabs();const info=businessMetricInfo(model),yModel=model.yesterdayCompare||model.yesterday,yesterdayInfo=yModel?businessMetricInfo(yModel):null,
 metric=document.getElementById('businessValueMetric'),label=document.getElementById('businessValueLabel'),value=document.getElementById('businessValue'),meta=document.getElementById('businessValueMeta'),
 yLabel=document.getElementById('businessYesterdayLabel'),yValue=document.getElementById('businessYesterdayValue'),yMeta=document.getElementById('businessYesterdayMeta'),
 compare=document.getElementById('businessYesterdayCompare');
 if(metric)metric.textContent=info.label;if(label)label.textContent=businessShortDate(model.bounds.start)+' · сегодня';if(value)value.textContent=businessMoney(info.value);if(meta)meta.textContent=info.meta;
 if(yLabel)yLabel.textContent=yModel?businessShortDate(yModel.bounds.start)+' · до '+businessHourMinute(yModel.comparisonCutoff||yModel.bounds.end):'Вчера';
 if(yValue)yValue.textContent=yesterdayInfo?businessMoney(yesterdayInfo.value):'—';if(yMeta)yMeta.textContent=yesterdayInfo?yesterdayInfo.meta:'';
 if(compare)compare.innerHTML=yesterdayInfo?businessComparison(info.value,yesterdayInfo.value).html:'';businessPaintChart(model,info.field);
}
window.renderBusinessDashboard=async function(force=false){
 const root=businessEnsureUi();if(!root)return;if(!document.getElementById('reports')?.classList.contains('active')){businessPaintTabs();return}
 const seq=++businessRenderSeq;businessPaintTabs();const metric=document.getElementById('businessValueMetric'),label=document.getElementById('businessValueLabel'),value=document.getElementById('businessValue'),meta=document.getElementById('businessValueMeta'),yLabel=document.getElementById('businessYesterdayLabel'),yValue=document.getElementById('businessYesterdayValue'),yMeta=document.getElementById('businessYesterdayMeta'),compare=document.getElementById('businessYesterdayCompare'),chart=document.getElementById('businessChart');
 if(metric)metric.textContent='Считаю бизнес-показатели…';if(label)label.textContent='Сегодня';if(value)value.textContent='…';if(meta)meta.textContent='';if(yLabel)yLabel.textContent='Вчера';if(yValue)yValue.textContent='…';if(yMeta)yMeta.textContent='';if(compare)compare.innerHTML='';if(chart)chart.innerHTML='';
 try{const model=await businessBuildModel(force);if(seq!==businessRenderSeq)return;businessPaint(model)}
 catch(error){if(seq!==businessRenderSeq)return;if(label)label.textContent='Не удалось посчитать';if(value)value.textContent='—'}
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
