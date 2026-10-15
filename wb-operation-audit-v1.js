(function(){
'use strict';
const cache=new Map(),unitHistoryCache=new Map(),PAGE_SIZE=20;
let active=null;
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num=value=>Number.isFinite(Number(value))?Number(value):0;
const amount=(value,currency='UNKNOWN')=>new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2}).format(num(value))+(currency==='KZT'?' ₸':currency==='RUB'?' ₽':currency==='UNKNOWN'?'':(' '+escape(currency)));
const date=value=>value?new Date(Number(value)).toLocaleDateString('ru-RU',{timeZone:'Asia/Almaty'}):'—';
const title=market=>market==='WB2'?'WB 2':'WB 1';
window.wbReportProductAuditAction=function(market,days,item={}){
 if(!['WB','WB2'].includes(market))return '';
 const selected={productId:String(item.productId||''),vendorCode:String(item.vendorCode||''),nmId:String(item.nmId||''),barcode:String(item.barcode||''),name:String(item.name||item.title||item.vendorCode||'Товар WB')};
 return 'openWbProductOperations('+JSON.stringify(market)+','+Number(days)+','+JSON.stringify(selected)+')';
};
window.wbReportProductAuditAttrs=function(market,days,item){const action=window.wbReportProductAuditAction(market,days,item);return action?'role="button" tabindex="0" onclick="'+escape(action)+'" onkeydown="'+escape("if(event.key==='Enter'||event.key===' '){event.preventDefault();"+action+"}")+'"':''};
window.openWbProductOperations=function(market,days,item={}){window.openWbOperationAudit(market,days,Number(days)===0?reportCustomBounds():null,{item,product:item.productId?'p:'+item.productId:'',mode:'units',productOnly:true})};
function bounds(days,range){
 if(Number(days)!==0)return '';
 const b=range||reportCustomBounds();
 return '&from='+encodeURIComponent(b.start??b.since)+'&to='+encodeURIComponent(b.end??b.until);
}
function root(ctx){if(!ctx)return null;const el=document.getElementById('wbOperationAudit');return active===ctx&&el?.dataset.request===ctx.key?el:null}
function currencyNote(currency){return currency==='UNKNOWN'?'<div class="muted">Валюта не указана в исходной строке WB</div>':''}
function line(label,value,currency,signed=false){return '<div class="row" style="gap:8px;margin-top:5px"><span class="grow muted">'+escape(label)+'</span><b>'+(signed&&num(value)>0?'+ ':'')+amount(value,currency)+'</b></div>'}
function costHtml(rows,currency){
 const realized=rows.filter(r=>r.currency===currency&&(num(r.saleQty)||num(r.returnQty)));if(!realized.length)return '';
 if(realized.some(r=>r.costKzt===null||r.costKzt===undefined))return '<div class="row" style="margin-top:5px"><span class="grow muted">Себестоимость</span><b>—</b></div><div class="muted">Нет себестоимости для части выкупов / возвратов</div>';
 const value=realized.reduce((sum,r)=>sum+num(r.costKzt),0),estimated=realized.some(r=>r.costEstimated),sources=new Set(realized.map(r=>r.costSource));
 const source=estimated?'Себестоимость · оценка':'Себестоимость заказа',note=estimated?(sources.has('saved_order')?'Часть по заказам, часть — оценка':sources.has('product_cost')?'По текущей стоимости товара':'По средней закупочной с доставкой'):'';
 const result=rows.filter(r=>r.currency===currency).reduce((sum,r)=>sum+num(r.beforeAdsAndCost),0)-value;
 return line(source,value,'KZT')+(note?'<div class="muted">'+note+'</div>':'')+(currency==='KZT'?line(estimated?'До рекламы · оценка':'После себестоимости · до рекламы',result,currency):'<div class="muted">Себестоимость в ₸: из суммы в другой валюте не вычитается</div>');
}
function totalsHtml(values,rows=null){return values.map(t=>'<div class="item" style="margin-top:8px">'+currencyNote(t.currency)+line('Выручка · цена продавца',t.sellerRevenue,t.currency)+line('К перечислению за товар',t.forPay,t.currency)+line('Логистика',num(t.delivery)+num(t.rebill),t.currency)+line('Хранение и приёмка',num(t.storage)+num(t.acceptance),t.currency)+line('Штрафы и удержания',num(t.penalty)+num(t.deduction),t.currency)+line('Доплаты',t.additionalPayment,t.currency)+line('До рекламы и себестоимости',t.beforeAdsAndCost,t.currency)+(rows?costHtml(rows,t.currency):'')+'</div>').join('')}
function summed(rows){const map=new Map();for(const row of rows){const x=map.get(row.currency)||{currency:row.currency};for(const k of ['sellerRevenue','forPay','delivery','rebill','storage','acceptance','penalty','deduction','additionalPayment','beforeAdsAndCost','orderAdvertising'])x[k]=num(x[k])+num(row[k]);map.set(row.currency,x)}return [...map.values()]}
function unitResult(rows,t){
 const realized=rows.filter(r=>r.currency===t.currency&&(num(r.saleQty)||num(r.returnQty))),known=realized.every(r=>r.costKzt!==null&&r.costKzt!==undefined),estimated=realized.some(r=>r.costEstimated),cost=known?realized.reduce((sum,r)=>sum+num(r.costKzt),0):null;
 const ads=rows.filter(r=>r.kind==='advertising'&&num(r.orderAdvertising)!==0),adKnown=!rows.some(r=>r.adUnknown)&&ads.every(r=>r.currency===t.currency&&r.currency!=='UNKNOWN');
 const before=!realized.length?num(t.beforeAdsAndCost):known&&t.currency==='KZT'?num(t.beforeAdsAndCost)-cost:null;
 const profit=before!==null&&adKnown?before-num(t.orderAdvertising):null;
 return {realized,known,estimated:estimated||ads.some(r=>r.adEstimated),costEstimated:estimated,cost,before,profit,adKnown};
}
function periodMetricsHtml(rows,resultRows=rows,scope=''){return summed(resultRows?.length?resultRows:rows).map(t=>{
 const loaded=Boolean(resultRows?.length),calculation=unitResult(resultRows||[],t),{estimated,costEstimated}=calculation,before=loaded?calculation.before:null,profit=loaded?calculation.profit:null,ads=loaded&&calculation.adKnown?num(t.orderAdvertising):null,period=summed(rows).find(x=>x.currency===t.currency);
 const value=profit===null?'—':(estimated?'≈ ':'')+amount(profit,t.currency),beforeValue=before===null?'—':(costEstimated?'≈ ':'')+amount(before,t.currency),adValue=ads===null?'—':amount(Math.abs(ads),t.currency);
 const colour=profit===null?'var(--text)':profit<0?'var(--bad)':'var(--ok)',adColour=ads===null||ads===0?'var(--text)':ads<0?'var(--ok)':'var(--bad)';
 const metric=(label,value,className,colour='var(--text)')=>'<div class="wb-audit-term '+className+'"><span class="muted">'+label+'</span><b style="color:'+colour+'">'+value+'</b></div>';
 return '<div class="wb-audit-period"><div class="wb-audit-period-revenue"><span class="muted">Выручка за период</span><b>'+amount(period?.sellerRevenue||0,t.currency)+'</b></div>'+(scope?'<div class="muted wb-audit-scope">'+scope+'</div>':'')+'<div class="wb-audit-calculation" aria-label="Расчёт прибыли '+(scope?'за весь путь':'за выбранный период')+'">'+metric('Без рекламы',beforeValue,'wb-audit-before')+'<span class="wb-audit-operator">'+(ads!==null&&ads<0?'+':'−')+'</span>'+metric('Реклама',adValue,'wb-audit-advertising',adColour)+'<span class="wb-audit-operator">=</span>'+metric('Результат',value,'wb-audit-result',colour)+'</div></div>';
 }).join('')}
function unitMetricsHtml(rows,saved,error=''){
 return periodMetricsHtml(rows,saved?.operations||null,'Весь путь')+(!saved?(error?'<div class="muted" style="margin-top:6px">'+escape(error)+'</div><button type="button" class="btn" data-audit-action="unit-retry">Повторить</button>':'<div class="muted" style="margin-top:6px">Загружаю расходы и рекламу…</div>'):'');
}
function unitSummaryHtml(rows,scope='весь путь'){return summed(rows).map(t=>{
 const {realized,known,estimated,costEstimated,cost,profit,adKnown}=unitResult(rows,t);
 const label=(realized.length?'Прибыль после рекламы':'Результат до продажи')+' · '+scope,value=profit===null?'—':(estimated?'≈ ':'')+amount(profit,t.currency),colour=profit===null?'var(--text)':profit<0?'var(--bad)':'var(--ok)';
 const sources=new Set(realized.map(r=>r.costSource)),note=rows.some(r=>r.adUnknown)?'Не хватает связи с заказом для распределения рекламы':!adKnown?'Валюты рекламы и выручки не совпадают: нужен курс':!known?'Не хватает себестоимости':realized.length&&t.currency!=='KZT'?'Себестоимость в ₸: нужен курс для расчёта прибыли':costEstimated?(sources.has('saved_order')?'Часть себестоимости — оценка':sources.has('product_cost')?'Себестоимость по текущей стоимости':'Себестоимость по средней закупочной с доставкой'):'';
 // Split the seller-price withholding for display only: both fees are already in forPay.
 // Other WB payouts must stay separate, rather than lowering the sale commission.
 const salePay=realized.reduce((sum,r)=>sum+num(r.forPay),0),acquiring=realized.reduce((sum,r)=>sum+num(r.acquiring),0),commission=num(t.sellerRevenue)-salePay-acquiring,otherPay=num(t.forPay)-salePay;
 const expenses=[['Комиссия WB · с НДС',commission],['Эквайринг',acquiring],['Логистика · '+scope,num(t.delivery)],['Перевыставленная логистика',num(t.rebill)],['Хранение',num(t.storage)],['Приёмка',num(t.acceptance)],['Штрафы',num(t.penalty)],['Удержания',num(t.deduction)],['Реклама · по дате заказа',num(t.orderAdvertising)]];
 return '<div class="item wb-audit-unit-total">'+currencyNote(t.currency)+'<div class="row wb-audit-profit"><span class="grow">'+label+'</span><b style="color:'+colour+'">'+value+'</b></div>'+(num(t.sellerRevenue)!==0?line('Выручка · '+scope,t.sellerRevenue,t.currency,true):'')+expenses.filter(([,v])=>Math.abs(v)>=0.005).map(([name,v])=>line(name,-v,t.currency,true)).join('')+(otherPay!==0?line('Прочие выплаты WB',otherPay,t.currency,true):'')+(num(t.additionalPayment)!==0?line('Доплаты',t.additionalPayment,t.currency,true):'')+(realized.length?(known?line(costEstimated?'Себестоимость · оценка':'Себестоимость заказа',-cost,'KZT',true):'<div class="row"><span class="grow muted">Себестоимость</span><b>—</b></div>'):'')+(note?'<div class="muted" style="margin-top:6px">'+note+'</div>':'')+(num(t.orderAdvertising)!==0?'<div class="muted" style="margin-top:6px">Реклама распределена по загруженным заказам дня</div>':'')+'</div>';
 }).join('')}
function operationHtml(row){
 if(row.kind==='advertising'){const a=row.allocation||{};return '<div class="wb-audit-operation"><div class="row"><b class="grow">Реклама заказа</b><span class="muted">'+escape(a.day||row.orderDay)+'</span></div>'+line('Распределённый расход',-num(row.orderAdvertising),row.currency,true)+'<div class="muted" style="margin-top:6px">'+amount(a.budget,row.currency)+' / '+num(a.dayQty)+' заказанных шт. × '+num(a.qty)+' шт.</div></div>'}
 const bits=[row.saleQty?'Выкуп: '+row.saleQty+' шт.':'',row.returnQty?'Возврат: '+row.returnQty+' шт.':'',row.barcode?'Баркод '+escape(row.barcode):'',row.size?'Размер '+escape(row.size):'',row.srid?'Заказ '+escape(row.srid):'',row.shkId?'ШК '+escape(row.shkId):''].filter(Boolean);
 const rates=(row.saleQty||row.returnQty)?[row.commissionPercent!==null&&row.commissionPercent!==undefined?'кВВ: '+amount(row.commissionPercent,'UNKNOWN')+'%':'',row.wbDiscountPercent!==null&&row.wbDiscountPercent!==undefined?'Скидка WB: '+amount(row.wbDiscountPercent,'UNKNOWN')+'%':''].filter(Boolean).join(' · '):'';
 const price=(row.saleQty||row.returnQty)&&row.sellerUnitPrice!==null&&row.sellerUnitPrice!==undefined?line('Цена продавца / шт.',row.sellerUnitPrice,row.currency):'';
 const withholding=(row.saleQty||row.returnQty)&&row.sellerUnitPrice!==null&&row.sellerUnitPrice!==undefined?line('Удержано из цены продавца',-(num(row.sellerUnitPrice)*(num(row.saleQty)-num(row.returnQty))-num(row.forPay)),row.currency,true):'';
 const fields=[['Продажи / возврат',row.revenue],['К перечислению',row.forPay],['Вознаграждение с продаж · без НДС · в выплате',row.commission===null?null:-num(row.commission)],['Вознаграждение WB · без НДС · в выплате',row.wbReward!==null&&row.wbReward!==undefined&&Math.abs(num(row.wbReward)-num(row.commission))>=0.005?-num(row.wbReward):null],['НДС WB · в выплате',row.commissionVat===null?null:-num(row.commissionVat)],['Эквайринг · в выплате',-num(row.acquiring)],['Доставка',-num(row.delivery)],['Дополнительная перевозка',-num(row.rebill)],['Хранение',-num(row.storage)],['Приёмка',-num(row.acceptance)],['Штраф',-num(row.penalty)],['Удержания',-num(row.deduction)],['Списание WB Продвижение',-num(row.promotionDeduction)],['Доплата',row.additionalPayment]].filter(([,v])=>v!==null&&v!==undefined&&num(v)!==0).map(([name,v])=>line(name,v,row.currency,true)).join('');
 const caption=row.kind==='logistics'?(row.logisticsType||'Доставка'):num(row.rebill)!==0?'Дополнительная перевозка':row.operation;
 const cash=num(row.settlement??row.beforeAdsAndCost),flow=row.saleQty||row.returnQty?line('Выплата WB',row.forPay,row.currency,true):cash!==0?line(cash<0?'Расход':'Возврат / доплата',cash,row.currency,true):'';
 return '<div class="wb-audit-operation"><div class="row"><b class="grow">'+escape(caption)+'</b><span class="muted">'+date(row.date)+'</span></div>'+currencyNote(row.currency)+flow+'<details class="wb-audit-fields"><summary>Поля WB</summary><div class="muted" style="overflow-wrap:anywhere">'+bits.join(' · ')+'</div>'+price+(rates?'<div class="muted">'+rates+'</div>':'')+fields+withholding+'<div class="muted" style="margin-top:5px">Строка '+escape(row.rrdId)+(row.reportId?' · отчёт '+escape(row.reportId):'')+'</div></details></div>';
}
function historyHtml(data){const rows=data.operations;if(!rows.length)return '<div class="empty">Нет сохранённых операций этого ШК</div>';return unitSummaryHtml(rows)+'<details class="wb-audit-timeline"><summary>История движения · '+rows.length+' оп.</summary><div class="muted" style="margin-top:6px">Загруженные операции ШК · '+date(data.range.since)+' — '+date(data.range.until-1)+'</div>'+rows.map(operationHtml).join('')+'</details>'}
async function loadUnitHistory(ctx,group,details,refresh=false){
 const el=root(ctx),target=details.querySelector('[data-shk-history-content]');if(!el||!target)return;
 const first=group.rows.map(id=>ctx.rows.get(id)).find(r=>r?.nmId)||ctx.rows.get(group.rows[0]);if(!first||!first.nmId&&!first.productId){target.innerHTML='<div class="empty">Не удалось связать ШК с товаром</div>';return}
 const query='?market='+encodeURIComponent(ctx.market)+'&shkId='+encodeURIComponent(group.shkId)+(first.nmId?'&nmId='+encodeURIComponent(first.nmId):'')+(first.productId?'&productId='+encodeURIComponent(first.productId):'');
 if(!refresh&&ctx.histories.has(group.key)){target.innerHTML=historyHtml(ctx.histories.get(group.key));updateUnitView(ctx,group);return}
 if(!refresh&&ctx.historyPending.has(group.key)){target.innerHTML='<div class="muted">Загружаю весь путь ШК…</div>';return}
 const token={};details.historyRequest=token;target.innerHTML='<div class="empty">Загружаю весь путь ШК…</div>';
 try{
  let entry=unitHistoryCache.get(query);
  if(refresh||!entry||Date.now()-entry.at>=120000){const promise=apiJson(MILLIONER_API+'/api/wb-unit-history'+query).then(data=>{validHistory(data,unitRequest(ctx,group),ctx.market);return data}).catch(error=>{if(unitHistoryCache.get(query)?.promise===promise)unitHistoryCache.delete(query);throw error});entry={at:Date.now(),promise};unitHistoryCache.set(query,entry)}
  const data=await entry.promise;
  if(!root(ctx)||details.historyRequest!==token||!el.contains(details))return;
  ctx.histories.set(group.key,data);ctx.historyErrors.delete(group.key);target.innerHTML=historyHtml(data);updateUnitView(ctx,group);
 }catch(error){if(root(ctx)&&details.historyRequest===token&&el.contains(details)){ctx.historyErrors.set(group.key,String(error.message||error));updateUnitView(ctx,group);target.innerHTML='<div class="empty">Не удалось загрузить историю ШК: '+escape(error.message||error)+'</div><button type="button" class="btn full" data-audit-action="unit-retry">Повторить</button>'}}
}
function unitRequest(ctx,group){
 const rows=group.rows.map(id=>ctx.rows.get(id)).filter(Boolean),first=rows.find(r=>r.nmId)||rows[0];
 if(!first||!first.nmId&&!first.productId)throw Error('Не удалось связать ШК с товаром');
 return {shkId:String(group.shkId),nmId:String(first.nmId||''),productId:String(first.productId||'')};
}
function validHistory(data,request,market){
 if(!data?.ok||data.scope!=='unit-history'||data.market!==market||String(data.shkId)!==request.shkId||request.nmId&&String(data.nmId)!==request.nmId||request.productId&&data.productId!==undefined&&data.productId!==request.productId||!Array.isArray(data.operations)||data.operations.some(r=>String(r.shkId)!==request.shkId||String(r.nmId||'')!==String(data.nmId||'')||request.productId&&r.productId!==request.productId))throw Error(data?.error||'История относится к другому товару или ШК');
 if(!data.operations.length)throw Error('История ШК ещё не загружена');
 return data;
}
function updateUnitView(ctx,group){
 const el=root(ctx);if(!el)return;
 const details=[...el.querySelectorAll('[data-unit-key]')].find(x=>x.dataset.unitKey===group.key);if(!details)return;
 const saved=ctx.histories.get(group.key),rows=group.rows.map(id=>ctx.rows.get(id)).filter(Boolean),metrics=details.querySelector('[data-unit-metrics]'),content=details.querySelector('[data-shk-history-content]');
 if(metrics)metrics.innerHTML=unitMetricsHtml(rows,saved,ctx.historyErrors.get(group.key));
 if(saved&&content)content.innerHTML=historyHtml(saved);
}
async function loadVisibleUnitHistories(ctx,groups){
 const el=root(ctx);if(!el||ctx.mode!=='units')return;
 const visible=new Set([...el.querySelectorAll('[data-unit-key]')].map(x=>x.dataset.unitKey));
 const pending=groups.filter(g=>visible.has(g.key)&&!ctx.histories.has(g.key)&&!ctx.historyPending.has(g.key)&&!ctx.historyErrors.has(g.key)).slice(0,PAGE_SIZE);
 if(!pending.length)return;
 const requests=[];
 for(const group of pending){try{requests.push({group,request:unitRequest(ctx,group)});ctx.historyPending.add(group.key)}catch(error){ctx.historyErrors.set(group.key,error.message);updateUnitView(ctx,group)}}
 if(!requests.length)return;
 try{
  const query='?market='+encodeURIComponent(ctx.market)+'&units='+encodeURIComponent(JSON.stringify(requests.map(x=>x.request)));
  const data=await apiJson(MILLIONER_API+'/api/wb-unit-histories'+query);
  if(!root(ctx))return;
  if(!data?.ok||data.scope!=='unit-histories'||data.market!==ctx.market||!Array.isArray(data.histories)||data.histories.length!==requests.length)throw Error(data?.error||'Некорректный ответ истории ШК');
  requests.forEach(({group,request},index)=>{try{ctx.histories.set(group.key,validHistory(data.histories[index],request,ctx.market));ctx.historyErrors.delete(group.key)}catch(error){ctx.historyErrors.set(group.key,error.message)}});
 }catch(error){if(root(ctx))for(const {group} of requests)ctx.historyErrors.set(group.key,String(error.message||error))}
 finally{for(const {group} of requests){ctx.historyPending.delete(group.key);if(root(ctx))updateUnitView(ctx,group)}}
}
function unitOrderDateHtml(rows){
 const sales=rows.filter(r=>num(r.saleQty)>0),days=[...new Set(sales.map(r=>/^20\d{2}-\d{2}-\d{2}$/.test(r.orderDay||'')?r.orderDay:''))].sort();
 const labels=days.map(day=>day?day.split('-').reverse().join('.'):'—');
 return '<div class="muted" style="margin-top:3px">'+(labels.length>1?'Заказы: ':'Заказ: ')+(labels.join(', ')||'—')+'</div>';
}
function groupHtml(group,ctx,unit=false){const rows=group.rows.map(id=>ctx.rows.get(id)).filter(Boolean),first=rows[0];if(!first)return '';const saved=ctx.histories?.get(group.key),periodRevenue=unitMetricsHtml(rows,saved,ctx.historyErrors?.get(group.key));return '<details class="item wb-audit-group"'+(unit?' data-unit-key="'+escape(group.key)+'"':'')+'><summary><b>'+escape(first.productName)+'</b><div class="muted" style="overflow-wrap:anywhere">'+escape(unit?'ШК '+group.shkId:(group.srid?'Заказ '+group.srid:'Без ID заказа · строка '+first.rrdId))+' · '+rows.length+' оп.'+(unit?' за период':'')+'</div>'+(unit?unitOrderDateHtml(rows)+'<div data-unit-metrics>'+periodRevenue+'</div>':'')+'</summary>'+(unit?'<div data-shk-history-content>'+(saved?historyHtml(saved):'<div class="muted">Раскройте ШК, чтобы увидеть весь путь</div>')+'</div>':unitSummaryHtml(rows,'за период')+rows.map(operationHtml).join(''))+'</details>'}

function matches(row,ctx){const q=ctx.q.trim().toLocaleLowerCase('ru-RU');return (!ctx.product||row.productKey===ctx.product)&&(!q||[row.productName,row.vendorCode,row.nmId,row.barcode,row.shkId,row.srid,row.operation].some(v=>String(v||'').toLocaleLowerCase('ru-RU').includes(q)))&&(ctx.filter!=='unlinked'||!row.productId)&&(ctx.filter!=='no_order'||!row.srid)}
function adsSummary(rows,productOnly=false){const buckets=new Map();for(const x of rows){const t=buckets.get(x.currency)||{currency:x.currency,total:0,linked:0};t.total+=num(x.amount);if(x.productId)t.linked+=num(x.amount);buckets.set(x.currency,t)}return [...buckets.values()].map(t=>'<div class="item" style="margin-top:8px">'+currencyNote(t.currency)+(productOnly?line('Реклама товара',t.total,t.currency):line('Вся реклама',t.total,t.currency)+line('По товарам',t.linked,t.currency)+line('Без привязки',t.total-t.linked,t.currency))+'</div>').join('')}
function otherUnitExpensesHtml(ctx){
 if(!ctx.productOnly||ctx.mode!=='units')return '';
 const items=[];
 for(const group of ctx.data.units){
  const rows=group.rows.map(id=>ctx.rows.get(id)).filter(Boolean);
  if(!rows.length||!rows.some(r=>r.productKey===ctx.product)||rows.some(r=>num(r.saleQty)||num(r.returnQty)))continue;
  for(const t of summed(rows.filter(r=>r.kind!=='advertising')))if(Math.abs(t.beforeAdsAndCost)>=0.005)items.push({shkId:group.shkId,currency:t.currency,value:t.beforeAdsAndCost});
 }
 if(!items.length)return '';
 return '<details class="item" data-other-unit-expenses style="margin:8px 0"><summary>Другие расходы периода · '+new Set(items.map(x=>x.shkId)).size+' ШК</summary><div class="muted" style="margin-top:7px">Учтены в общем отчёте за выбранные даты.</div>'+items.slice(0,PAGE_SIZE).map(x=>line('ШК '+escape(x.shkId),x.value,x.currency,true)).join('')+(items.length>PAGE_SIZE?'<div class="muted">Ещё '+(items.length-PAGE_SIZE)+' строк</div>':'')+'</details>';
}
function draw(ctx){
 const el=root(ctx);if(!el||!ctx.data)return;
 const data=ctx.data,body=el.querySelector('[data-audit-body]'),pager=el.querySelector('[data-audit-pager]');
 let entries=[],render;
 if(ctx.mode==='products'){
  entries=data.products.filter(p=>p.rows.some(id=>matches(ctx.rows.get(id),ctx))||p.rows.length===0&&ctx.filter==='all'&&(!ctx.product||p.key===ctx.product)&&(!ctx.q||p.name.toLocaleLowerCase('ru-RU').includes(ctx.q.trim().toLocaleLowerCase('ru-RU'))));
  render=p=>'<div class="item wb-audit-group"><button type="button" class="wb-audit-product" data-audit-action="product" data-key="'+escape(p.key)+'"><b>'+escape(p.name)+'</b><div class="muted">'+escape(p.vendorCode||p.nmId||'')+(p.linked?'':' · без привязки')+' · '+p.rows.length+' оп.</div></button>'+totalsHtml(p.totals)+(p.advertising.length?'<div class="muted" style="margin-top:6px">Реклама: '+p.advertising.length+' начисл. · вкладка «Реклама»</div>':'')+'</div>';
 }else if(ctx.mode==='ads'){
  const q=ctx.q.trim().toLocaleLowerCase('ru-RU');entries=data.advertising.filter(x=>(!ctx.product||('p:'+x.productId)===ctx.product)&&(!q||[x.campaign,x.advertId,...x.nmIds,ctx.products.get('p:'+x.productId)?.name].some(v=>String(v||'').toLocaleLowerCase('ru-RU').includes(q)))&&(ctx.filter==='all'||!x.productId));
  render=x=>'<div class="item wb-audit-group"><b>'+escape(x.campaign||('Кампания '+x.advertId))+'</b><div class="row" style="margin-top:6px"><span class="grow muted">'+escape(x.day)+'</span><b>'+amount(x.amount,x.currency)+'</b></div><div class="muted" style="margin-top:5px">'+escape(x.productId?ctx.products.get('p:'+x.productId)?.name||'Товар связан':x.reason==='multiple_products'?'Несколько товаров / размеров · без распределения':'Без привязки к товару')+'</div><div class="muted">nmId: '+escape(x.nmIds.join(', ')||'—')+'</div>'+currencyNote(x.currency)+'</div>';
 }else{
  const groups=ctx.mode==='units'?data.units:data.orders;
  // The period response contains only this range's operations. A delivery,
  // return or allocated ad is not a sale, even if the sticker sold elsewhere
  // in its full history. Keep every period expense in the admitted group.
  entries=groups.filter(g=>g.rows.some(id=>{const row=ctx.rows.get(id);return matches(row,ctx)&&(ctx.mode!=='units'||num(row.saleQty)>0)}));
  render=g=>groupHtml(g,ctx,ctx.mode==='units');
 }
 const pages=Math.max(1,Math.ceil(entries.length/PAGE_SIZE));ctx.page=Math.max(1,Math.min(pages,ctx.page));
 const missingUnits=data.operations.filter(x=>matches(x,ctx)&&num(x.saleQty)>0&&!x.shkId).length;
 body.innerHTML=otherUnitExpensesHtml(ctx)+(ctx.mode==='units'&&(!ctx.productOnly||missingUnits>0)?'<div class="muted" style="margin:8px 0">'+(ctx.productOnly?'':'Связь по ШК конкретной штуки, за выбранный период. ')+'Продажи без ШК: '+missingUnits+' оп.'+(ctx.productOnly?'':' — доступны в «Заказах».')+'</div>':'')+(ctx.mode==='ads'&&!ctx.productOnly?'<div class="muted" style="margin:8px 0">Расходы кампаний за период. Списания «WB Продвижение» в финансовых строках показаны отдельно; оба расхода вместе повторно не вычитаются. Суммы с разными или неизвестными валютами не складываются.</div>':'')+(ctx.mode==='ads'?adsSummary(entries,ctx.productOnly)+(data.advertisingAllocation||[]).filter(a=>(!ctx.product||'p:'+a.productId===ctx.product)).map(a=>'<div class="item" style="margin-top:8px"><b>'+escape(a.day)+'</b>'+line('Реклама товара',a.amount,a.currency)+(a.qty?'<div class="muted">'+a.qty+' заказанных шт. · '+amount(a.perUnit,a.currency)+' / шт.</div>':'<div class="muted">Нет загруженных заказов: '+amount(a.unallocated,a.currency)+' не распределено</div>')+'</div>').join(''):'')+(entries.length?entries.slice((ctx.page-1)*PAGE_SIZE,ctx.page*PAGE_SIZE).map(render).join(''):'<div class="empty">'+(ctx.productOnly?(ctx.mode==='ads'?'Нет загруженных расходов рекламы по товару за этот период':ctx.mode==='units'?'Нет продаж товара за выбранный период':'Нет загруженных операций по товару за этот период'):(data.rowCount?(ctx.mode==='units'?'Нет продаж по выбранному фильтру за этот период':'Нет операций по выбранному фильтру'):'Финансовые операции WB за период ещё не загружены. Реклама доступна отдельно.'))+'</div>');
 pager.innerHTML=ctx.productOnly&&pages===1?'':'<span class="muted">'+entries.length+' поз. · '+ctx.page+' / '+pages+'</span><button type="button" class="btn" data-audit-action="prev" '+(ctx.page===1?'disabled':'')+'>←</button><button type="button" class="btn" data-audit-action="next" '+(ctx.page===pages?'disabled':'')+'>→</button>';
 el.querySelectorAll('[data-audit-mode]').forEach(b=>b.classList.toggle('dark',b.dataset.auditMode===ctx.mode));
 const product=el.querySelector('[data-audit-product]');if(product)product.value=ctx.product;
 if(ctx.mode==='units')void loadVisibleUnitHistories(ctx,entries.slice((ctx.page-1)*PAGE_SIZE,ctx.page*PAGE_SIZE));
}
function mount(ctx){
 const el=root(ctx);if(!el)return;const d=ctx.data;
 if(!ctx.productOnly){
 const warnings=[];
 if(d.sync&&num(d.sync.financeOk)!==1)warnings.push('Последнее обновление финансов WB не удалось. Показаны сохранённые операции.');
 if(d.sync&&num(d.sync.promotionOk)!==1)warnings.push('Последнее обновление рекламы не удалось. Расходы могут быть неполными.');
 if(d.history?.firstDate&&ctx.days>1&&d.range.since<num(d.history.firstDate))warnings.push('История в базе начинается '+date(d.history.firstDate)+'. Полнота более ранних дат не подтверждена.');
 const reconciliation=d.reconciliation.map(x=>line(x.balanced?'Раскладка строк сходится':'Расхождение раскладки',x.difference,x.currency)).join('');
 const comparisons=d.totals.map(x=>line('Разница с прежним расчётом до рекламы и себестоимости',x.calculationDelta,x.currency)).join('');
 el.querySelector('[data-audit-summary]').innerHTML=warnings.map(w=>'<div class="link-note">'+escape(w)+'</div>').join('')+'<div class="muted">'+date(d.range.since)+' — '+date(d.range.until-1)+' · '+d.rowCount+' загруженных оп. · выкупы: '+d.totals.reduce((sum,x)=>sum+num(x.saleQty),0)+' шт. · возвраты: '+d.totals.reduce((sum,x)=>sum+num(x.returnQty),0)+' шт.</div>'+totalsHtml(d.totals)+'<details class="item" style="margin-top:8px"><summary><b>Сверка и привязки</b></summary><div class="muted" style="margin-top:7px">Товар: '+d.coverage.linkedRows+'/'+d.rowCount+' · ID заказа: '+d.coverage.orderRows+'/'+d.rowCount+' · ШК: '+d.coverage.unitRows+'/'+d.rowCount+'</div>'+reconciliation+comparisons+'<div class="muted" style="margin-top:7px">Это сверка раскладки загруженных строк, а не подтверждение полного отчёта WB. Период — по дате финансовой операции. Комиссия и эквайринг уже входят в «К перечислению». Себестоимость заказа показана при точной связи с сохранённой продажей. Средняя закупочная и текущая стоимость помечены как оценка; это не FIFO конкретного ШК. Реклама по ШК не распределяется.</div></details>';
 }
 const period=el.querySelector('[data-audit-period]');if(period)period.textContent=date(d.range.since)+' — '+date(d.range.until-1);
 ctx.units=new Map(d.units.map(x=>[x.key,x]));
 ctx.rows=new Map(d.operations.map(x=>[x.rrdId,x]));ctx.products=new Map(d.products.map(x=>[x.key,x]));
 // An absent/ambiguous selected product must never silently open every store operation.
 if(ctx.item&&!ctx.item.productId){const item=ctx.item,clean=x=>String(x||'').trim().toLocaleLowerCase('ru-RU'),keys=new Set(d.operations.filter(x=>item.barcode?x.barcode===item.barcode:item.nmId?x.nmId===item.nmId&&(!item.vendorCode||clean(x.vendorCode)===clean(item.vendorCode)):item.vendorCode&&clean(x.vendorCode)===clean(item.vendorCode)).map(x=>x.productKey));ctx.product=keys.size===1?[...keys][0]:'__selected_missing__'}
 const missing=ctx.product&&!ctx.products.has(ctx.product)?'<option value="'+escape(ctx.product)+'">'+escape(ctx.item?.name||'Выбранный товар')+' · нет операций за период</option>':'';
 const productSelect=ctx.productOnly?null:el.querySelector('[data-audit-product]');if(productSelect)productSelect.innerHTML='<option value="">Все товары</option>'+missing+d.products.map(x=>'<option value="'+escape(x.key)+'">'+escape(x.name)+(x.linked?'':' · без привязки')+'</option>').join('');
 el.querySelector('[data-audit-controls]').hidden=false;draw(ctx);
}
async function load(ctx,refresh=false){const el=root(ctx);if(!el)return;const seq=ctx.loadSeq=(ctx.loadSeq||0)+1;el.querySelector('[data-audit-body]').innerHTML='<div class="empty">Загружаю операции…</div>';try{
 const old=cache.get(ctx.query);let data;
 if(!refresh&&old&&Date.now()-old.at<60000)data=old.data;
 else{data=await apiJson(MILLIONER_API+'/api/wb-operation-audit'+ctx.query);if(!data?.ok||!Array.isArray(data.operations))throw new Error('Некорректный ответ отчёта');cache.set(ctx.query,{at:Date.now(),data})}
 if(!root(ctx)||ctx.loadSeq!==seq)return;ctx.data=data;mount(ctx);
 }catch(error){const target=root(ctx);if(target&&ctx.loadSeq===seq)target.querySelector('[data-audit-body]').innerHTML='<div class="empty">Не удалось загрузить операции: '+escape(error.message||error)+'</div><button class="btn full" type="button" data-audit-action="refresh">Повторить</button>'}}
window.openWbOperationAudit=function(market,days=30,range=null,selection=null){
 if(!['WB','WB2'].includes(market))return;
 const n=Number(days)===-1?-1:Number(days)===0?0:Math.max(1,Math.min(365,Math.round(Number(days)||30)));
 const previous=root(active)&&active.market===market?active:null,back=previous?previous.back:{market,days:n},chosen=selection||previous||{};
 const ctx={market,days:n,range,back,query:'?market='+market+'&days='+n+bounds(n,range),key:market+':'+Date.now()+':'+Math.random(),q:'',product:chosen.product||'',item:chosen.item||null,filter:'all',mode:chosen.mode||'products',productOnly:Boolean(chosen.productOnly),histories:new Map(),historyErrors:new Map(),historyPending:new Set(),page:1};if(ctx.productOnly&&!['units','ads'].includes(ctx.mode))ctx.mode='units';active=ctx;
 const selectors=ctx.productOnly?'':'<div class="field" style="margin-top:12px"><input data-audit-search placeholder="Товар, артикул, ШК или ID заказа" aria-label="Поиск операций WB"></div><div class="two"><select class="btn" data-audit-product aria-label="Товар"><option value="">Все товары</option></select><select class="btn" data-audit-filter aria-label="Привязка"><option value="all">Все операции</option><option value="unlinked">Без товара</option><option value="no_order">Без ID заказа</option></select></div>';
 const modes=ctx.productOnly?[['units','По ШК'],['ads','Реклама']]:[['products','Товары'],['orders','Заказы'],['units','По ШК'],['ads','Реклама']];
 showSheet('<div id="wbOperationAudit" data-request="'+escape(ctx.key)+'"><h3>'+escape(ctx.productOnly?(ctx.item?.name||'Товар WB'):'Операции '+title(market))+'</h3>'+(ctx.productOnly?'<div class="muted">'+title(market)+' · <span data-audit-period></span></div>':'')+'<div class="period" style="flex-wrap:wrap">'+[[1,'Сегодня'],[-1,'Вчера'],[7,'7 дней'],[30,'30 дней']].map(([d,label])=>'<button type="button" class="chip '+(n===d?'active':'')+'" data-audit-days="'+d+'">'+label+'</button>').join('')+'</div><details style="margin:8px 0"><summary>Свой период</summary><div class="two"><div class="field"><label>С</label><input type="date" data-audit-from></div><div class="field"><label>По</label><input type="date" data-audit-to></div></div><button type="button" class="btn full" data-audit-action="range">Показать</button></details>'+(ctx.productOnly?'':'<div data-audit-summary></div>')+'<div data-audit-controls hidden>'+selectors+'<div class="integration-actions" style="margin:8px 0">'+modes.map(([mode,label])=>'<button type="button" class="btn" data-audit-mode="'+mode+'">'+label+'</button>').join('')+'</div></div><div data-audit-body></div><div class="integration-actions" data-audit-pager></div>'+(ctx.productOnly?'':'<button type="button" class="btn full" style="margin-top:10px" data-audit-action="refresh">Обновить</button>')+'<button type="button" class="btn full" style="margin-top:8px" data-audit-action="back">Назад к отчёту</button></div>');
 const el=root(ctx);if(!el)return;
 el.addEventListener('toggle',event=>{const details=event.target;if(!details.open||!details.dataset.unitKey)return;const group=ctx.units?.get(details.dataset.unitKey);if(group)void loadUnitHistory(ctx,group,details)},true);
 el.addEventListener('input',event=>{if(event.target.matches('[data-audit-search]')){ctx.q=event.target.value;ctx.page=1;draw(ctx)}});
 el.addEventListener('change',event=>{if(event.target.matches('[data-audit-product]')){if(ctx.productOnly)return;ctx.product=event.target.value;ctx.item=null}else if(event.target.matches('[data-audit-filter]'))ctx.filter=event.target.value;else return;ctx.page=1;draw(ctx)});
 el.addEventListener('click',event=>{
  const button=event.target.closest('button');if(!button||!el.contains(button))return;
  if(button.dataset.auditDays){openWbOperationAudit(market,Number(button.dataset.auditDays));return}
  if(button.dataset.auditMode){if(ctx.productOnly&&!['units','ads'].includes(button.dataset.auditMode))return;ctx.mode=button.dataset.auditMode;ctx.page=1;draw(ctx);return}
  const action=button.dataset.auditAction;
  if(action==='unit-retry'){event.preventDefault?.();event.stopPropagation?.();const details=button.closest('[data-unit-key]'),group=ctx.units?.get(details?.dataset.unitKey);if(group)void loadUnitHistory(ctx,group,details,true)}
  else if(action==='product'){if(ctx.productOnly)return;ctx.product=button.dataset.key;ctx.item=null;ctx.mode='orders';ctx.page=1;draw(ctx)}
  else if(action==='prev'||action==='next'){ctx.page+=action==='prev'?-1:1;draw(ctx)}
  else if(action==='refresh')load(ctx,true);
  else if(action==='back'){active=null;openStoreDetail(ctx.back.market,ctx.back.days)}
  else if(action==='range'){const from=el.querySelector('[data-audit-from]').value,to=el.querySelector('[data-audit-to]').value,start=Date.parse(from+'T00:00:00+05:00'),end=Date.parse(to+'T00:00:00+05:00')+86400000;if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||end-start>366*86400000)return alert('Проверьте даты: период не более года.');openWbOperationAudit(market,0,{start,end})}
 });
 const from=el.querySelector('[data-audit-from]'),to=el.querySelector('[data-audit-to]'),b=range||(n===0?reportCustomBounds():null);
 if(b){const iso=value=>new Date(Number(value)+5*3600000).toISOString().slice(0,10);from.value=iso(b.start??b.since);to.value=iso((b.end??b.until)-1)}
 void load(ctx);
};
const style=document.createElement('style');style.textContent='#wbOperationAudit .wb-audit-group{margin-top:8px;overflow-wrap:anywhere}#wbOperationAudit .wb-audit-product{border:0;background:none;color:inherit;font:inherit;text-align:left;width:100%;padding:0;cursor:pointer}#wbOperationAudit summary{cursor:pointer;list-style-position:inside}#wbOperationAudit .wb-audit-operation{border-top:1px solid var(--line);padding:10px 0;margin-top:8px}#wbOperationAudit select{width:100%;min-width:0;overflow:hidden}#wbOperationAudit .row b{white-space:nowrap}#wbOperationAudit input{min-width:0;max-width:100%}#wbOperationAudit .wb-audit-period{margin-top:10px}#wbOperationAudit .wb-audit-period-revenue{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:10px}#wbOperationAudit .wb-audit-period .muted{font-size:12px}#wbOperationAudit .wb-audit-period b{font-size:17px;overflow-wrap:anywhere;min-width:0}#wbOperationAudit .wb-audit-scope{margin-bottom:6px}#wbOperationAudit .wb-audit-calculation{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr) auto minmax(0,1fr);gap:6px;align-items:stretch}#wbOperationAudit .wb-audit-term{display:flex;flex-direction:column;justify-content:space-between;gap:5px;min-width:0}#wbOperationAudit .wb-audit-operator{align-self:end;padding-bottom:2px;font-size:18px;color:var(--muted)}#wbOperationAudit .wb-audit-unit-total{margin-top:10px}#wbOperationAudit .wb-audit-profit{padding-bottom:10px;margin-bottom:8px;border-bottom:1px solid var(--line);font-weight:750}#wbOperationAudit .wb-audit-profit b{font-size:22px}#wbOperationAudit .wb-audit-timeline{margin-top:12px}#wbOperationAudit .wb-audit-fields{margin-top:8px;color:var(--muted)}';document.head.appendChild(style);
})();
