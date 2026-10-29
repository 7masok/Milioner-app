(()=>{
'use strict';
const e=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const actions={created:'Товар создан',updated:'Карточка изменена',deleted:'Товар удалён'};
const fields={id:'ID',name:'Название',stock:'Учётный остаток',cost:'Себестоимость',min:'Минимальный остаток',category:'Категория',photo:'Фото',kind:'Тип товара',components:'Состав набора',packagingRecipe:'Упаковка',kaspi:'Артикул Kaspi',kaspiAliases:'Другие артикулы Kaspi',wb:'Артикул WB1',wbAliases:'Другие артикулы WB1',wb2:'Артикул WB2',wb2Aliases:'Другие артикулы WB2',ozon:'Артикул Ozon',ozonAliases:'Другие артикулы Ozon',productId:'Товар',qty:'Количество',remainingQty:'Остаток партии',status:'Статус',active:'Активен',source:'Канал',channel:'Площадка',type:'Операция',date:'Дата операции',unitCost:'Цена закупки',buyTotal:'Стоимость партии',delivery:'Доставка',extra:'Комментарий',totalProfit:'Накопленная прибыль',variantGroupId:'Группа размеров',warehouseQty:'Резерв из складских партий',warehouseLots:'Зарезервированные партии'};
Object.assign(fields,{wbVariant:'Привязка WB',nmId:'Артикул карточки WB',chrtId:'Код размера WB',vendorCode:'Артикул продавца',createdAt:'Дата создания',receivedAt:'Дата поступления в продажу',sentAt:'Дата отправки',closedAt:'Дата завершения',orderedAt:'Дата заказа',warehouseReceivedAt:'Дата поступления на склад',forwarderReceivedAt:'Дата передачи в доставку',landedUnitCost:'Себестоимость с доставкой',batch:'Партия',note:'Примечание',comment:'Комментарий',workflowStageId:'Этап доставки',workflowStageStartedAt:'Дата начала этапа',warehouseWrittenOffQty:'Списано со склада',releasedQty:'Передано в продажу',reservedQty:'Зарезервировано',size:'Размер',color:'Цвет',barcode:'Штрихкод',price:'Цена',profit:'Прибыль',revenue:'Выручка',amount:'Сумма',orderId:'Номер заказа',orderCode:'Номер заказа',externalKey:'Связь с заказом',returnAdjustment:'Партия возврата',relocation:'Перемещение',manualReturn:'Ручной возврат',stockRestoredAt:'Дата возврата остатка',cancelledAt:'Дата отмены',costTotal:'Общая себестоимость',salePrice:'Цена продажи',quantity:'Количество',purchaseId:'Партия',lotId:'Партия',variantBarcode:'Штрихкод размера',returnSize:'Размер возврата',market:'Площадка',marketplace:'Площадка'});
const statuses={to_forwarder:'Доставка от продавца',to_me:'В пути ко мне',at_warehouse:'На складе',received:'В продаже',paid:'Оплачено',departed:'Выехало от продавца',delivery_warehouse:'Прибыло на склад доставки',arrived:'Поступило ко мне',pending:'Ожидает обработки',cancelled:'Отменено',canceled:'Отменено',completed:'Завершено',shipped:'Отправлено',delivered:'Доставлено',returned:'Возвращено',active:'Активен',released:'Освобождён'};
const kinds={bundle:'Набор',simple:'Обычный товар',product:'Обычный товар',variant:'Размер товара',size:'Размер товара'};
const dateKeys=new Set(['date','createdAt','receivedAt','sentAt','closedAt','orderedAt','warehouseReceivedAt','forwarderReceivedAt','workflowStageStartedAt','stockRestoredAt','cancelledAt']);
const internalKeys=new Set(['stock','cost','totalProfit','id','productId','externalKey','variantGroupId','purchaseId','lotId']);
function label(key){return fields[key]||'Дополнительное поле'}
function productName(id){try{return (typeof state!=='undefined'?state.products:[])?.find(p=>String(p.id)===String(id))?.name||'Товар (название недоступно)'}catch{return 'Товар (название недоступно)'}}
function stageName(id){try{const stage=typeof purchaseWorkflow==='function'?purchaseWorkflow().find(s=>s.id===id):null;return stage?.name||statuses[id]||'Другой этап'}catch{return statuses[id]||'Другой этап'}}
let view=null,seq=0;
const moneyless=v=>typeof v==='number'?v.toLocaleString('ru-RU'):String(v);
function value(v,exists,after=false,key='',depth=0){
 if(!exists)return after?'удалено':'не было';if(v===null||v==='')return 'не задано';
 if(dateKeys.has(key)){const date=typeof v==='number'?v:typeof v==='string'&&/^\d{10,13}$/.test(v)?Number(v):Date.parse(v);return Number.isFinite(date)&&date>0?new Date(date).toLocaleString('ru-RU',{timeZone:'Asia/Almaty'}):'не задано'}
 if(v?._historySummary)return 'Большое значение · '+v.characters+' символов';
 if(key==='status')return statuses[v]||(/[а-яё]/i.test(String(v))?String(v):'Другой статус');
 if(key==='workflowStageId')return stageName(v);
 if(key==='kind')return kinds[v]||'Другой тип товара';
 if(key==='photo')return 'Фото добавлено или заменено';
 if(key==='productId')return productName(v);
 if(typeof v==='boolean')return v?'Да':'Нет';
 if(typeof v==='object'){
  if(depth>=3)return 'Вложенные данные';
  if(Array.isArray(v))return v.length?v.map(x=>value(x,true,after,key,depth+1)).join('; '):'Пустой список';
  return Object.entries(v).filter(([k])=>!internalKeys.has(k)||k==='productId').map(([k,x])=>label(k)+': '+value(x,true,after,k,depth+1)).join('; ')||'Нет дополнительных данных';
 }
 return moneyless(v);
}
function rowHtml(row){
 const visible=Object.entries(row.changes||{}).filter(([key])=>!internalKeys.has(key));
 if(row.action==='updated'&&!visible.length)return '';
 const changes=visible.map(([key,c])=>`<div class="ph-change"><b>${e(label(key))}</b><div><del>${e(value(c.before,c.beforeExists,false,key))}</del><span> → </span><strong>${e(value(c.after,c.afterExists,true,key))}</strong></div></div>`).join('');
 return `<article class="ph-row"><div class="ph-time">${e(new Date(Number(row.happenedAt)).toLocaleString('ru-RU',{timeZone:'Asia/Almaty'}))}</div><b>${e(actions[row.action]||'Карточка изменена')}</b><div>${e(row.productName||'Товар без названия')}</div>${row.action==='updated'&&visible.length?`<details><summary>Что изменилось · ${visible.length}</summary>${changes}</details>`:''}</article>`;
}
function installStyle(){if(document.getElementById('productHistoryStyle'))return;const style=document.createElement('style');style.id='productHistoryStyle';style.textContent='.ph-controls{display:grid;grid-template-columns:1fr;gap:7px;margin:10px 0}.ph-controls input{grid-column:1/-1}.ph-controls input,.ph-controls select{width:100%;min-width:0;box-sizing:border-box;padding:9px;border:1px solid #ddd;border-radius:9px;background:#fff}.ph-row{border:1px solid #e2e6eb;border-radius:12px;margin:9px 0;padding:12px;font-size:13px;overflow-wrap:anywhere}.ph-row small,.ph-time{display:block;color:#6b7280;font-size:11px;margin:4px 0}.ph-row summary{margin-top:8px;cursor:pointer;font-size:12px}.ph-change{border-top:1px solid #eee;padding:8px 0;font-size:12px}.ph-change div{white-space:pre-wrap}.ph-change del{color:#8c4c4c}.ph-change strong{color:#14754b}.ph-note{color:#6b7280;font-size:12px;line-height:1.4}.pack-toolbar{display:flex;flex-wrap:wrap;gap:7px}';document.head.append(style)}
function shell(productId){installStyle();view={productId:productId||'',before:'',busy:false};seq++;showSheet(`<h3>${productId?'История товара':'История изменений товаров'}</h3><p id="phNotice" class="ph-note">Загрузка журнала…</p><div class="ph-controls"><input id="phQuery" type="search" placeholder="Название товара"><select id="phAction" aria-label="Действие"><option value="">Все действия</option>${Object.entries(actions).map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}</select></div><button id="phRefresh" type="button" class="btn">Показать</button><div id="phRows"></div><button id="phMore" type="button" class="btn full" hidden>Ещё</button>`);document.getElementById('phRefresh').onclick=()=>load(false);document.getElementById('phMore').onclick=()=>load(true);document.getElementById('phAction').onchange=()=>load(false);document.getElementById('phQuery').onkeydown=event=>{if(event.key==='Enter')load(false)};load(false)}
async function load(more){if(!view)return;const current=view,request=++seq,rows=document.getElementById('phRows'),notice=document.getElementById('phNotice'),button=document.getElementById('phMore');if(!rows||!notice||!button)return;button.disabled=true;
 if(!more){current.before='';current.filters={q:document.getElementById('phQuery').value.trim(),action:document.getElementById('phAction').value};rows.innerHTML='<p class="ph-note">Загрузка…</p>'}
 const params=new URLSearchParams({...current.filters,...(current.productId?{productId:current.productId}:{}),...(more&&current.before?{before:current.before}:{})});
 try{const out=await apiJson(MILLIONER_API+'/api/product-history?'+params);if(request!==seq||view!==current||document.getElementById('phRows')!==rows)return;if(!out.ok)throw Error(out.error||'Не удалось получить историю');const body=out.rows.filter(row=>row.entity==='product'&&row.action!=='baseline').map(rowHtml).join('');if(more)rows.insertAdjacentHTML('beforeend',body);else rows.innerHTML=body||'<p class="ph-note">Записей по этим условиям нет.</p>';notice.textContent='Создание, удаление и редактирование карточек товаров.';current.before=out.nextCursor||'';button.hidden=!current.before}
 catch(error){if(request===seq&&view===current&&document.getElementById('phRows')===rows){notice.textContent='Не удалось загрузить: '+String(error.message||error);if(!more)rows.innerHTML='<p class="ph-note">Нажмите «Показать», чтобы повторить.</p>'}}
 finally{if(request===seq)button.disabled=false}
}
window.openProductHistory=productId=>shell(productId);
document.addEventListener('click',event=>{const button=event.target?.closest?.('[data-product-history]');if(button){event.preventDefault();shell(button.dataset.productHistory)}});
})();
