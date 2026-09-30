(function(){
'use strict';

const PRICE_UI_KEY=(typeof KEY==='string'?KEY:'sklad_mvp_v2')+'_prices_ui_v1';
const PRICE_MARKETS=['Kaspi','WB','WB2','Ozon'];
const PRICE_CLIENT_TTL_MS=2*60*1000;
let priceUi={market:'Kaspi',q:'',sort:'asc',hidden:{},groupFilter:'all',groupId:''};
let priceExpanded=null;
const priceSelected={WB:new Set(),WB2:new Set()};
try{
  const saved=JSON.parse(localStorage.getItem(PRICE_UI_KEY)||'{}')||{};
  if(PRICE_MARKETS.includes(saved.market))priceUi.market=saved.market;
  priceUi.q=String(saved.q||'');
  if(saved.sort==='desc'||saved.sort==='asc')priceUi.sort=saved.sort;
  if(saved.hidden&&typeof saved.hidden==='object')priceUi.hidden=saved.hidden;
  if(['all','grouped','ungrouped'].includes(saved.groupFilter))priceUi.groupFilter=saved.groupFilter;
  priceUi.groupId=String(saved.groupId||'');
}catch{}
const priceCache=new Map();
const priceFetchInFlight=new Map();
const priceErrors=new Map();
const priceCooldowns=new Map();
const priceEpoch=new Map();
let priceLoadSeq=0;

function rememberPriceUi(){
  try{localStorage.setItem(PRICE_UI_KEY,JSON.stringify(priceUi))}catch{}
}
function pEsc(value){
  return String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[ch]));
}
function pNum(value){
  const n=Number(value);return Number.isFinite(n)?n:0;
}
function pMoney(value,currency='KZT'){
  const n=pNum(value);if(!(n>0))return '—';
  const code=String(currency||'').toUpperCase();
  const suffix=code==='KZT'?' ₸':code==='RUB'?' ₽':code?' '+code:'';
  return n.toLocaleString('ru-RU',{maximumFractionDigits:2})+suffix;
}
function pRange(min,max,currency){
  const a=pNum(min),b=pNum(max);
  if(!(a>0))return '—';
  return b>a?pMoney(a,currency)+' – '+pMoney(b,currency):pMoney(a,currency);
}
function marketLabel(market){
  return market==='WB'?'WB 1':market==='WB2'?'WB 2':market;
}
function activeSnapshot(){
  return priceCache.get(priceUi.market)||null;
}
function activeRows(){
  return Array.isArray(activeSnapshot()?.rows)?activeSnapshot().rows:[];
}
function priceHiddenKeys(market=priceUi.market){
  const rows=priceUi.hidden?.[market];return Array.isArray(rows)?rows.map(String):[];
}
function priceRowKey(row){
  if(!row)return'';
  const market=String(row.market||priceUi.market||'');
  if(market==='WB'||market==='WB2')return market+'|nm:'+String(row.remoteId||row.nmID||row.sku||row.name||'');
  if(market==='Ozon')return market+'|'+String(row.accountId||row.account||'')+'|'+String(row.sku||row.remoteId||row.productId||row.name||'');
  return market+'|'+String(row.productId||row.sku||row.remoteId||row.name||'');
}
function priceIsHidden(row,market=priceUi.market){
  const key=priceRowKey(row);return Boolean(key&&priceHiddenKeys(market).includes(key));
}
function priceRememberHidden(market,keys){
  priceUi.hidden={...(priceUi.hidden||{}),[market]:[...new Set((keys||[]).map(String).filter(Boolean))]};rememberPriceUi();
}
function priceSelection(market=priceUi.market){
  return priceSelected[market]||new Set();
}
function priceIsWbMarket(market=priceUi.market){
  return market==='WB'||market==='WB2';
}
function priceMatchesGroup(row){
  if(!priceIsWbMarket(row?.market))return true;
  if(priceUi.groupId)return String(row?.groupImtId||'')===String(priceUi.groupId);
  if(priceUi.groupFilter==='grouped')return Boolean(row?.grouped);
  if(priceUi.groupFilter==='ungrouped')return !row?.grouped;
  return true;
}
function priceVisibleRows(){
  const q=priceUi.q.trim().toLocaleLowerCase('ru-RU');
  return activeRows().map((row,index)=>({row,index})).filter(({row})=>{
    if(row?.error||priceIsHidden(row)||!priceMatchesGroup(row))return false;
    if(!q)return true;
    return [row.name,row.sku,row.remoteId,row.account].some(value=>String(value||'').toLocaleLowerCase('ru-RU').includes(q));
  });
}
function updatePriceGroupTools(){
  const tools=document.getElementById('priceGroupTools'),filter=document.getElementById('priceGroupFilter'),select=document.getElementById('priceGroupSelect'),
    merge=document.getElementById('priceGroupMerge'),detach=document.getElementById('priceGroupDetach');
  const isWb=priceIsWbMarket(),selection=priceSelection();
  if(tools)tools.hidden=!isWb;if(!isWb)return;
  if(filter)filter.value=priceUi.groupFilter||'all';
  if(select){
    const groups=new Map();
    for(const row of activeRows())if(row?.grouped&&row?.groupImtId&&!groups.has(String(row.groupImtId)))groups.set(String(row.groupImtId),row);
    const options=['<option value="">Все группы</option>',...[...groups.entries()].sort((a,b)=>String(a[1]?.name||'').localeCompare(String(b[1]?.name||''),'ru')).map(([id,row])=>'<option value="'+pEsc(id)+'">Группа '+pEsc(id)+' · '+Number(row.groupSize||0)+'</option>')];
    select.innerHTML=options.join('');select.value=priceUi.groupId||'';
  }
  if(merge)merge.disabled=!selection.size;
  if(detach)detach.disabled=!selection.size;
}
function updatePriceBulkTools(indexed=priceVisibleRows()){
  const tools=document.getElementById('priceBulkTools'),all=document.getElementById('priceSelectAll'),count=document.getElementById('priceSelectedCount'),
    enable=document.getElementById('priceBulkEnablePromo'),disable=document.getElementById('priceBulkDisablePromo'),night=document.getElementById('priceBulkNight'),
    protection=document.getElementById('priceBulkProtection');
  const isWb=priceIsWbMarket(),selection=priceSelection(),visibleIds=indexed.map(({row})=>String(row.remoteId||'')).filter(Boolean),
    selectedVisible=visibleIds.filter(id=>selection.has(id)).length;
  if(tools)tools.hidden=!isWb;
  if(all){
    all.checked=Boolean(visibleIds.length)&&selectedVisible===visibleIds.length;
    all.indeterminate=selectedVisible>0&&selectedVisible<visibleIds.length;
  }
  if(count)count.textContent=selection.size?'Выбрано '+selection.size:'';
  if(enable)enable.disabled=!selection.size;
  if(disable)disable.disabled=!selection.size;
  if(night)night.disabled=!selection.size;
  if(protection)protection.disabled=!selection.size;
  updatePriceGroupTools();
}

function priceHideAction(index){
  return '<button type="button" class="btn full price-hide-action" onclick="hidePriceRow('+Number(index)+')">Скрыть из списка</button>';
}
function priceSnapshotFresh(data){
  const when=Number(data?.fetchedAt)||0;
  return Boolean(data&&!data.stale&&when>0&&Date.now()-when<PRICE_CLIENT_TTL_MS);
}
function priceEpochValue(market){
  return Number(priceEpoch.get(market)||0);
}
function bumpPriceEpoch(market){
  priceEpoch.set(market,priceEpochValue(market)+1);
}
function priceSortValue(row){
  const price=pNum(row?.price);if(price>0)return price;
  const final=pNum(row?.finalPrice);return final>0?final:NaN;
}
function priceDiscountValue(row){
  if(Number.isFinite(Number(row?.discount)))return Math.max(0,Number(row.discount)||0);
  const old=pNum(row?.oldPrice),current=pNum(row?.finalPrice||row?.price);
  return old>current&&current>0?Math.round((1-current/old)*100):0;
}
function setPriceStatus(text,kind=''){
  const el=document.getElementById('priceStatus');if(!el)return;
  el.textContent=text||'';
  el.className='price-status'+(kind?' '+kind:'');
}
function setPriceTabs(){
  document.querySelectorAll('[data-price-market]').forEach(button=>{
    button.classList.toggle('active',button.dataset.priceMarket===priceUi.market);
  });
  const q=document.getElementById('priceSearch');
  if(q&&q.value!==priceUi.q)q.value=priceUi.q;
  const sort=document.getElementById('priceSortButton');
  if(sort){const desc=priceUi.sort==='desc';sort.textContent=desc?'Цена ↓':'Цена ↑';sort.setAttribute('aria-label',desc?'Сортировка по цене: сначала дорогие':'Сортировка по цене: сначала дешёвые');sort.title=desc?'Сначала дорогие':'Сначала дешёвые';}
  const hidden=document.getElementById('priceHiddenButton'),hiddenTools=document.getElementById('priceHiddenTools'),hiddenCount=priceHiddenKeys().length;
  if(hiddenTools)hiddenTools.hidden=!hiddenCount;
  if(hidden){hidden.hidden=!hiddenCount;hidden.textContent='Скрытые · '+hiddenCount;hidden.setAttribute('aria-label','Показать скрытые товары: '+hiddenCount);}
  updatePriceBulkTools();
}
function priceRetryLabel(retryAt){
  const ts=Number(retryAt)||0;
  return ts>Date.now()?new Date(ts).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'}):'через несколько секунд';
}
function priceTimeLabel(value){
  const ts=Number(value)||0;return ts>0?new Date(ts).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'}):'';
}
function wbServerStatus(data){
  const next=priceTimeLabel(data?.nextSyncAt),stamp=priceTimeLabel(data?.fetchedAt);
  const pending=Math.max(0,Number(data?.pendingCount)||0),sent=Math.max(0,Number(data?.sentCount)||0),queued=pending+sent;
  if(data?.waiting){
    return 'Ждём первый серверный сеанс с WB'+(next?' · следующая попытка '+next:'');
  }
  let text='Данные WB на '+(stamp||'—');
  if(queued)text+=' · изменений в очереди: '+queued;
  if(next)text+=' · следующий сеанс '+next;
  if(data?.syncError)text+=' · последняя связь с WB не удалась';
  return text;
}
function priceErrorText(error){
  const text=String(error?.message||error||'Не удалось загрузить цены');
  if((priceUi.market==='WB'||priceUi.market==='WB2')&&Number(error?.status)===429){
    return 'WB временно ограничил обновление цен. Следующая попытка '+priceRetryLabel(error?.retryAt)+'.';
  }
  if((priceUi.market==='WB'||priceUi.market==='WB2')&&/403|доступ|forbidden/i.test(text)){
    return 'Токен '+marketLabel(priceUi.market)+' не имеет доступа к категории «Цены и скидки» WB. Добавьте это право у API-ключа и обновите.';
  }
  return text;
}
function priceSetSummary(value='—'){
  for(const id of ['pricePositionCount','priceDiscountCount','priceMissingCount']){
    const el=document.getElementById(id);if(el)el.textContent=value;
  }
}
function priceRenderError(message){
  priceSetSummary('—');
  const list=document.getElementById('priceList');if(!list)return;
  list.innerHTML='<div class="empty">'+pEsc(message)+'</div><button type="button" class="btn full" onclick="priceRefresh()">Повторить</button>';
}
function priceInlineEditor(row,index){
  if(!priceExpanded||priceExpanded.market!==priceUi.market||priceExpanded.index!==Number(index))return '';
  if(row.market==='Kaspi'){
    return '<div class="price-inline-editor" onclick="event.stopPropagation()">'+
      '<div class="price-inline-fields one"><div class="field"><label>Цена, ₸</label><input id="priceEditCurrent" type="number" min="1" step="1" inputmode="decimal" value="'+pEsc(pNum(row.price)||'')+'"></div></div>'+
      '<div class="price-inline-actions"><button type="button" class="btn dark" onclick="submitPriceEdit('+Number(index)+')">Сохранить</button><button type="button" class="btn price-hide-action" onclick="hidePriceRow('+Number(index)+')">Скрыть</button></div>'+
      '</div>';
  }
  if(row.market==='WB'||row.market==='WB2'){
    const priceDisabled=row.canEditPrice===false;
    return '<div class="price-inline-editor" onclick="event.stopPropagation()">'+
      '<div class="price-inline-fields"><div class="field"><label>Цена, '+pEsc(row.currency||'RUB')+'</label><input id="priceEditCurrent" type="number" min="1" step="1" inputmode="decimal" value="'+pEsc(pNum(row.price)||'')+'" '+(priceDisabled?'disabled':'')+'></div>'+
      '<div class="field"><label>Скидка, %</label><input id="priceEditDiscount" type="number" min="0" max="99" step="1" inputmode="numeric" value="'+pEsc(Math.round(pNum(row.discount)))+'"></div></div>'+
      (priceDisabled?'<div class="price-inline-warning">Разные цены по размерам · меняется только скидка</div>':'')+
      '<div class="price-protection-grid">'+
        '<label class="price-protection-toggle"><input type="checkbox" '+(row.manualPriceLock?'checked':'')+' onchange="togglePriceProtection('+Number(index)+',\'manualPriceLock\',this.checked)"> <span><b>Зафиксировать цену продавца</b><br><span class="muted">Блокирует наши автоматические изменения цены и скидки.</span></span></label>'+
        '<label class="price-protection-toggle"><input type="checkbox" '+(row.promoBlocked?'checked':'')+' onchange="togglePriceProtection('+Number(index)+',\'promoBlock\',this.checked)"> <span><b>Не участвовать в акциях</b><br><span class="muted">Блокирует добавление через Milioner. Автоакции WB API запретить не умеет.</span></span></label>'+
        '<label class="price-protection-toggle"><input type="checkbox" '+(row.autoZeroEnabled?'checked':'')+' onchange="togglePriceProtection('+Number(index)+',\'autoZeroEnabled\',this.checked)"> <span><b>Защита при нулевом моём остатке</b><br><span class="muted">Включается только при подтверждённом доступном остатке 0.</span></span></label>'+
      '</div>'+
      '<div class="price-inline-actions wb"><label class="price-promo-toggle"><input type="checkbox" '+(row.promoEnabled?'checked':'')+' onchange="togglePricePromo('+Number(index)+',this.checked)">Акции</label><button type="button" class="btn dark" onclick="submitPriceEdit('+Number(index)+')">Сохранить</button><button type="button" class="btn price-hide-action" onclick="hidePriceRow('+Number(index)+')">Скрыть</button></div>'+
      '</div>';
  }
  if(row.market==='Ozon'){
    return '<div class="price-inline-editor" onclick="event.stopPropagation()">'+
      '<div class="price-inline-fields"><div class="field"><label>Цена, '+pEsc(row.currency||'RUB')+'</label><input id="priceEditCurrent" type="number" min="1" step="1" inputmode="decimal" value="'+pEsc(pNum(row.price)||'')+'"></div>'+
      '<div class="field"><label>До скидки</label><input id="priceEditOld" type="number" min="0" step="1" inputmode="decimal" value="'+pEsc(pNum(row.oldPrice)||'')+'"></div></div>'+
      '<div class="price-inline-actions"><button type="button" class="btn dark" onclick="submitPriceEdit('+Number(index)+')">Сохранить</button><button type="button" class="btn price-hide-action" onclick="hidePriceRow('+Number(index)+')">Скрыть</button></div>'+
      '</div>';
  }
  return '';
}
function priceCard(row,index){
  if(row?.error){
    return '<div class="item price-item price-item-error"><div class="name">'+pEsc(row.account||'Ozon')+'</div><div class="muted price-error">'+pEsc(row.error)+'</div></div>';
  }
  const discount=priceDiscountValue(row),linked=row.linked!==false;
  const account=row.account&&row.account!==marketLabel(row.market)?'<span>'+pEsc(row.account)+'</span>':'';
  let lines='';
  if(row.market==='WB'||row.market==='WB2'){
    lines='<span>Цена: <b>'+pRange(row.price,row.priceMax,row.currency)+'</b></span>'+
      '<span>Скидка: <b>'+(discount?discount+'%':'0%')+'</b></span>'+
      '<span>После скидки: <b>'+pRange(row.finalPrice,row.finalPriceMax,row.currency)+'</b></span>'+
      (pNum(row.clubFinalPrice)>0?'<span>WB Клуб: <b>'+pMoney(row.clubFinalPrice,row.currency)+'</b></span>':'')+
      '<span class="price-stock-line">Мой склад: <b>'+(row.ownStockKnown?Number(row.ownAvailable||0):'—')+'</b></span>'+
      '<span class="price-stock-line">WB: <b>'+(row.wbStockKnown?Number(row.wbAvailable||0):'—')+'</b></span>';
  }else if(row.market==='Ozon'){
    lines='<span>Цена: <b>'+pMoney(row.price,row.currency)+'</b></span>'+
      '<span>Скидка: <b>'+(discount?discount+'%':'0%')+'</b></span>'+
      '<span>Со скидкой: <b>'+pMoney(row.finalPrice||row.price,row.currency)+'</b></span>'+
      (pNum(row.oldPrice)>0?'<span>Старая цена: <b>'+pMoney(row.oldPrice,row.currency)+'</b></span>':'');
  }else{
    lines='<span>Цена: <b>'+pMoney(row.price,row.currency)+'</b></span>'+
      '<span>Скидка: <b>—</b></span>';
  }
  const sync=row.syncState==='pending'
    ?'<div class="price-sync-state pending">Ожидает отправки в WB</div>'
    :row.syncState==='sent'
      ?'<div class="price-sync-state sent">Отправлено в WB · ждём проверки</div>'
      :'';
  const promo=row.market==='WB'||row.market==='WB2'
    ?'<span class="price-promo-badge '+(row.promoEnabled&&row.promoStatus==='participating'?'active':row.promoEnabled?'waiting':'off')+'"> · '+(
      row.promoEnabled&&row.promoStatus==='participating'?'В акции':
      row.promoEnabled&&row.promoStatus==='auto_only'?'Автоакции вручную':
      row.promoEnabled?'Ждёт акцию':'Без акции')+'</span>'
    :'';
  const night=(row.market==='WB'||row.market==='WB2')&&row.nightPriceEnabled
    ?'<span class="price-night-badge"> · 🌙 '+pEsc(row.nightPriceStart||'04:00')+'–'+pEsc(row.nightPriceEnd||'06:00')+' · '+pMoney(row.nightPriceTarget,row.currency)+'</span>'
    :'';
  const protection=row.priceProtected?'<span class="price-lock-badge"> · 🔒 '+pEsc(row.protectionReason||'Защита цены')+'</span>':'';
  const group=priceIsWbMarket(row.market)?'<span> · '+(row.grouped?('Группа '+pEsc(row.groupImtId)+' · '+Number(row.groupSize||0)):'Без группы')+'</span>':'';
  const expanded=Boolean(priceExpanded&&priceExpanded.market===priceUi.market&&priceExpanded.index===Number(index));
  const selected=priceIsWbMarket(row.market)&&priceSelection(row.market).has(String(row.remoteId||''));
  const selectBox=priceIsWbMarket(row.market)?'<label class="price-row-select" onclick="event.stopPropagation()"><input type="checkbox" '+(selected?'checked':'')+' onchange="priceSelectRow('+Number(index)+',this.checked)" aria-label="Выбрать товар"></label>':'';
  return '<div class="item price-item '+(!linked?'unlinked':'')+(expanded?' expanded':'')+(selected?' selected':'')+'" data-price-row="'+index+'">'+selectBox+
    '<button type="button" class="price-card-toggle" onclick="openPriceEditor('+index+')" aria-expanded="'+(expanded?'true':'false')+'">'+
      '<div class="price-item-head"><div class="grow"><div class="name">'+pEsc(row.name||row.sku||'Товар')+'</div>'+
      '<div class="muted">'+pEsc(account?(row.account+' · '):'')+pEsc(row.sku?('Арт. '+row.sku):row.remoteId||'')+(linked?'':' · не привязан к товару склада')+group+promo+night+protection+'</div>'+sync+'</div><span class="price-chevron">'+(expanded?'⌄':'›')+'</span></div>'+
      '<div class="price-values">'+lines+'</div>'+
    '</button>'+priceInlineEditor(row,index)+'</div>';
}
function paintPrices(){
  setPriceTabs();
  const rows=activeRows(),visibleRows=rows.filter(row=>!priceIsHidden(row)&&priceMatchesGroup(row)),q=priceUi.q.trim().toLocaleLowerCase('ru-RU');
  const indexed=rows.map((row,index)=>({row,index})).filter(({row})=>{
    if(priceIsHidden(row)||!priceMatchesGroup(row))return false;
    if(!q)return true;
    return [row.name,row.sku,row.remoteId,row.account].some(value=>String(value||'').toLocaleLowerCase('ru-RU').includes(q));
  }).sort((a,b)=>{
    const av=priceSortValue(a.row),bv=priceSortValue(b.row),aMissing=!(av>0),bMissing=!(bv>0);
    if(aMissing!==bMissing)return aMissing?1:-1;
    if(!aMissing&&Math.abs(av-bv)>.000001)return priceUi.sort==='desc'?bv-av:av-bv;
    const byName=String(a.row?.name||a.row?.sku||'').localeCompare(String(b.row?.name||b.row?.sku||''),'ru',{sensitivity:'base'});
    return byName||a.index-b.index;
  });
  const valid=visibleRows.filter(row=>!row.error),withDiscount=valid.filter(row=>priceDiscountValue(row)>0).length,noPrice=valid.filter(row=>!(pNum(row.price)>0||pNum(row.finalPrice)>0)).length;
  const count=document.getElementById('pricePositionCount'),discount=document.getElementById('priceDiscountCount'),missing=document.getElementById('priceMissingCount');
  if(count)count.textContent=valid.length.toLocaleString('ru-RU');
  if(discount)discount.textContent=withDiscount.toLocaleString('ru-RU');
  if(missing)missing.textContent=noPrice.toLocaleString('ru-RU');
  const list=document.getElementById('priceList');if(!list)return;
  if(!rows.length){
    const failure=priceErrors.get(priceUi.market),snapshot=activeSnapshot();
    if(failure){priceRenderError(failure.message);return;}
    if(snapshot?.serverSnapshot&&snapshot?.waiting){
      list.innerHTML='<div class="empty">Цены WB ещё не загружены сервером.<br><span class="muted">Склад получит их в ближайший разрешённый сеанс связи.</span></div>';return;
    }
    list.innerHTML='<div class="empty">Нет позиций для этого магазина</div>';return;
  }
  if(!visibleRows.length&&rows.length){
    if(priceIsWbMarket()&&(priceUi.groupId||priceUi.groupFilter!=='all')){
      list.innerHTML='<div class="empty">По выбранной группе или фильтру товаров нет.</div>';
    }else{
      list.innerHTML='<div class="empty">Все позиции этого магазина скрыты.<br><span class="muted">Вернуть их можно через «Скрытые».</span></div>';
    }
    return;
  }
  if(!indexed.length){updatePriceBulkTools(indexed);list.innerHTML='<div class="empty">Поиск ничего не нашёл</div>';return;}
  updatePriceBulkTools(indexed);
  list.innerHTML=indexed.map(({row,index})=>priceCard(row,index)).join('');
}

async function priceFetch(market,force=false){
  const epoch=priceEpochValue(market),key=market+':'+epoch;
  const running=priceFetchInFlight.get(key);if(running)return running;
  const task=(async()=>{
    const remoteForce=force&&market!=='WB'&&market!=='WB2';
    const url=MILLIONER_API+'/api/market-prices?market='+encodeURIComponent(market)+(remoteForce?'&force=1':'');
    const response=await fetch(url,{cache:'no-store'});
    const text=await response.text();
    let data=null;
    if(text){try{data=JSON.parse(text)}catch{const e=new Error('Сервер цен вернул некорректный ответ');e.status=502;throw e}}
    if(!response.ok||data?.ok===false){
      const error=new Error(data?.error||('HTTP '+response.status));
      error.status=response.status;error.retryAt=Number(data?.retryAt)||0;throw error;
    }
    if(!data||typeof data!=='object'){const e=new Error('Сервер цен вернул пустой ответ');e.status=502;throw e}
    return {data,epoch};
  })();
  priceFetchInFlight.set(key,task);
  try{return await task}finally{if(priceFetchInFlight.get(key)===task)priceFetchInFlight.delete(key)}
}

window.renderPrices=async function(force=false){
  const view=document.getElementById('prices');if(!view||!view.classList.contains('active'))return;
  setPriceTabs();
  const market=priceUi.market,seq=++priceLoadSeq,existing=priceCache.get(market);
  if(existing&&!force&&priceSnapshotFresh(existing)){
    priceErrors.delete(market);paintPrices();
    if(existing.serverSnapshot)setPriceStatus(wbServerStatus(existing),existing.syncError?'warn':'ok');
    else setPriceStatus('Обновлено '+new Date(existing.fetchedAt||Date.now()).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'}),'ok');
    return;
  }
  const managedWb=market==='WB'||market==='WB2';
  const cooldown=managedWb?0:Number(priceCooldowns.get(market)||0);
  if(cooldown>Date.now()){
    const message='WB временно ограничил обновление цен. Следующая попытка '+priceRetryLabel(cooldown)+'.';
    priceErrors.set(market,{message,retryAt:cooldown});
    if(existing){paintPrices();setPriceStatus(message+' Показаны последние данные.','warn')}
    else{setPriceStatus(message,'bad');priceRenderError(message)}
    return;
  }
  const list=document.getElementById('priceList');
  if(existing)paintPrices();
  else{priceSetSummary('—');if(list)list.innerHTML='<div class="empty">Загружаю цены…</div>'}
  setPriceStatus(existing?'Проверяю обновление…':'обновляю…','loading');
  try{
    const loaded=await priceFetch(market,force);
    if(seq!==priceLoadSeq||market!==priceUi.market||loaded.epoch!==priceEpochValue(market))return;
    const data=loaded.data;
    priceCache.set(market,data);
    priceErrors.delete(market);
    if(Number(data.retryAt)>Date.now())priceCooldowns.set(market,Number(data.retryAt));else priceCooldowns.delete(market);
    paintPrices();
    if(data.serverSnapshot){
      setPriceStatus(wbServerStatus(data),data.syncError?'warn':data.waiting?'loading':'ok');
    }else{
      const when=Number(data.fetchedAt||Date.now()),stamp=new Date(when).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'});
      if(data.stale){
        const message='Не удалось обновить. Показаны данные на '+stamp+(Number(data.retryAt)>Date.now()?'. Следующая попытка '+priceRetryLabel(data.retryAt):'.');
        setPriceStatus(message,'warn');
      }else setPriceStatus('Обновлено '+stamp,'ok');
    }
  }catch(error){
    if(seq!==priceLoadSeq||market!==priceUi.market)return;
    if(Number(error?.retryAt)>Date.now())priceCooldowns.set(market,Number(error.retryAt));
    const message=priceErrorText(error);
    priceErrors.set(market,{message,retryAt:Number(error?.retryAt)||0});
    if(existing){paintPrices();setPriceStatus(message+' Показаны последние данные.','warn')}
    else{setPriceStatus(message,'bad');priceRenderError(message)}
  }
};

window.priceSetMarket=function(market){
  if(!PRICE_MARKETS.includes(market)||market===priceUi.market)return;
  if(priceIsWbMarket(priceUi.market))priceSelection(priceUi.market).clear();
  if(priceIsWbMarket(market))priceSelection(market).clear();
  priceExpanded=null;priceUi.market=market;priceUi.groupFilter='all';priceUi.groupId='';rememberPriceUi();setPriceTabs();window.renderPrices(false);
};
window.priceSetGroupFilter=function(value){
  priceUi.groupFilter=['grouped','ungrouped'].includes(value)?value:'all';priceUi.groupId='';rememberPriceUi();paintPrices();
};
window.priceSetGroup=function(value){
  priceUi.groupId=String(value||'');if(priceUi.groupId)priceUi.groupFilter='all';rememberPriceUi();paintPrices();
};
window.priceSearch=function(value){
  priceUi.q=String(value||'');rememberPriceUi();paintPrices();
};
window.priceToggleSort=function(){
  priceUi.sort=priceUi.sort==='desc'?'asc':'desc';rememberPriceUi();setPriceTabs();paintPrices();
};
window.priceSelectRow=function(index,checked){
  const row=activeRows()[Number(index)];if(!row||!priceIsWbMarket(row.market))return;
  const set=priceSelection(row.market),id=String(row.remoteId||'');if(!id)return;
  if(checked)set.add(id);else set.delete(id);
  paintPrices();
};
window.priceSelectAllVisible=function(checked){
  if(!priceIsWbMarket())return;
  const set=priceSelection();
  for(const {row} of priceVisibleRows()){
    const id=String(row.remoteId||'');if(!id)continue;
    if(checked)set.add(id);else set.delete(id);
  }
  paintPrices();
};

async function remotePriceProtection(body){
  const response=await fetch(MILLIONER_API+'/api/market-prices/protection',{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,confirm:true})
  });
  const text=await response.text();let data=null;
  if(text){try{data=JSON.parse(text)}catch{throw new Error('Сервер защиты цены вернул некорректный ответ')}}
  if(!response.ok||data?.ok===false){const error=new Error(data?.error||('HTTP '+response.status));error.status=response.status;throw error}
  return data;
}
window.togglePriceProtection=async function(index,field,enabled){
  const row=activeRows()[Number(index)];if(!row||!priceIsWbMarket(row.market))return;
  const body={market:row.market,remoteId:row.remoteId};body[field]=Boolean(enabled);
  try{
    await remotePriceProtection(body);
    bumpPriceEpoch(row.market);
    await window.renderPrices(true);
    setPriceStatus(enabled?'Защита включена':'Настройка защиты выключена','ok');
  }catch(error){paintPrices();alert(priceErrorText(error))}
};
window.openPriceBulkProtection=function(){
  if(!priceIsWbMarket())return;
  const ids=[...priceSelection()].filter(Boolean);if(!ids.length)return;
  showSheet('<h3>Защита · '+ids.length+' товаров</h3>'+
    '<div class="muted">Ручной замок блокирует наши автоматические изменения цены и акции. Автозащита по остатку включается только при подтверждённом нуле нашего склада.</div>'+
    '<div class="price-protection-grid">'+
      '<button type="button" class="btn" onclick="applyPriceBulkProtection(\'manualPriceLock\',true)">🔒 Зафиксировать цену</button>'+
      '<button type="button" class="btn" onclick="applyPriceBulkProtection(\'manualPriceLock\',false)">Снять ручной замок</button>'+
      '<button type="button" class="btn" onclick="applyPriceBulkProtection(\'promoBlock\',true)">Не добавлять в акции</button>'+
      '<button type="button" class="btn" onclick="applyPriceBulkProtection(\'promoBlock\',false)">Разрешить акции сервиса</button>'+
      '<button type="button" class="btn" onclick="applyPriceBulkProtection(\'autoZeroEnabled\',true)">Автозащита при 0 · вкл</button>'+
      '<button type="button" class="btn" onclick="applyPriceBulkProtection(\'autoZeroEnabled\',false)">Автозащита при 0 · выкл</button>'+
    '</div><div class="price-inline-warning">Запрет акций действует на Milioner. Публичный API WB не даёт выключить автоакции WB или гарантированно удалить товар из уже действующей акции.</div>');
};
window.applyPriceBulkProtection=async function(field,enabled){
  if(!priceIsWbMarket())return;
  const ids=[...priceSelection()].filter(Boolean);if(!ids.length)return;
  const label=field==='manualPriceLock'?'ручную защиту цены':field==='promoBlock'?'запрет акций':'автозащиту при нулевом остатке';
  if(!confirm((enabled?'Включить ':'Выключить ')+label+' для '+ids.length+' товаров?'))return;
  const body={market:priceUi.market,remoteIds:ids};body[field]=Boolean(enabled);
  try{
    const result=await remotePriceProtection(body);
    priceSelection().clear();closeModal();bumpPriceEpoch(priceUi.market);await window.renderPrices(true);
    setPriceStatus('Изменено для '+Number(result.count||ids.length)+' товаров','ok');
  }catch(error){alert(priceErrorText(error))}
};
function selectedPriceRows(){
  const ids=priceSelection();return activeRows().filter(row=>ids.has(String(row.remoteId||'')));
}
function groupPreviewRow(row){
  const image=row?.groupPhoto?'<img src="'+pEsc(row.groupPhoto)+'" alt="">':'<span class="thumb"></span>';
  const group=row?.grouped?('Группа '+String(row.groupImtId||'')+' · '+Number(row.groupSize||0)):'Без группы';
  return '<div class="price-group-preview-row">'+image+'<div><b>'+pEsc(row?.name||row?.sku||('WB '+row?.remoteId))+'</b><span>Арт. '+pEsc(row?.sku||row?.remoteId||'')+' · '+pEsc(group)+'</span></div></div>';
}
function sameSelectedSubject(rows){
  const subjects=new Set(rows.map(row=>String(row?.groupSubjectId||'')).filter(Boolean));return subjects.size<=1;
}
async function remoteGroupMove(body){
  const response=await fetch(MILLIONER_API+'/api/market-prices/card-groups/move',{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,confirm:true})
  });
  const text=await response.text();let data=null;
  if(text){try{data=JSON.parse(text)}catch{throw new Error('Сервер групп WB вернул некорректный ответ')}}
  if(!response.ok||data?.ok===false){
    const error=new Error(data?.error||('HTTP '+response.status));
    error.status=response.status;error.retryAt=Number(data?.retryAt)||0;error.data=data;throw error;
  }
  return data;
}
async function remoteGroupRecheck(remoteIds=[]){
  const response=await fetch(MILLIONER_API+'/api/market-prices/card-groups/recheck',{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({market:priceUi.market,remoteIds})
  });
  const text=await response.text();let data=null;
  if(text){try{data=JSON.parse(text)}catch{throw new Error('Сервер проверки групп WB вернул некорректный ответ')}}
  if(!response.ok||data?.ok===false){
    const error=new Error(data?.error||('HTTP '+response.status));
    error.status=response.status;error.retryAt=Number(data?.retryAt)||0;throw error;
  }
  return data;
}
let priceGroupRecheckIds=[];
function priceGroupErrorText(error){
  const text=String(error?.message||error||'Не удалось проверить группы WB');
  if(Number(error?.status)===429)return 'WB временно ограничил Content API. Повторная проверка '+priceRetryLabel(error?.retryAt)+'.';
  return text;
}
function showPriceGroupFailure(error,ids=[]){
  priceGroupRecheckIds=[...new Set((ids||[]).map(String).filter(Boolean))];
  const retry=Number(error?.retryAt)>Date.now()?'<div class="price-inline-warning">Повторная проверка доступна после '+pEsc(priceRetryLabel(error.retryAt))+'.</div>':'';
  showSheet('<h3>Группа WB не подтверждена</h3><div class="muted">'+pEsc(priceGroupErrorText(error))+'</div>'+retry+
    '<button type="button" class="btn dark full" onclick="recheckPriceGroups()">Повторно проверить в WB</button>');
}
window.recheckPriceGroups=async function(){
  if(!priceIsWbMarket())return;
  try{
    const data=await remoteGroupRecheck(priceGroupRecheckIds);
    const cached=priceCache.get(priceUi.market);
    if(cached){
      cached.cardGroups=Array.isArray(data.cards)?data.cards:[];
      cached.cardGroupsFetchedAt=Number(data.fetchedAt)||Date.now();
    }
    closeModal();bumpPriceEpoch(priceUi.market);await window.renderPrices(true);
    setPriceStatus('Группы повторно проверены по фактическим данным WB','ok');
  }catch(error){
    showPriceGroupFailure(error,priceGroupRecheckIds);
  }
};
window.openPriceGroupMerge=function(){
  if(!priceIsWbMarket())return;
  const selected=selectedPriceRows();if(!selected.length)return;
  if(!sameSelectedSubject(selected))return alert('WB разрешает объединять только карточки одного предмета.');
  const subject=String(selected[0]?.groupSubjectId||'');
  const candidates=new Map();
  for(const row of activeRows()){
    if(subject&&String(row?.groupSubjectId||'')!==subject)continue;
    const id=String(row?.groupImtId||'');if(id&&!candidates.has(id))candidates.set(id,row);
  }
  if(!candidates.size){
    priceGroupRecheckIds=selected.map(row=>String(row.remoteId||'')).filter(Boolean);
    return showSheet('<h3>Группы WB ещё не загружены</h3><div class="muted">Можно запросить актуальный состав каталога WB вручную. Это не меняет карточки.</div><button type="button" class="btn dark full" onclick="recheckPriceGroups()">Проверить группы WB</button>');
  }
  const selectedImt=String(selected[0]?.groupImtId||''),defaultTarget=candidates.has(selectedImt)?selectedImt:[...candidates.keys()][0];
  const options=[...candidates.entries()].map(([id,row])=>'<option value="'+pEsc(id)+'" '+(id===defaultTarget?'selected':'')+'>Группа '+pEsc(id)+' · сейчас '+Number(row.groupSize||1)+'</option>').join('');
  showSheet('<h3>Объединить · '+selected.length+'</h3>'+
    '<div class="field"><label>Итоговая группа</label><select id="priceGroupTarget" onchange="refreshPriceGroupMergePreview()">'+options+'</select></div>'+
    '<div id="priceGroupMergePreview"></div>'+
    '<div class="actions"><button type="button" class="btn" onclick="closeModal()">Отмена</button><button type="button" class="btn dark" onclick="submitPriceGroupMerge()">Добавить / объединить</button></div>');
  refreshPriceGroupMergePreview();
};
window.refreshPriceGroupMergePreview=function(){
  const target=String(document.getElementById('priceGroupTarget')?.value||''),selected=selectedPriceRows(),selectedIds=new Set(selected.map(row=>String(row.remoteId||'')));
  const finalRows=[];for(const row of activeRows())if(String(row.groupImtId||'')===target||selectedIds.has(String(row.remoteId||'')))finalRows.push(row);
  const unique=[...new Map(finalRows.map(row=>[String(row.remoteId||''),row])).values()];
  const el=document.getElementById('priceGroupMergePreview');if(!el)return;
  el.innerHTML='<div class="muted">Итоговый состав: '+unique.length+' товаров. У каждого товара ниже указана его текущая группа, поэтому перенос из другой группы виден до подтверждения.</div><div class="price-group-preview">'+unique.map(groupPreviewRow).join('')+'</div>';
};
window.submitPriceGroupMerge=async function(){
  const rows=selectedPriceRows(),ids=rows.map(row=>String(row.remoteId||'')).filter(Boolean),targetImt=String(document.getElementById('priceGroupTarget')?.value||'');
  if(!ids.length||!targetImt)return;
  if(!confirm('Переместить '+ids.length+' карточек в выбранную группу WB?'))return;
  try{
    await remoteGroupMove({market:priceUi.market,remoteIds:ids,targetImt});
    priceSelection().clear();closeModal();bumpPriceEpoch(priceUi.market);await window.renderPrices(true);
    setPriceStatus('WB подтвердил фактический состав группы после проверки','ok');
  }catch(error){showPriceGroupFailure(error,ids)}
};
window.openPriceGroupDetach=function(){
  if(!priceIsWbMarket())return;
  const selected=selectedPriceRows();if(!selected.length)return;
  showSheet('<h3>Отсоединить · '+selected.length+'</h3><div class="price-group-preview">'+selected.map(groupPreviewRow).join('')+'</div>'+
    '<div class="muted">Если выбрать «каждый отдельно», Milioner отправит отдельный запрос для каждой карточки. Иначе WB может объединить выбранные карточки между собой в новую группу.</div>'+
    '<button type="button" class="btn full" onclick="submitPriceGroupDetach(false)">Отсоединить одной новой группой</button>'+
    '<button type="button" class="btn dark full" onclick="submitPriceGroupDetach(true)">Сделать каждый товар отдельным</button>');
};
window.submitPriceGroupDetach=async function(separateEach){
  const ids=selectedPriceRows().map(row=>String(row.remoteId||'')).filter(Boolean);if(!ids.length)return;
  if(!confirm(separateEach?'Сделать каждую выбранную карточку отдельной?':'Отсоединить выбранные карточки в новую группу?'))return;
  try{
    await remoteGroupMove({market:priceUi.market,remoteIds:ids,separateEach:Boolean(separateEach)});
    priceSelection().clear();closeModal();bumpPriceEpoch(priceUi.market);await window.renderPrices(true);
    setPriceStatus(separateEach?'Карточки разъединены и проверены':'Новая группа проверена по фактическим данным WB','ok');
  }catch(error){showPriceGroupFailure(error,ids)}
};
async function remotePromoBulk(remoteIds,enabled){
  const response=await fetch(MILLIONER_API+'/api/market-prices/promo/bulk',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({market:priceUi.market,remoteIds,enabled:Boolean(enabled),confirm:true})
  });
  const text=await response.text();
  let data=null;if(text){try{data=JSON.parse(text)}catch{throw new Error('Сервер акций вернул некорректный ответ')}}
  if(!response.ok||data?.ok===false)throw new Error(data?.error||('HTTP '+response.status));
  return data;
}
window.priceBulkPromo=async function(enabled){
  if(!priceIsWbMarket())return;
  const ids=[...priceSelection()].filter(Boolean);if(!ids.length)return;
  const action=enabled?'добавить в акции':'убрать из акций';
  if(!confirm((enabled?'Добавить в акции ':'Убрать из акций ')+ids.length+' товаров?'))return;
  const enableButton=document.getElementById('priceBulkEnablePromo'),disableButton=document.getElementById('priceBulkDisablePromo');
  if(enableButton)enableButton.disabled=true;if(disableButton)disableButton.disabled=true;
  try{
    const result=await remotePromoBulk(ids,enabled),applied=new Set((result.remoteIds||ids).map(String));
    for(const row of activeRows()){
      if(!applied.has(String(row.remoteId||'')))continue;
      row.promoEnabled=Boolean(enabled);
      if(enabled){
        if(row.promoStatus!=='participating')row.promoStatus='idle';
      }else if(row.promoStatus!=='participating'){
        row.promoStatus='off';row.promoName='';row.promoPlanPrice=null;row.promoPlanDiscount=null;
      }
    }
    priceSelection().clear();
    paintPrices();
    setPriceStatus((enabled?'Акции включены для ':'Акции выключены для ')+Number(result.count||applied.size)+' товаров','ok');
  }catch(error){
    alert(priceErrorText(error));updatePriceBulkTools();
  }
};
function priceMinuteTime(value){
  const minute=Math.max(0,Math.min(1439,Math.trunc(Number(value)||0)));
  return String(Math.floor(minute/60)).padStart(2,'0')+':'+String(minute%60).padStart(2,'0');
}
async function remoteNightSchedule(body){
  const response=await fetch(MILLIONER_API+'/api/market-prices/night-schedule',{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,confirm:true})
  });
  const text=await response.text();
  let data=null;if(text){try{data=JSON.parse(text)}catch{throw new Error('Сервер ночных цен вернул некорректный ответ')}}
  if(!response.ok||data?.ok===false)throw new Error(data?.error||('HTTP '+response.status));
  return data;
}
window.openPriceNightSchedule=function(){
  if(!priceIsWbMarket())return;
  const ids=[...priceSelection()].filter(Boolean);if(!ids.length)return;
  const selectedRows=activeRows().filter(row=>ids.includes(String(row.remoteId||'')));
  const configured=selectedRows.filter(row=>row.nightPriceEnabled);
  const first=configured[0]||selectedRows[0]||{};
  const start=String(first.nightPriceStart||'04:00'),end=String(first.nightPriceEnd||'06:00'),price=pNum(first.nightPriceTarget)||5000;
  const activeCount=configured.length;
  showSheet('<div class="price-night-sheet"><h3>Ночная цена · '+ids.length+'</h3>'+
    '<div class="two"><div class="field"><label>С</label><input id="priceNightStart" type="time" value="'+pEsc(start)+'"></div>'+
    '<div class="field"><label>До</label><input id="priceNightEnd" type="time" value="'+pEsc(end)+'"></div></div>'+
    '<div class="field"><label>Цена, ₽</label><input id="priceNightValue" type="number" min="1" step="1" inputmode="decimal" value="'+pEsc(price)+'"></div>'+
    '<div class="actions"><button type="button" class="btn" onclick="savePriceNightSchedule(false)" '+(activeCount?'':'disabled')+'>Выключить</button>'+
    '<button type="button" class="btn dark" onclick="savePriceNightSchedule(true)">Сохранить</button></div></div>');
};
window.savePriceNightSchedule=async function(enabled){
  if(!priceIsWbMarket())return;
  const ids=[...priceSelection()].filter(Boolean);if(!ids.length)return;
  const start=String(document.getElementById('priceNightStart')?.value||'04:00');
  const end=String(document.getElementById('priceNightEnd')?.value||'06:00');
  const price=Number(document.getElementById('priceNightValue')?.value);
  if(enabled&&(!/^\d{2}:\d{2}$/.test(start)||!/^\d{2}:\d{2}$/.test(end)||start===end))return alert('Укажите корректное время.');
  if(enabled&&!(price>0))return alert('Укажите цену больше 0.');
  try{
    const result=await remoteNightSchedule({market:priceUi.market,remoteIds:ids,enabled:Boolean(enabled),start,end,price});
    const scheduleByNm=new Map((result.schedules||[]).map(row=>[String(row.nmId||''),row]));
    for(const row of activeRows()){
      if(!ids.includes(String(row.remoteId||'')))continue;
      const schedule=scheduleByNm.get(String(row.remoteId||''));
      row.nightPriceEnabled=Boolean(enabled);
      if(schedule){
        row.nightPriceStart=priceMinuteTime(schedule.startMinute);
        row.nightPriceEnd=priceMinuteTime(schedule.endMinute);
        row.nightPriceTarget=Number(schedule.targetPrice)||null;
        row.nightPricePhase=String(schedule.phase||'');
      }else if(enabled){
        row.nightPriceStart=start;row.nightPriceEnd=end;row.nightPriceTarget=price;
      }
    }
    priceSelection().clear();closeModal();paintPrices();
    setPriceStatus(enabled?'Ночная цена сохранена для '+Number(result.count||ids.length)+' товаров':'Ночная цена выключена','ok');
  }catch(error){alert(priceErrorText(error))}
};

window.hidePriceRow=function(index){
  const row=activeRows()[Number(index)],key=priceRowKey(row);if(!row||!key)return;
  const market=String(row.market||priceUi.market),keys=priceHiddenKeys(market);if(!keys.includes(key))keys.push(key);
  priceRememberHidden(market,keys);priceExpanded=null;paintPrices();
  setPriceStatus('Товар скрыт из списка цен.','ok');
};
window.openHiddenPrices=function(){
  const market=priceUi.market,keys=priceHiddenKeys(market),rows=activeRows().filter(row=>priceIsHidden(row,market));
  window.__priceHiddenRows=rows;
  const body=rows.length?rows.map((row,index)=>'<div class="item price-hidden-row"><div class="grow"><div class="name">'+pEsc(row.name||row.sku||'Товар')+'</div><div class="muted">'+pEsc(row.sku?('Арт. '+row.sku):row.remoteId||'')+'</div></div><button type="button" class="btn" onclick="restorePriceRow('+index+')">Вернуть</button></div>').join(''):'<div class="empty">Скрытых товаров в текущей загрузке нет.</div>';
  showSheet('<h3>Скрытые · '+pEsc(marketLabel(market))+'</h3>'+body+(keys.length?'<button type="button" class="btn full" onclick="restoreAllPriceRows()">Вернуть все</button>':''));
};
window.restorePriceRow=function(index){
  const row=window.__priceHiddenRows?.[Number(index)],market=priceUi.market,key=priceRowKey(row);if(!key)return;
  priceRememberHidden(market,priceHiddenKeys(market).filter(x=>x!==key));paintPrices();openHiddenPrices();
};
window.restoreAllPriceRows=function(){
  priceRememberHidden(priceUi.market,[]);closeModal();paintPrices();setPriceStatus('Все скрытые товары возвращены.','ok');
};
window.priceRefresh=function(){
  return window.renderPrices(true);
};

function inputNumber(id){
  const el=document.getElementById(id),n=Number(el?.value);
  return Number.isFinite(n)?n:NaN;
}
window.openPriceEditor=function(index){
  const row=activeRows()[Number(index)];if(!row||row.error)return;
  const same=priceExpanded&&priceExpanded.market===priceUi.market&&priceExpanded.index===Number(index);
  priceExpanded=same?null:{market:priceUi.market,index:Number(index)};
  paintPrices();
  if(!same)setTimeout(()=>document.querySelector('[data-price-row="'+Number(index)+'"] .price-inline-editor input:not([disabled])')?.focus(),0);
};
window.collapsePriceEditor=function(){
  if(!priceExpanded)return;
  priceExpanded=null;paintPrices();
};

async function remotePromoToggle(body){
  const response=await fetch(MILLIONER_API+'/api/market-prices/promo',{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,confirm:true})
  });
  const text=await response.text();
  let data=null;if(text){try{data=JSON.parse(text)}catch{throw new Error('Сервер акций вернул некорректный ответ')}}
  if(!response.ok||data?.ok===false)throw new Error(data?.error||('HTTP '+response.status));
  return data;
}
window.togglePricePromo=async function(index,enabled){
  const row=activeRows()[Number(index)];if(!row||(row.market!=='WB'&&row.market!=='WB2'))return;
  if(enabled&&(row.priceProtected||row.promoBlocked)){paintPrices();return alert('Для товара включена защита цены или запрет акций.');}
  const checkbox=document.querySelector('[data-price-row="'+Number(index)+'"] .price-promo-toggle input');
  if(checkbox)checkbox.disabled=true;
  try{
    const result=await remotePromoToggle({market:row.market,remoteId:row.remoteId,enabled:Boolean(enabled)});
    row.promoEnabled=Boolean(result.enabled);
    if(row.promoStatus!=='participating')row.promoStatus=row.promoEnabled?'idle':'off';
    if(!row.promoEnabled&&row.promoStatus!=='participating'){row.promoName='';row.promoPlanPrice=null;row.promoPlanDiscount=null}
    paintPrices();setPriceStatus(row.promoEnabled?'Акции включены':'Акции выключены','ok');
  }catch(error){
    if(checkbox){checkbox.checked=!enabled;checkbox.disabled=false}
    alert(priceErrorText(error));
  }
};
async function remotePriceUpdate(body){
  const response=await fetch(MILLIONER_API+'/api/market-prices/update',{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,confirm:true})
  });
  const text=await response.text();
  let data=null;if(text){try{data=JSON.parse(text)}catch{const e=new Error('Сервер цен вернул некорректный ответ');e.status=502;throw e}}
  if(!response.ok||data?.ok===false){const error=new Error(data?.error||('HTTP '+response.status));error.status=response.status;error.retryAt=Number(data?.retryAt)||0;throw error}
  if(!data||typeof data!=='object')throw new Error('Сервер цен вернул пустой ответ');
  return data;
}
window.submitPriceEdit=async function(index){
  const row=activeRows()[Number(index)];if(!row)return;
  const button=document.querySelector('[data-price-row="'+Number(index)+'"] .price-inline-editor .btn.dark');if(button){button.disabled=true;button.textContent='Сохраняю…';}
  try{
    if(row.market==='Kaspi'){
      const price=inputNumber('priceEditCurrent');
      if(!(price>0))throw new Error('Введите цену больше 0');
      if(typeof requireWarehouseEditReady==='function'&&!requireWarehouseEditReady())return;
      if(!confirm('Изменить цену Kaspi для «'+String(row.name||row.sku)+'» на '+pMoney(price,'KZT')+'?'))return;
      const product=(state.products||[]).find(item=>String(item.id)===String(row.productId));
      if(!product)throw new Error('Товар склада не найден');
      product.kaspiPrice=price;
      save();
      let pushed=true;
      if(typeof pushWarehouseToServer==='function')pushed=(await pushWarehouseToServer())===true;
      row.price=price;row.finalPrice=price;row.source='warehouse';
      priceExpanded=null;paintPrices();
      setPriceStatus(pushed?'Цена Kaspi сохранена · XML обновлён':'Цена Kaspi сохранена локально · сервер ещё синхронизируется',pushed?'ok':'warn');
      return;
    }
    if(row.market==='WB'||row.market==='WB2'){
      const enteredPrice=row.canEditPrice===false?null:inputNumber('priceEditCurrent');
      const enteredDiscount=inputNumber('priceEditDiscount');
      if(row.canEditPrice!==false&&!(enteredPrice>0))throw new Error('Введите цену больше 0');
      if(!Number.isInteger(enteredDiscount)||enteredDiscount<0||enteredDiscount>99)throw new Error('Скидка должна быть целым числом от 0 до 99');
      const priceChanged=row.canEditPrice!==false&&Math.abs(enteredPrice-pNum(row.price))>0.000001;
      const discountChanged=enteredDiscount!==Math.round(pNum(row.discount));
      if(!priceChanged&&!discountChanged){priceExpanded=null;paintPrices();return;}
      const changes=[];
      if(priceChanged)changes.push('цену на '+pMoney(enteredPrice,row.currency));
      if(discountChanged)changes.push('скидку на '+enteredDiscount+'%');
      const question='Сохранить для '+marketLabel(row.market)+' '+changes.join(' и ')+'?';
      if(!confirm(question))return;
      const body={market:row.market,remoteId:row.remoteId};
      if(row.priceProtected){
        if(!confirm('Защита цены включена. Всё равно изменить цену/скидку вручную и сохранить новое значение как защищённое?'))return;
        body.overrideProtection=true;
      }
      if(priceChanged)body.price=enteredPrice;
      if(discountChanged)body.discount=enteredDiscount;
      const result=await remotePriceUpdate(body);
      if(priceChanged){row.price=enteredPrice;row.priceMax=enteredPrice;row.finalPrice=enteredPrice*(1-enteredDiscount/100);row.finalPriceMax=row.finalPrice}
      if(discountChanged){row.discount=enteredDiscount;if(!priceChanged&&pNum(row.price)>0){row.finalPrice=pNum(row.price)*(1-enteredDiscount/100);row.finalPriceMax=pNum(row.priceMax||row.price)*(1-enteredDiscount/100)}}
      row.syncState='pending';row.syncQueuedAt=Number(result.queuedAt)||Date.now();row.syncSentAt=0;row.syncError='';
      const cached=priceCache.get(row.market);
      if(cached){
        cached.pendingCount=(cached.rows||[]).filter(item=>item.syncState==='pending').length;
        cached.sentCount=(cached.rows||[]).filter(item=>item.syncState==='sent').length;
        cached.nextSyncAt=Number(result.nextSyncAt)||Number(cached.nextSyncAt)||0;
      }
      priceExpanded=null;paintPrices();
      setPriceStatus('Изменение сохранено · ожидает сеанса WB'+(Number(result.nextSyncAt)>Date.now()?' в '+priceTimeLabel(result.nextSyncAt):''),'ok');
      return;
    }
    if(row.market==='Ozon'){
      const price=inputNumber('priceEditCurrent'),oldPrice=inputNumber('priceEditOld');
      if(!(price>0))throw new Error('Введите цену больше 0');
      if(Number.isFinite(oldPrice)&&oldPrice>0&&oldPrice<=price)throw new Error('Цена до скидки должна быть выше текущей цены или 0');
      if(!confirm('Отправить новую цену Ozon для «'+String(row.name||row.sku)+'»?'))return;
      await remotePriceUpdate({market:'Ozon',accountId:row.accountId,sku:row.sku,price,oldPrice:Number.isFinite(oldPrice)?Math.max(0,oldPrice):0,minPrice:row.minPrice,currency:row.currency});
      row.price=price;row.finalPrice=price;row.oldPrice=Number.isFinite(oldPrice)?Math.max(0,oldPrice):0;
      bumpPriceEpoch('Ozon');
      const cached=priceCache.get('Ozon');if(cached){cached.stale=true;cached.fetchedAt=Number(cached.fetchedAt)||Date.now()}
      priceExpanded=null;paintPrices();setPriceStatus('Ozon подтвердил обновление цены. Нажмите ↻ для проверки.','ok');
    }
  }catch(error){
    alert(priceErrorText(error));
  }finally{
    if(button&&document.body.contains(button)){button.disabled=false;button.textContent='Сохранить';}
  }
};

window.priceTabRestore=function(){
  setPriceTabs();
  const input=document.getElementById('priceSearch');if(input)input.value=priceUi.q;
};
window.priceTabRestore();
})();