(function(){
'use strict';
const cache=new Map(),PAGE_SIZE=20;
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
window.openWbProductOperations=function(market,days,item={}){window.openWbOperationAudit(market,days,Number(days)===0?reportCustomBounds():null,{item,product:item.productId?'p:'+item.productId:'',mode:'units'})};
function bounds(days,range){
 if(Number(days)!==0)return '';
 const b=range||reportCustomBounds();
 return '&from='+encodeURIComponent(b.start??b.since)+'&to='+encodeURIComponent(b.end??b.until);
}
function root(ctx){if(!ctx)return null;const el=document.getElementById('wbOperationAudit');return active===ctx&&el?.dataset.request===ctx.key?el:null}
function currencyNote(currency){return currency==='UNKNOWN'?'<div class="muted">Валюта не указана в исходной строке WB</div>':''}
function line(label,value,currency){return '<div class="row" style="gap:8px;margin-top:5px"><span class="grow muted">'+escape(label)+'</span><b>'+amount(value,currency)+'</b></div>'}
function totalsHtml(values){return values.map(t=>'<div class="item" style="margin-top:8px">'+currencyNote(t.currency)+line('К перечислению за товар',t.forPay,t.currency)+line('Логистика',num(t.delivery)+num(t.rebill),t.currency)+line('Хранение и приёмка',num(t.storage)+num(t.acceptance),t.currency)+line('Штрафы и удержания',num(t.penalty)+num(t.deduction),t.currency)+line('Доплаты',t.additionalPayment,t.currency)+line('До рекламы и себестоимости',t.beforeAdsAndCost,t.currency)+'</div>').join('')}
function summed(rows){const map=new Map();for(const row of rows){const x=map.get(row.currency)||{currency:row.currency};for(const k of ['forPay','delivery','rebill','storage','acceptance','penalty','deduction','additionalPayment','beforeAdsAndCost'])x[k]=num(x[k])+num(row[k]);map.set(row.currency,x)}return [...map.values()]}
function operationHtml(row){
 const bits=[row.saleQty?'Выкуп: '+row.saleQty+' шт.':'',row.returnQty?'Возврат: '+row.returnQty+' шт.':'',row.barcode?'Баркод '+escape(row.barcode):'',row.size?'Размер '+escape(row.size):'',row.srid?'Заказ '+escape(row.srid):'',row.shkId?'ШК '+escape(row.shkId):''].filter(Boolean);
 const details=[['Продажи / возврат',row.revenue],['К перечислению',row.forPay],['Комиссия · уже в выплате',row.commission],['Эквайринг · уже в выплате',row.acquiring],['Логистика',row.delivery],['Перевыставленная логистика',row.rebill],['Хранение',row.storage],['Приёмка',row.acceptance],['Штраф',row.penalty],['Удержания',row.deduction],['Списание WB Продвижение',row.promotionDeduction],['Доплата',row.additionalPayment]].filter(([,v])=>v!==null&&num(v)!==0).map(([label,v])=>line(label,v,row.currency)).join('');
 return '<div class="wb-audit-operation"><b>'+escape(row.operation)+'</b><span class="muted" style="float:right">'+date(row.date)+'</span><div class="muted" style="margin-top:4px;overflow-wrap:anywhere">'+bits.join(' · ')+'</div>'+currencyNote(row.currency)+details+line('Результат WB до рекламы и себестоимости',row.beforeAdsAndCost,row.currency)+'<div class="muted" style="margin-top:5px">Строка '+escape(row.rrdId)+(row.reportId?' · отчёт '+escape(row.reportId):'')+'</div></div>';
}
function groupHtml(group,ctx,unit=false){const rows=group.rows.map(id=>ctx.rows.get(id)).filter(Boolean),first=rows[0];if(!first)return '';return '<details class="item wb-audit-group"><summary><b>'+escape(first.productName)+'</b><div class="muted" style="overflow-wrap:anywhere">'+escape(unit?'ШК '+group.shkId:(group.srid?'Заказ '+group.srid:'Без ID заказа · строка '+first.rrdId))+' · '+rows.length+' оп.</div></summary>'+totalsHtml(summed(rows))+rows.map(operationHtml).join('')+'</details>'}
function matches(row,ctx){const q=ctx.q.trim().toLocaleLowerCase('ru-RU');return (!ctx.product||row.productKey===ctx.product)&&(!q||[row.productName,row.vendorCode,row.nmId,row.barcode,row.shkId,row.srid,row.operation].some(v=>String(v||'').toLocaleLowerCase('ru-RU').includes(q)))&&(ctx.filter!=='unlinked'||!row.productId)&&(ctx.filter!=='no_order'||!row.srid)}
function adsSummary(rows){const buckets=new Map();for(const x of rows){const t=buckets.get(x.currency)||{currency:x.currency,total:0,linked:0};t.total+=num(x.amount);if(x.productId)t.linked+=num(x.amount);buckets.set(x.currency,t)}return [...buckets.values()].map(t=>'<div class="item" style="margin-top:8px">'+currencyNote(t.currency)+line('Вся реклама',t.total,t.currency)+line('По товарам',t.linked,t.currency)+line('Без привязки',t.total-t.linked,t.currency)+'</div>').join('')}
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
  entries=groups.filter(g=>g.rows.some(id=>matches(ctx.rows.get(id),ctx)));
  render=g=>groupHtml(g,ctx,ctx.mode==='units');
 }
 const pages=Math.max(1,Math.ceil(entries.length/PAGE_SIZE));ctx.page=Math.max(1,Math.min(pages,ctx.page));
 body.innerHTML=(ctx.mode==='units'?'<div class="muted" style="margin:8px 0">Связь по ШК конкретной штуки, за выбранный период. Без ШК: '+(data.rowCount-data.coverage.unitRows)+' оп. — доступны в «Заказах».</div>':'')+(ctx.mode==='ads'?'<div class="muted" style="margin:8px 0">Расходы кампаний за период. Списания «WB Продвижение» в финансовых строках показаны отдельно; оба расхода вместе повторно не вычитаются. Суммы с разными или неизвестными валютами не складываются.</div>':'')+(ctx.mode==='ads'?adsSummary(entries):'')+(entries.length?entries.slice((ctx.page-1)*PAGE_SIZE,ctx.page*PAGE_SIZE).map(render).join(''):'<div class="empty">'+(data.rowCount?'Нет операций по выбранному фильтру':'Финансовые операции WB за период ещё не загружены. Реклама доступна отдельно.')+'</div>');
 pager.innerHTML='<span class="muted">'+entries.length+' поз. · '+ctx.page+' / '+pages+'</span><button type="button" class="btn" data-audit-action="prev" '+(ctx.page===1?'disabled':'')+'>←</button><button type="button" class="btn" data-audit-action="next" '+(ctx.page===pages?'disabled':'')+'>→</button>';
 el.querySelectorAll('[data-audit-mode]').forEach(b=>b.classList.toggle('dark',b.dataset.auditMode===ctx.mode));
 const product=el.querySelector('[data-audit-product]');if(product)product.value=ctx.product;
}
function mount(ctx){
 const el=root(ctx);if(!el)return;const d=ctx.data;
 const warnings=[];
 if(d.sync&&num(d.sync.financeOk)!==1)warnings.push('Последнее обновление финансов WB не удалось. Показаны сохранённые операции.');
 if(d.sync&&num(d.sync.promotionOk)!==1)warnings.push('Последнее обновление рекламы не удалось. Расходы могут быть неполными.');
 if(d.history?.firstDate&&ctx.days>1&&d.range.since<num(d.history.firstDate))warnings.push('История в базе начинается '+date(d.history.firstDate)+'. Полнота более ранних дат не подтверждена.');
 const reconciliation=d.reconciliation.map(x=>line(x.balanced?'Раскладка строк сходится':'Расхождение раскладки',x.difference,x.currency)).join('');
 const comparisons=d.totals.map(x=>line('Разница с текущим расчётом до рекламы и себестоимости',x.calculationDelta,x.currency)).join('');
 el.querySelector('[data-audit-summary]').innerHTML=warnings.map(w=>'<div class="link-note">'+escape(w)+'</div>').join('')+'<div class="muted">'+date(d.range.since)+' — '+date(d.range.until-1)+' · '+d.rowCount+' загруженных оп. · выкупы: '+d.totals.reduce((sum,x)=>sum+num(x.saleQty),0)+' шт. · возвраты: '+d.totals.reduce((sum,x)=>sum+num(x.returnQty),0)+' шт.</div>'+totalsHtml(d.totals)+'<details class="item" style="margin-top:8px"><summary><b>Сверка и привязки</b></summary><div class="muted" style="margin-top:7px">Товар: '+d.coverage.linkedRows+'/'+d.rowCount+' · ID заказа: '+d.coverage.orderRows+'/'+d.rowCount+' · ШК: '+d.coverage.unitRows+'/'+d.rowCount+'</div>'+reconciliation+comparisons+'<div class="muted" style="margin-top:7px">Это сверка раскладки загруженных строк, а не подтверждение полного отчёта WB. Период — по дате финансовой операции. Комиссия и эквайринг уже входят в «К перечислению». Прибыль после рекламы и FIFO появится после проверки связей себестоимости.</div></details>';
 ctx.rows=new Map(d.operations.map(x=>[x.rrdId,x]));ctx.products=new Map(d.products.map(x=>[x.key,x]));
 // An absent/ambiguous selected product must never silently open every store operation.
 if(ctx.item&&!ctx.item.productId){const item=ctx.item,clean=x=>String(x||'').trim().toLocaleLowerCase('ru-RU'),keys=new Set(d.operations.filter(x=>item.barcode?x.barcode===item.barcode:item.nmId?x.nmId===item.nmId&&(!item.vendorCode||clean(x.vendorCode)===clean(item.vendorCode)):item.vendorCode&&clean(x.vendorCode)===clean(item.vendorCode)).map(x=>x.productKey));ctx.product=keys.size===1?[...keys][0]:'__selected_missing__'}
 const missing=ctx.product&&!ctx.products.has(ctx.product)?'<option value="'+escape(ctx.product)+'">'+escape(ctx.item?.name||'Выбранный товар')+' · нет операций за период</option>':'';
 el.querySelector('[data-audit-product]').innerHTML='<option value="">Все товары</option>'+missing+d.products.map(x=>'<option value="'+escape(x.key)+'">'+escape(x.name)+(x.linked?'':' · без привязки')+'</option>').join('');
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
 const ctx={market,days:n,range,back,query:'?market='+market+'&days='+n+bounds(n,range),key:market+':'+Date.now()+':'+Math.random(),q:'',product:chosen.product||'',item:chosen.item||null,filter:'all',mode:chosen.mode||'products',page:1};active=ctx;
 showSheet('<div id="wbOperationAudit" data-request="'+escape(ctx.key)+'"><h3>Операции '+title(market)+'</h3><div class="period" style="flex-wrap:wrap">'+[[1,'Сегодня'],[-1,'Вчера'],[7,'7 дней'],[30,'30 дней']].map(([d,label])=>'<button type="button" class="chip '+(n===d?'active':'')+'" data-audit-days="'+d+'">'+label+'</button>').join('')+'</div><details style="margin:8px 0"><summary>Свой период</summary><div class="two"><div class="field"><label>С</label><input type="date" data-audit-from></div><div class="field"><label>По</label><input type="date" data-audit-to></div></div><button type="button" class="btn full" data-audit-action="range">Показать</button></details><div data-audit-summary></div><div data-audit-controls hidden><div class="field" style="margin-top:12px"><input data-audit-search placeholder="Товар, артикул, ШК или ID заказа" aria-label="Поиск операций WB"></div><div class="two"><select class="btn" data-audit-product aria-label="Товар"><option value="">Все товары</option></select><select class="btn" data-audit-filter aria-label="Привязка"><option value="all">Все операции</option><option value="unlinked">Без товара</option><option value="no_order">Без ID заказа</option></select></div><div class="integration-actions" style="margin:8px 0">'+[['products','Товары'],['orders','Заказы'],['units','По ШК'],['ads','Реклама']].map(([mode,label])=>'<button type="button" class="btn" data-audit-mode="'+mode+'">'+label+'</button>').join('')+'</div></div><div data-audit-body></div><div class="integration-actions" data-audit-pager></div><button type="button" class="btn full" style="margin-top:10px" data-audit-action="refresh">Обновить</button><button type="button" class="btn full" style="margin-top:8px" data-audit-action="back">Назад к отчёту</button></div>');
 const el=root(ctx);if(!el)return;
 el.addEventListener('input',event=>{if(event.target.matches('[data-audit-search]')){ctx.q=event.target.value;ctx.page=1;draw(ctx)}});
 el.addEventListener('change',event=>{if(event.target.matches('[data-audit-product]')){ctx.product=event.target.value;ctx.item=null}else if(event.target.matches('[data-audit-filter]'))ctx.filter=event.target.value;else return;ctx.page=1;draw(ctx)});
 el.addEventListener('click',event=>{
  const button=event.target.closest('button');if(!button||!el.contains(button))return;
  if(button.dataset.auditDays){openWbOperationAudit(market,Number(button.dataset.auditDays));return}
  if(button.dataset.auditMode){ctx.mode=button.dataset.auditMode;ctx.page=1;draw(ctx);return}
  const action=button.dataset.auditAction;
  if(action==='product'){ctx.product=button.dataset.key;ctx.item=null;ctx.mode='orders';ctx.page=1;draw(ctx)}
  else if(action==='prev'||action==='next'){ctx.page+=action==='prev'?-1:1;draw(ctx)}
  else if(action==='refresh')load(ctx,true);
  else if(action==='back'){active=null;openStoreDetail(ctx.back.market,ctx.back.days)}
  else if(action==='range'){const from=el.querySelector('[data-audit-from]').value,to=el.querySelector('[data-audit-to]').value,start=Date.parse(from+'T00:00:00+05:00'),end=Date.parse(to+'T00:00:00+05:00')+86400000;if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||end-start>366*86400000)return alert('Проверьте даты: период не более года.');openWbOperationAudit(market,0,{start,end})}
 });
 const from=el.querySelector('[data-audit-from]'),to=el.querySelector('[data-audit-to]'),b=range||(n===0?reportCustomBounds():null);
 if(b){const iso=value=>new Date(Number(value)+5*3600000).toISOString().slice(0,10);from.value=iso(b.start??b.since);to.value=iso((b.end??b.until)-1)}
 void load(ctx);
};
const style=document.createElement('style');style.textContent='#wbOperationAudit .wb-audit-group{margin-top:8px;overflow-wrap:anywhere}#wbOperationAudit .wb-audit-product{border:0;background:none;color:inherit;font:inherit;text-align:left;width:100%;padding:0;cursor:pointer}#wbOperationAudit summary{cursor:pointer;list-style-position:inside}#wbOperationAudit .wb-audit-operation{border-top:1px solid var(--line);padding:10px 0;margin-top:8px}#wbOperationAudit select{width:100%;min-width:0;overflow:hidden}#wbOperationAudit .row b{white-space:nowrap}#wbOperationAudit input{min-width:0;max-width:100%}';document.head.appendChild(style);
})();
