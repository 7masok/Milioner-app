(function(){
'use strict';

const PRICE_UI_KEY=(typeof KEY==='string'?KEY:'sklad_mvp_v2')+'_prices_ui_v1';
const PRICE_MARKETS=['Kaspi','WB','WB2','Ozon'];
const PRICE_CLIENT_TTL_MS=2*60*1000;
let priceUi={market:'Kaspi',q:'',sort:'asc',hidden:{},groupFilter:'all',groupId:''};
Object.assign(priceUi,{deliveryRank:'',deliverySettings:{}});
let priceExpanded=null;
const priceSelected={Kaspi:new Set(),WB:new Set(),WB2:new Set()};
try{
  const saved=JSON.parse(localStorage.getItem(PRICE_UI_KEY)||'{}')||{};
  if(PRICE_MARKETS.includes(saved.market))priceUi.market=saved.market;
  priceUi.q=String(saved.q||'');
  if(saved.sort==='desc'||saved.sort==='asc')priceUi.sort=saved.sort;
  if(saved.hidden&&typeof saved.hidden==='object')priceUi.hidden=saved.hidden;
  if(saved.groupFilter==='ungrouped')priceUi.groupFilter='ungrouped';
  priceUi.groupId=String(saved.groupId||'');
  if(['share','amount'].includes(saved.deliveryRank))priceUi.deliveryRank=saved.deliveryRank;
  if(saved.deliverySettings&&typeof saved.deliverySettings==='object')priceUi.deliverySettings=saved.deliverySettings;
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
function priceCanSelect(market=priceUi.market){return market==='Kaspi'||priceIsWbMarket(market)}
function priceSelectionId(row){return priceIsWbMarket(row?.market)?String(row.remoteId||''):priceRowKey(row)}
function priceGroupLabel(row){return String(row?.groupName||'').trim()||('Группа '+String(row?.groupImtId||''))}
function priceMatchesGroup(row){
  if(!priceIsWbMarket(row?.market))return true;
  if(priceUi.groupId)return String(row?.groupImtId||'')===String(priceUi.groupId);
  if(priceUi.groupFilter==='ungrouped')return !row?.grouped;
  return true;
}
function priceVisibleRows(){
  const q=priceUi.q.trim().toLocaleLowerCase('ru-RU');
  return activeRows().map((row,index)=>({row,index})).filter(({row})=>{
    if(row?.error||priceIsHidden(row)||!priceMatchesGroup(row))return false;
    if(!q)return true;
    return [row.name,row.sku,row.remoteId,row.account,row.groupName].some(value=>String(value||'').toLocaleLowerCase('ru-RU').includes(q));
  });
}
function updatePriceGroupTools(){
  const tools=document.getElementById('priceGroupTools'),select=document.getElementById('priceGroupSelect'),
    merge=document.getElementById('priceGroupMerge'),detach=document.getElementById('priceGroupDetach');
  const isWb=priceIsWbMarket(),selection=priceSelection();
  if(tools)tools.hidden=!isWb;if(!isWb)return;
  if(select){
    const groups=new Map(),q=priceUi.q.trim().toLocaleLowerCase('ru-RU');
    for(const row of activeRows()){
      if(row?.error||!row?.grouped||!row?.groupImtId||priceIsHidden(row))continue;
      if(q&&![row.name,row.sku,row.remoteId,row.account,row.groupName].some(value=>String(value||'').toLocaleLowerCase('ru-RU').includes(q)))continue;
      const id=String(row.groupImtId),group=groups.get(id)||{row,count:0};
      group.count+=1;groups.set(id,group);
    }
    const options=['<option value="">Все группы</option>','<option value="__ungrouped__">Без группы</option>',...[...groups.entries()].sort((a,b)=>String(a[1].row?.name||'').localeCompare(String(b[1].row?.name||''),'ru')).map(([id,group])=>'<option value="'+pEsc(id)+'">'+pEsc(priceGroupLabel(group.row))+' · '+(group.count===Number(group.row.groupSize)?group.count:group.count+' видно / '+Number(group.row.groupSize))+'</option>')];
    // Keep the current filter explicit; never silently switch to unrelated products.
    if(priceUi.groupId&&!groups.has(priceUi.groupId))options.push('<option value="'+pEsc(priceUi.groupId)+'">Группа '+pEsc(priceUi.groupId)+' · нет видимых товаров</option>');
    select.innerHTML=options.join('');select.value=priceUi.groupFilter==='ungrouped'?'__ungrouped__':priceUi.groupId||'';
  }
  const rename=document.getElementById('priceGroupName');
  if(rename)rename.disabled=!priceUi.groupId||!activeRows().some(row=>row.grouped&&String(row.groupImtId)===priceUi.groupId);
  if(merge)merge.disabled=!selection.size;
  if(detach)detach.disabled=!selection.size;
}
function updatePriceBulkTools(indexed=priceVisibleRows()){
  const tools=document.getElementById('priceBulkTools'),all=document.getElementById('priceSelectAll'),count=document.getElementById('priceSelectedCount'),
    enable=document.getElementById('priceBulkEnablePromo'),disable=document.getElementById('priceBulkDisablePromo'),night=document.getElementById('priceBulkNight'),
    protection=document.getElementById('priceBulkProtection'),price=document.getElementById('priceBulkPrice');
  const isWb=priceIsWbMarket(),selection=priceSelection(),visibleIds=indexed.filter(({row})=>!row.error).map(({row})=>priceSelectionId(row)).filter(Boolean),
    selectedVisible=visibleIds.filter(id=>selection.has(id)).length;
  if(tools){tools.hidden=!priceCanSelect();tools.classList.toggle('kaspi',priceUi.market==='Kaspi');}
  for(const button of [enable,disable,night,protection])if(button)button.hidden=!isWb;
  if(price)price.textContent=isWb?'Цена / скидка':'Изменить цену';
  if(all){
    all.checked=Boolean(visibleIds.length)&&selectedVisible===visibleIds.length;
    all.indeterminate=selectedVisible>0&&selectedVisible<visibleIds.length;
  }
  if(count)count.textContent=selection.size?'Выбрано '+selection.size:'';
  if(enable)enable.disabled=!selection.size;
  if(disable)disable.disabled=!selection.size;
  if(night)night.disabled=!selection.size;
  if(protection)protection.disabled=!selection.size;
  if(price)price.disabled=!selection.size;
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
  priceDeliveryControls();
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
    const ordinary=pNum(row.nightBasePrice)||pNum(row.confirmedPrice)||pNum(row.price);
    return '<div class="price-inline-editor" onclick="event.stopPropagation()">'+
      '<div class="price-mode-title">Обычная цена</div><div class="price-inline-fields"><div class="field"><label>До скидки, '+pEsc(row.currency||'RUB')+'</label><input id="priceEditCurrent" type="number" min="1" step="1" inputmode="decimal" value="'+pEsc(ordinary||'')+'" '+(priceDisabled?'disabled':'')+' oninput="priceInlinePreview()"></div>'+
      '<div class="field"><label>Скидка, %</label><input id="priceEditDiscount" type="number" min="0" max="99" step="1" inputmode="numeric" value="'+pEsc(Math.round(pNum(row.discount)))+'" oninput="priceInlinePreview()"></div></div>'+
      '<div id="priceInlineTotal" class="muted">После скидки: '+pMoney(ordinary*(1-pNum(row.discount)/100),row.currency)+'</div>'+
      '<div id="priceInlineProfit">'+priceProfitHtml(row,ordinary*(1-pNum(row.discount)/100))+'</div>'+
      '<div class="price-night-row"><label class="price-promo-toggle"><input id="priceNightEnabled" type="checkbox" '+(row.nightPriceEnabled?'checked':'')+' '+(priceDisabled?'disabled':'')+'>Ночь</label>'+
      '<div class="field"><label>Ночная цена, '+pEsc(row.currency||'RUB')+'</label><input id="priceNightCardValue" type="number" min="1" step="1" inputmode="decimal" value="'+pEsc(pNum(row.nightPriceTarget)||'')+'" '+(priceDisabled?'disabled':'')+'></div></div>'+
      '<div class="price-night-times"><div class="field"><label>С · Алматы</label><input id="priceNightCardStart" type="time" value="'+pEsc(row.nightPriceStart||'04:00')+'"></div><div class="field"><label>До</label><input id="priceNightCardEnd" type="time" value="'+pEsc(row.nightPriceEnd||'06:00')+'"></div><button type="button" class="btn" onclick="savePriceCardNight('+Number(index)+',document.getElementById(\'priceNightEnabled\').checked)">Сохранить ночь</button></div>'+
      priceNightDaysPicker('priceNightCardDays',row.nightPriceWeekdays)+
      '<div class="muted">Возврат: '+pMoney(ordinary,row.currency)+' до скидки</div>'+
      (priceDisabled?'<div class="price-inline-warning">Разные цены по размерам · меняется только скидка</div>':'')+
      '<details class="price-advanced"><summary>Защита</summary><div class="price-protection-grid">'+
        '<label class="price-protection-toggle"><input type="checkbox" '+(row.manualPriceLock?'checked':'')+' onchange="togglePriceProtection('+Number(index)+',\'manualPriceLock\',this.checked)"> <span><b>Зафиксировать цену продавца</b><br><span class="muted">Блокирует наши автоматические изменения цены и скидки.</span></span></label>'+
        '<label class="price-protection-toggle"><input type="checkbox" '+(row.promoBlocked?'checked':'')+' onchange="togglePriceProtection('+Number(index)+',\'promoBlock\',this.checked)"> <span><b>Не участвовать в акциях</b><br><span class="muted">Поддерживает скидку продавца 0%. Склад регулярно проверяет WB и убирает появившуюся скидку.</span></span></label>'+
        '<label class="price-protection-toggle"><input type="checkbox" '+(row.autoZeroEnabled?'checked':'')+' onchange="togglePriceProtection('+Number(index)+',\'autoZeroEnabled\',this.checked)"> <span><b>Защита при нулевом моём остатке</b><br><span class="muted">Включается только при подтверждённом доступном остатке 0.</span></span></label>'+
      '</div></details>'+
      '<div class="price-inline-actions"><button type="button" class="btn" onclick="openPriceWorkbench(\'enter\','+Number(index)+')">В акцию</button><button type="button" class="btn" onclick="openPriceWorkbench(\'exit\','+Number(index)+')">Выйти из акции</button></div>'+
      '<div class="price-inline-actions wb"><button type="button" class="btn dark" onclick="submitPriceEdit('+Number(index)+')">Сохранить</button><button type="button" class="btn price-hide-action" onclick="hidePriceRow('+Number(index)+')">Скрыть</button></div>'+
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
    lines='<span>Цена сейчас: <b>'+pRange(row.confirmedPrice??row.price,row.confirmedPriceMax??row.priceMax,row.currency)+'</b></span>'+
      '<span>Скидка: <b>'+pNum(row.confirmedDiscount??row.discount)+'%'+'</b></span>'+
      '<span>После скидки: <b>'+pRange(pNum(row.confirmedPrice??row.price)*(1-pNum(row.confirmedDiscount??row.discount)/100),pNum(row.confirmedPriceMax??row.priceMax)*(1-pNum(row.confirmedDiscount??row.discount)/100),row.currency)+'</b></span>'+
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
    ?'<div class="price-sync-state pending">Ожидает отправки в WB: '+pMoney(row.price,row.currency)+' · '+pNum(row.discount)+'% · итог '+pMoney(row.finalPrice,row.currency)+'</div>'
    :row.syncState==='sent'
      ?'<div class="price-sync-state sent">Отправлено в WB · ждём проверки</div>'
      :'';
  const promo=row.market==='WB'||row.market==='WB2'
    ?'<span class="price-promo-badge '+(row.promoEnabled&&row.promoStatus==='participating'?'active':row.promoEnabled?'waiting':'off')+'"> · '+(
      row.promoEnabled&&row.promoStatus==='participating'?'В акции':
      row.promoEnabled&&row.promoStatus==='auto_only'?'Автоакции вручную':
      row.promoEnabled?'Подбирает условия акции':'Участие проверяйте в WB')+'</span>'
    :'';
  const night=(row.market==='WB'||row.market==='WB2')&&(row.nightPriceEnabled||row.nightPricePhase==='restoring')
    ?'<span class="price-night-badge"> · 🌙 '+pEsc(priceNightDaysLabel(row.nightPriceWeekdays))+' · '+pEsc(row.nightPriceStart||'04:00')+'–'+pEsc(row.nightPriceEnd||'06:00')+' · '+pMoney(row.nightPriceTarget,row.currency)+' · '+pEsc(({idle:'Запланировано',raising:'Устанавливается',active:'Установлена',restoring:'Возвращается',manual:'Ручная цена',locked:'Защита',off:'Выключено',error:'Ошибка'})[row.nightPricePhase]||'Запланировано')+(row.nightProtectionOverride?' · Поверх защиты':'')+(row.nightPriceError?' · '+pEsc(row.nightPriceError):'')+'</span>'
    :'';
  const discountBlock=row.promoBlocked?'<span class="price-lock-badge"> · Скидки заблокированы · 0%</span>':'';
  const protection=row.priceProtected?'<span class="price-lock-badge"> · 🔒 '+pEsc(row.protectionReason||'Защита цены')+'</span>':'';
  const group=priceIsWbMarket(row.market)?'<span> · '+(row.grouped?(pEsc(priceGroupLabel(row))+' · '+Number(row.groupSize||0)):'Без группы')+'</span>':'';
  const expanded=Boolean(priceExpanded&&priceExpanded.market===priceUi.market&&priceExpanded.index===Number(index));
  const selected=priceCanSelect(row.market)&&priceSelection(row.market).has(priceSelectionId(row));
  const selectBox=priceCanSelect(row.market)?'<label class="price-row-select" onclick="event.stopPropagation()"><input type="checkbox" '+(selected?'checked':'')+' onchange="priceSelectRow('+Number(index)+',this.checked)" aria-label="Выбрать товар"></label>':'';
  return '<div class="item price-item '+(!linked?'unlinked':'')+(expanded?' expanded':'')+(selected?' selected':'')+'" data-price-row="'+index+'">'+selectBox+
    '<button type="button" class="price-card-toggle" onclick="openPriceEditor('+index+')" aria-expanded="'+(expanded?'true':'false')+'">'+
      '<div class="price-item-head"><div class="grow"><div class="name">'+pEsc(row.name||row.sku||'Товар')+'</div>'+
      '<div class="muted">'+pEsc(account?(row.account+' · '):'')+pEsc(row.sku?('Арт. '+row.sku):row.remoteId||'')+(linked?'':' · не привязан к товару склада')+group+promo+night+protection+discountBlock+'</div>'+sync+'</div><span class="price-chevron">'+(expanded?'⌄':'›')+'</span></div>'+
      '<div class="price-values">'+lines+'</div>'+
    '</button>'+(priceIsWbMarket(row.market)?'<div class="price-delivery-slot" data-delivery-index="'+index+'">'+priceDeliveryHtml(row)+'</div>':'')+priceInlineEditor(row,index)+'</div>';
}
function paintPrices(){
  priceDeliveryModels.clear();
  setPriceTabs();
  const rows=activeRows(),visibleRows=rows.filter(row=>!priceIsHidden(row)&&priceMatchesGroup(row)),q=priceUi.q.trim().toLocaleLowerCase('ru-RU');
  const indexed=rows.map((row,index)=>({row,index})).filter(({row})=>{
    if(priceIsHidden(row)||!priceMatchesGroup(row))return false;
    if(!q)return true;
    return [row.name,row.sku,row.remoteId,row.account,row.groupName].some(value=>String(value||'').toLocaleLowerCase('ru-RU').includes(q));
  }).sort((a,b)=>{
    if(priceIsWbMarket()&&priceUi.deliveryRank)return priceDeliveryCompare(a,b);
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
  updatePriceBulkTools(indexed);
  if(!rows.length){
    const failure=priceErrors.get(priceUi.market),snapshot=activeSnapshot();
    if(failure){priceRenderError(failure.message);return;}
    if(snapshot?.serverSnapshot&&snapshot?.waiting){
      list.innerHTML='<div class="empty">Цены WB ещё не загружены сервером.<br><span class="muted">Склад получит их в ближайший разрешённый сеанс связи.</span></div>';return;
    }
    list.innerHTML='<div class="empty">Нет позиций для этого магазина</div>';return;
  }
  if(!indexed.length&&priceIsWbMarket()&&priceUi.groupId){
    const members=rows.filter(row=>String(row.groupImtId||'')===priceUi.groupId);
    const allHidden=members.length&&members.every(row=>priceIsHidden(row));
    const message=!members.length?'Группа не найдена в текущем снимке WB.':allHidden?'Все товары этой группы скрыты.':'В этой группе нет товаров по текущему поиску.';
    list.innerHTML='<div class="empty">'+message+'</div><div class="price-inline-actions"><button type="button" class="btn" onclick="priceSetGroup(\'\')">Все группы</button>'+
      (q?'<button type="button" class="btn" onclick="priceSearch(\'\')">Очистить поиск</button>':'')+
      (allHidden?'<button type="button" class="btn" onclick="openHiddenPrices()">Показать скрытые</button>':'')+'</div>';return;
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
  if(priceIsWbMarket())void loadPriceDelivery(priceUi.market,force);
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
  priceSelection(priceUi.market).clear();
  priceSelection(market).clear();
  priceExpanded=null;priceUi.market=market;priceUi.groupFilter='all';priceUi.groupId='';rememberPriceUi();setPriceTabs();window.renderPrices(false);
};
window.priceSetGroup=function(value){
  priceUi.groupFilter=value==='__ungrouped__'?'ungrouped':'all';
  priceUi.groupId=value==='__ungrouped__'?'':String(value||'');rememberPriceUi();paintPrices();
};
window.priceSearch=function(value){
  priceUi.q=String(value||'');rememberPriceUi();paintPrices();
};
window.priceToggleSort=function(){
  priceUi.deliveryRank='';priceUi.sort=priceUi.sort==='desc'?'asc':'desc';rememberPriceUi();setPriceTabs();paintPrices();
};
window.priceSelectRow=function(index,checked){
  const row=activeRows()[Number(index)];if(!row||row.error||!priceCanSelect(row.market))return;
  const set=priceSelection(row.market),id=priceSelectionId(row);if(!id)return;
  if(checked)set.add(id);else set.delete(id);
  paintPrices();
};
window.priceSelectAllVisible=function(checked){
  if(!priceCanSelect())return;
  const set=priceSelection();
  for(const {row} of priceVisibleRows()){
    const id=priceSelectionId(row);if(!id)continue;
    if(checked)set.add(id);else set.delete(id);
  }
  paintPrices();
};
// Tariff estimates are separate from historical profit averages and never write business data.
const priceDeliveryCache=new Map(),priceDeliveryLoads=new Map(),priceDeliveryModels=new Map();
function priceDeliverySetting(market=priceUi.market){return priceUi.deliverySettings?.[market]||{scheme:'fbs',warehouse:''};}
function priceDeliveryEstimate(row,data,setting,now=Date.now()){
  const unknown=reason=>({available:false,reason});
  if(!data)return unknown('Загружаю тарифы WB…');
  if(data.error)return unknown(data.error);
  if(!setting.warehouse)return unknown('Выберите склад в «Доставке WB»');
  const warehouse=data.warehouses?.find(w=>w.id===setting.warehouse),tariff=warehouse?.[setting.scheme==='fbw'?'fbw':'fbs'];
  if(!warehouse)return unknown('Выбранного склада нет в текущих тарифах');
  if(!(data.fetchedAt>0)||now-data.fetchedAt>26*3600000)return unknown(data.lastError||'Ожидается свежий тариф WB');
  if(!(data.cardsFetchedAt>0)||now-data.cardsFetchedAt>86400000)return unknown('Ожидаются свежие габариты WB');
  const d=data.cards?.find(c=>String(c.nmId)===String(row.remoteId))?.dimensions;
  if(!d||![d.length,d.width,d.height].every(n=>Number.isFinite(Number(n))&&Number(n)>0))return unknown('В карточке WB не заполнены габариты');
  const sides=[Number(d.length),Number(d.width),Number(d.height)],weight=Number(d.weightBrutto)||null;
  if(Math.max(...sides)>120||sides.reduce((a,b)=>a+b,0)>200||weight>=25)return unknown('Крупный или тяжёлый товар: нужен отдельный расчёт');
  if(!(tariff?.base>0)||tariff.liter===null||!(tariff.liter>=0))return unknown('Для этой схемы у склада нет тарифа');
  const volume=sides.reduce((a,b)=>a*b,1)/1000;let rub,formula;
  if(volume<=1){
    // WB published 13.10.2026. Fail closed if the live first/additional litre rates
    // no longer match that schedule; do not extrapolate a new small-parcel tariff.
    const c=Number(tariff.coefficient)/100;
    if(!(c>0)||Math.abs(tariff.base-46*c)>.11||Math.abs(tariff.liter-14*c)>.11||now>Date.parse('2026-11-13T00:00:00+05:00'))return unknown('Тариф до 1 л требует проверки по шкале WB');
    const base=volume<=.2?23:volume<=.4?26:volume<=.6?29:volume<=.8?30:32;
    rub=base*c;formula=base+' ₽ × '+tariff.coefficient+'% · шкала до 1 л';
  }else{
    rub=tariff.base+(volume-1)*tariff.liter;
    formula=tariff.base+' ₽ + '+(volume-1).toLocaleString('ru-RU',{maximumFractionDigits:4})+' л × '+tariff.liter+' ₽';
  }
  const confirmedPrice=Number(row.confirmedPrice??row.price),discount=Number(row.confirmedDiscount??row.discount),currency=String(row.currency||'').toUpperCase();
  const price=confirmedPrice*(1-discount/100),range=Number(row.confirmedPriceMax??row.priceMax??confirmedPrice)>confirmedPrice+.001;
  const fx=data.fx?.rate>0&&now-Number(data.fx.observedAt||data.fx.at||0)<=7*86400000?data.fx:null;
  const kzt=fx?rub*fx.rate:null,priceRub=currency==='RUB'?price:currency==='KZT'&&fx?price/fx.rate:null;
  return {available:true,rub,kzt,share:priceRub>0&&!range?rub/priceRub*100:null,volume,sides,weight,formula,warehouse,scheme:setting.scheme==='fbw'?'FBW':'FBS',fx,stale:now-data.fetchedAt>2*3600000};
}
function priceDeliveryModel(row){
  if(!priceDeliveryModels.has(row))priceDeliveryModels.set(row,priceDeliveryEstimate(row,priceDeliveryCache.get(row.market)?.data,priceDeliverySetting(row.market)));
  return priceDeliveryModels.get(row);
}
function priceDeliveryCompare(a,b){
  const x=priceDeliveryModel(a.row),y=priceDeliveryModel(b.row),key=priceUi.deliveryRank==='amount'?'rub':'share';
  const av=x.available?x[key]:null,bv=y.available?y[key]:null;
  if(av===null&&bv!==null)return 1;if(av!==null&&bv===null)return -1;
  return (av!==null&&bv!==null?bv-av:0)||String(a.row.name||a.row.sku||'').localeCompare(String(b.row.name||b.row.sku||''),'ru')||a.index-b.index;
}
function priceDeliveryHtml(row){
  const m=priceDeliveryModel(row);
  if(!m.available)return '<div class="price-delivery-unknown">Доставка WB · '+pEsc(m.reason)+'</div>';
  const share=m.share===null?'доля цены —':m.share.toLocaleString('ru-RU',{maximumFractionDigits:1})+'% цены';
  const tone=m.share>=30?'high':m.share>=15?'medium':'low',data=priceDeliveryCache.get(row.market)?.data;
  return '<details class="price-delivery '+tone+'"><summary><span>Доставка WB ≈ <b>'+pMoney(m.rub,'RUB')+'</b>'+(m.kzt!==null?' · '+pMoney(m.kzt,'KZT'):'')+'</span><span class="price-delivery-share">'+share+'</span></summary><div class="price-delivery-details">'+
    pEsc(m.sides.join(' × '))+' см · '+m.volume.toLocaleString('ru-RU',{maximumFractionDigits:4})+' л · '+(m.weight?m.weight+' кг':'вес не указан; расчёт для МГТ')+'<br>'+pEsc(m.warehouse.name)+' · '+m.scheme+' · коробы<br>'+pEsc(m.formula)+'<br>Коэффициент склада уже учтён. Тариф на '+pEsc(data.date)+(m.stale?' · обновление задерживается':'')+'<br>'+
    (m.fx?'Курс ≈ '+Number(m.fx.rate).toLocaleString('ru-RU',{maximumFractionDigits:4})+' ₸/₽ · '+pEsc(m.fx.day)+'<br>':'Нет свежего курса WB для перевода в ₸<br>')+
    'Одна прямая доставка. Без возвратов, хранения, приёмки и дополнительных услуг. Для FBW — текущий тариф, без фиксации старой поставки.'+
    '</div></details>';
}
function priceDeliveryControls(){
  const host=document.getElementById('priceDeliveryTools');if(!host)return;
  host.hidden=!priceIsWbMarket();if(host.hidden)return;
  const data=priceDeliveryCache.get(priceUi.market)?.data,setting=priceDeliverySetting(),rank=priceUi.deliveryRank,opened=host.querySelector?.('details')?.open;
  const warehouses=[...(data?.warehouses||[])].sort((a,b)=>(/Казахстан/i.test(b.country)?1:0)-(/Казахстан/i.test(a.country)?1:0)||a.name.localeCompare(b.name,'ru'));
  host.innerHTML='<div class="price-delivery-buttons"><button class="chip '+(rank?'active':'')+'" type="button" onclick="priceToggleDelivery()" aria-pressed="'+Boolean(rank)+'">Дорогая доставка '+(rank?'↓':'')+'</button><details class="price-delivery-settings" '+(opened||(!setting.warehouse&&rank)?'open':'')+'><summary>Доставка WB · настройки</summary><div class="price-delivery-config"><label>Схема<select class="select" onchange="priceDeliveryChange(\'scheme\',this.value)"><option value="fbs" '+(setting.scheme!=='fbw'?'selected':'')+'>FBS · свой склад</option><option value="fbw" '+(setting.scheme==='fbw'?'selected':'')+'>FBW · склад WB</option></select></label><label>Склад / пункт приёма<select class="select" onchange="priceDeliveryChange(\'warehouse\',this.value)"><option value="">Выберите свой склад</option>'+warehouses.map(w=>'<option value="'+pEsc(w.id)+'" '+(w.id===setting.warehouse?'selected':'')+'>'+pEsc(w.country+' · '+w.name)+'</option>').join('')+'</select></label><label>Дорогие сверху<select class="select" onchange="priceDeliveryChange(\'rank\',this.value)"><option value="share" '+(rank!=='amount'?'selected':'')+'>По доле доставки в цене, %</option><option value="amount" '+(rank==='amount'?'selected':'')+'>По стоимости доставки, ₽</option></select></label><div class="muted">'+pEsc(data?.error||data?.lastError||(!data?'Загружаю тарифы…':!warehouses.length?'Тарифы загружаются в фоне. Повторите через минуту.':'Выберите место отгрузки. Это сравнение по текущему тарифу WB.'))+'</div></div></details></div>'+
    (rank?'<div class="price-delivery-note">'+(rank==='amount'?'Сначала самая дорогая доставка за штуку':'Сначала доставка с наибольшей долей в цене')+' · без данных — внизу</div>':'');
}
window.priceToggleDelivery=function(){priceUi.deliveryRank=priceUi.deliveryRank?'':'share';priceExpanded=null;rememberPriceUi();paintPrices();};
window.priceDeliveryChange=function(key,value){
  if(key==='rank'){priceUi.deliveryRank=value==='amount'?'amount':'share';}
  else {const setting={...priceDeliverySetting()};if(key==='scheme')setting.scheme=value==='fbw'?'fbw':'fbs';if(key==='warehouse')setting.warehouse=String(value);priceUi.deliverySettings={...priceUi.deliverySettings,[priceUi.market]:setting};}
  priceExpanded=null;rememberPriceUi();paintPrices();
};
async function loadPriceDelivery(market,force=false){
  if(priceDeliveryLoads.has(market))return priceDeliveryLoads.get(market);
  const hit=priceDeliveryCache.get(market);if(!force&&hit&&Date.now()-hit.at<120000)return;
  const task=(async()=>{
    let data;
    try{const response=await fetch(MILLIONER_API+'/api/market-prices/delivery-tariffs?market='+encodeURIComponent(market),{cache:'no-store'});data=await response.json();if(!response.ok||data.ok===false)throw new Error('Не удалось прочитать тарифы WB');}
    catch{data={error:'Не удалось загрузить тарифы. Нажмите ↻ для повтора.'};}
    priceDeliveryCache.set(market,{at:Date.now(),data});
    if(market===priceUi.market){
      if(priceExpanded){priceDeliveryModels.clear();priceDeliveryControls();document.querySelectorAll('[data-delivery-index]').forEach(el=>{const row=activeRows()[Number(el.dataset.deliveryIndex)];if(row)el.innerHTML=priceDeliveryHtml(row);});}
      else paintPrices();
    }
  })();priceDeliveryLoads.set(market,task);try{await task}finally{priceDeliveryLoads.delete(market)}
}

const priceProfitCache=new Map(),priceProfitLoads=new Map();
function priceProfitAmount(value,signed=false){return (signed&&value>0?'+':'')+Number(value).toLocaleString('ru-RU',{maximumFractionDigits:0})+' ₸';}
function priceProfitHtml(row,finalPrice){
  const hit=priceProfitCache.get(row.market),model=hit?.data?.models?.find(item=>String(item.nmId)===String(row.remoteId));
  const reason=!Number.isFinite(finalPrice)||!(finalPrice>0)?'Введите цену и скидку':String(row.currency||'RUB').toUpperCase()!=='RUB'?'Цена указана не в рублях':hit?.error?'Не удалось загрузить расчёт':!hit?'Загрузка расчёта…':!model?'Нет данных по товару':!model.available?model.reason:'';
  if(reason)return '<div class="muted" style="margin-top:6px;font-size:13px">Прибыль: — · '+pEsc(reason)+(hit?.error?' <button type="button" style="border:0;background:none;text-decoration:underline;color:inherit" onclick="retryPriceProfit(\''+pEsc(row.market)+'\')">Повторить</button>':'')+'</div>';
  const rate=Number(model.fx.rate),revenue=finalPrice*rate,fees=revenue*model.feesRate,delivery=Number(model.logisticsPerUnit)*(model.expenseCurrency==='RUB'?rate:1),profit=revenue-fees-delivery-model.unitCostKzt;
  return '<div style="margin-top:7px;font-weight:700;color:'+(profit<0?'#b52b2b':'#21865c')+'">Прибыль ≈ '+priceProfitAmount(profit,true)+'/шт.</div>'+
    '<details style="margin-top:3px;font-size:12px;color:#777"><summary style="cursor:pointer">Расчёт · без рекламы и налогов</summary><div style="padding-top:5px;line-height:1.6">Комиссия и эквайринг '+(model.feesRate*100).toLocaleString('ru-RU',{maximumFractionDigits:2})+'% · '+priceProfitAmount(fees)+'<br>Одна доставка · '+priceProfitAmount(delivery)+'<br>Себестоимость · '+priceProfitAmount(model.unitCostKzt)+'<br>1 ₽ ≈ '+rate.toLocaleString('ru-RU',{maximumFractionDigits:4})+' ₸ · WB, '+pEsc(model.fx.day)+'<br>'+model.sampleUnits+' шт. · последние '+model.days+' дн.<br>Без отмен и повторных доставок. Курс расчётный по парным ценам заказа.</div></details>';
}
async function loadPriceProfit(market,force=false){
  if(!['WB','WB2'].includes(market))return;
  const old=priceProfitCache.get(market);if(!force&&old&&!old.error&&Date.now()-old.at<5*60000)return;
  if(priceProfitLoads.has(market))return priceProfitLoads.get(market);
  const task=(async()=>{
    try{const response=await fetch(MILLIONER_API+'/api/market-prices/profit-estimates?market='+encodeURIComponent(market),{cache:'no-store'}),data=await response.json();if(!response.ok||data.ok===false)throw Error('Расчёт недоступен');priceProfitCache.set(market,{at:Date.now(),data});}
    catch(error){priceProfitCache.set(market,{at:Date.now(),error:true})}
    if(priceUi.market===market){if(priceWorkbench?.market===market&&document.getElementById('priceWorkbenchPreview'))window.priceWorkbenchPreview();if(priceExpanded?.market===market)window.priceInlinePreview();}
  })();priceProfitLoads.set(market,task);try{return await task}finally{priceProfitLoads.delete(market)}
}
window.retryPriceProfit=market=>loadPriceProfit(market,true);
window.priceInlinePreview=function(){
  const price=Number(document.getElementById('priceEditCurrent')?.value),discount=Number(document.getElementById('priceEditDiscount')?.value),final=price*(1-discount/100),total=document.getElementById('priceInlineTotal');
  if(total)total.textContent='После скидки: '+pMoney(final,'RUB');
  const row=activeRows()[priceExpanded?.index],box=document.getElementById('priceInlineProfit');if(box&&row)box.innerHTML=priceProfitHtml(row,Number.isFinite(discount)&&discount>=0&&discount<=99?final:NaN);
};
window.priceClearSelection=function(){priceSelection().clear();paintPrices();};

let priceWorkbench=null,nightWorkbench=null,priceWorkbenchBusy=false;
window.openPriceWorkbench=function(action='price',index=null){
  if(priceUi.market==='Kaspi'&&action==='price')return openKaspiPriceWorkbench(index);
  if(!priceIsWbMarket())return;
  const rows=index===null?selectedPriceRows():[activeRows()[Number(index)]].filter(Boolean);
  if(!rows.length)return;
  priceWorkbench={market:priceUi.market,action,rows:rows.map(row=>({...row})),ids:rows.map(row=>String(row.remoteId))};
  const title=action==='enter'?'Войти в акцию':action==='exit'?'Выйти из акции':'Обычная цена / скидка';
  showSheet('<h3>'+title+' · '+rows.length+'</h3>'+
    (action==='price'?'<div class="field"><label>Цена до скидки, ₽ · пусто = оставить свою</label><input id="priceWorkbenchPrice" type="number" min="1" step="1" oninput="priceWorkbenchPreview()"></div>':'')+
    '<div class="field"><label>Скидка, % · '+(action==='price'?'пусто = оставить свою':action==='exit'?'0 = убрать скидку':'пусто = подобрать для каждого товара')+'</label><input id="priceWorkbenchDiscount" type="number" min="0" max="99" step="1" value="'+(action==='exit'?'0':'')+'" '+(action==='exit'?'readonly ':'')+'oninput="priceWorkbenchPreview()"></div>'+
    (action==='exit'?'<div class="muted">Скидка 0% · постоянный блок включится для выбранных товаров.</div>':action==='enter'?'<div class="muted">Блок скидок будет снят. При пустом поле сервер найдёт условия акции для каждого товара.</div>':'')+
    '<div id="priceWorkbenchPreview" class="price-workbench-preview"></div><button id="priceWorkbenchApply" type="button" class="btn dark full" onclick="submitPriceWorkbench()">Применить к выбранным</button>');
  window.priceWorkbenchPreview();loadPriceProfit(priceWorkbench.market);
};
function workbenchChanges(){
  const ctx=priceWorkbench;if(!ctx)return [];
  const rawPrice=document.getElementById('priceWorkbenchPrice')?.value||'',rawDiscount=document.getElementById('priceWorkbenchDiscount')?.value||'';
  if(ctx.market==='Kaspi')return ctx.rows.map(row=>{
    const price=Number(rawPrice),product=(state.products||[]).find(item=>String(item.id)===String(row.productId));
    const error=!Number.isSafeInteger(price)||price<=0?'Введите целую цену больше 0':!product?'Товар не привязан к складу':'';
    return {row,price,error};
  });
  return ctx.rows.map(row=>{
    const price=rawPrice===''?pNum(row.syncSource==='manual'?row.price:(row.confirmedPrice??row.price)):Number(rawPrice);
    const plan=pNum(row.promoPlanPrice);
    const automaticEntry=ctx.action==='enter'&&rawDiscount==='';
    let discount=rawDiscount===''?null:Number(rawDiscount),error='';
    if(discount===null&&ctx.action==='price')discount=pNum(row.syncSource==='manual'?row.discount:(row.confirmedDiscount??row.discount));
    if(ctx.action==='exit')discount=0;
    if(!automaticEntry&&discount===null&&plan>0&&price>0)discount=ctx.action==='enter'?Math.max(0,Math.ceil((1-plan/price)*100-1e-9)):Math.min(99,Math.ceil((1-plan/price)*100-1e-9)-1);
    if(!(price>0)||!Number.isInteger(price)||(!automaticEntry&&(!Number.isInteger(discount)||discount<0||discount>99)))error='Укажите корректную цену / скидку';
    if(discount===null&&!automaticEntry)error='Нет порога акции · укажите скидку';
    if(rawPrice!==''&&row.canEditPrice===false)error='Разные цены по размерам';
    if(ctx.action==='price'&&rawPrice===''&&rawDiscount==='')error='Укажите цену или скидку';
    const final=price*(1-Number(discount??row.confirmedDiscount??row.discount??0)/100);
    if(ctx.action==='enter'&&!automaticEntry&&plan>0&&final>plan+1e-6)error='Скидки недостаточно';


    if(row.syncState==='sent'&&ctx.action!=='exit'&&!automaticEntry)error='Предыдущее изменение проверяется';
    return {row,price,discount,final,error,automaticEntry};
  });
}
window.priceWorkbenchPreview=function(){
  const items=workbenchChanges(),el=document.getElementById('priceWorkbenchPreview');
  if(el)el.innerHTML=items.map(item=>priceWorkbench.market==='Kaspi'
    ?'<div class="item"><b>'+pEsc(item.row.name||item.row.sku)+'</b><div>'+pMoney(item.row.price,'KZT')+' → '+pMoney(item.price,'KZT')+'</div>'+(item.error?'<div class="price-error">'+pEsc(item.error)+'</div>':'')+'</div>'
    :'<div class="item"><b>'+pEsc(item.row.name||item.row.sku)+'</b><div>'+pMoney(item.row.confirmedPrice??item.row.price,'RUB')+' → '+pMoney(item.price,'RUB')+' · скидка '+(item.automaticEntry?'подбор для товара':pEsc(item.discount??'—')+'%')+' · '+(item.automaticEntry?'цена после подбора':('итог '+pMoney(item.final,'RUB')))+'</div>'+(item.error?'<div class="price-error">'+pEsc(item.error)+'</div>':item.row.priceProtected||item.row.promoBlocked?'<div class="muted">Защита · потребуется подтверждение</div>':item.automaticEntry?'<div class="muted">Порог и скидку найдёт сервер по условиям WB</div>':!pNum(item.row.promoPlanPrice)&&priceWorkbench.action!=='price'?'<div class="muted">Порог неизвестен · статус участия проверьте в WB</div>':'')+(item.error||item.automaticEntry?'':priceProfitHtml(item.row,item.final))+'</div>').join('');
  const button=document.getElementById('priceWorkbenchApply');if(button)button.disabled=!items.some(item=>!item.error)||priceWorkbenchBusy;
};
window.submitPriceWorkbench=async function(){
  const ctx=priceWorkbench;if(!ctx||priceWorkbenchBusy)return;
  if(ctx.market==='Kaspi')return submitKaspiPriceWorkbench(ctx);
  const eligible=workbenchChanges().filter(item=>!item.error);if(!eligible.length)return;
  const skipped=ctx.ids.length-eligible.length,automatic=eligible.some(item=>item.automaticEntry);
  if(!confirm((automatic?'Подобрать скидку для '+eligible.length+' товаров по условиям акции?':'Сохранить изменения для '+eligible.length+' товаров? Они будут отправлены в ближайший сеанс WB.')+(skipped?' Пропущено: '+skipped+' — причины указаны в списке.':'')))return;
  priceWorkbenchBusy=true;window.priceWorkbenchPreview();
  try{
    const result=await protectedPriceRequest('/api/market-prices/update/bulk',{market:ctx.market,action:ctx.action,remoteIds:eligible.map(item=>String(item.row.remoteId)),price:document.getElementById('priceWorkbenchPrice')?.value||null,discount:ctx.action==='exit'?0:document.getElementById('priceWorkbenchDiscount')?.value||null},ctx.action==='enter'?'promo':'price');
    if(!result)return;
    const applied=new Set((result.applied||[]).map(String));
    for(const id of applied)priceSelection(ctx.market).delete(id);
    closeModal();bumpPriceEpoch(ctx.market);
    if(priceUi.market===ctx.market){await window.renderPrices(true);setPriceStatus('Поиск условий акции: '+(result.discovery?.length||0)+' · очередь скидок: '+(applied.size-(result.discovery?.length||0))+' · пропущено: '+(ctx.ids.length-applied.size),'ok');}
    if(result.skipped?.length)showPriceBlockedDetails(result.skipped.map(item=>({...item,name:ctx.rows.find(row=>String(row.remoteId)===String(item.remoteId))?.name||item.remoteId})));
  }catch(error){alert(priceErrorText(error));}
  finally{priceWorkbenchBusy=false;window.priceWorkbenchPreview();}
};

function openKaspiPriceWorkbench(index){
  const rows=index===null?selectedPriceRows():[activeRows()[Number(index)]].filter(Boolean);
  if(!rows.length)return;
  priceWorkbench={market:'Kaspi',action:'price',rows:rows.map(row=>({...row})),ids:rows.map(priceSelectionId)};
  showSheet('<h3>Изменить цену · Kaspi · '+rows.length+'</h3><div class="field"><label>Новая цена для выбранных, ₸</label><input id="priceWorkbenchPrice" type="number" min="1" step="1" inputmode="numeric" oninput="priceWorkbenchPreview()"></div><div id="priceWorkbenchPreview" class="price-workbench-preview"></div><button id="priceWorkbenchApply" type="button" class="btn dark full" onclick="submitPriceWorkbench()">Применить к выбранным</button>');
  window.priceWorkbenchPreview();
}
async function submitKaspiPriceWorkbench(ctx){
  if(typeof requireWarehouseEditReady!=='function'||!requireWarehouseEditReady())return;
  const items=workbenchChanges(),eligible=items.filter(item=>!item.error);if(!eligible.length)return;
  const skipped=items.filter(item=>item.error);
  if(!confirm('Изменить цену Kaspi для '+eligible.length+' позиций на '+pMoney(eligible[0].price,'KZT')+'?'+(skipped.length?' Пропущено: '+skipped.length+' — причины указаны в списке.':'')))return;
  priceWorkbenchBusy=true;window.priceWorkbenchPreview();
  try{
    const changes=new Map();
    for(const item of eligible){
      const product=(state.products||[]).find(row=>String(row.id)===String(item.row.productId));
      if(!product)throw new Error('Товар склада не найден. Откройте выбор заново.');
      changes.set(String(product.id),{product,price:item.price,previous:product.kaspiPrice});
    }
    for(const change of changes.values())change.product.kaspiPrice=change.price;
    if(save()===false){for(const change of changes.values())change.product.kaspiPrice=change.previous;throw new Error('Склад пока доступен только для просмотра.');}
    const pushed=typeof pushWarehouseToServer==='function'&&(await pushWarehouseToServer())===true;
    if(!pushed)throw new Error('Сохранение цен не подтверждено сервером. Обновите данные и проверьте цены.');
    for(const item of eligible)priceSelection(ctx.market).delete(priceSelectionId(item.row));
    const cached=priceCache.get(ctx.market);
    for(const row of cached?.rows||[]){const change=changes.get(String(row.productId));if(change){row.price=change.price;row.finalPrice=change.price;row.source='warehouse';}}
    if(priceWorkbench===ctx){closeModal();priceWorkbench=null;}
    if(priceUi.market===ctx.market){priceExpanded=null;paintPrices();setPriceStatus('Цены Kaspi сохранены: '+changes.size+' · XML обновлён'+(skipped.length?' · пропущено: '+skipped.length:''),'ok');}
    if(skipped.length)alert(skipped.map(item=>(item.row.name||item.row.sku)+': '+item.error).join('\n'));
  }catch(error){alert(priceErrorText(error));}
  finally{priceWorkbenchBusy=false;window.priceWorkbenchPreview();}
}

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
      '<button type="button" class="btn" onclick="applyPriceBulkProtection(\'promoBlock\',true)">Блок скидок · 0%</button>'+
      '<button type="button" class="btn" onclick="applyPriceBulkProtection(\'promoBlock\',false)">Снять блок скидок</button>'+
      '<button type="button" class="btn" onclick="applyPriceBulkProtection(\'autoZeroEnabled\',true)">Автозащита при 0 · вкл</button>'+
      '<button type="button" class="btn" onclick="applyPriceBulkProtection(\'autoZeroEnabled\',false)">Автозащита при 0 · выкл</button>'+
    '</div><div class="price-inline-warning">Блок скидок поддерживает скидку продавца 0%. «В акцию» снимает блок. Скидки самой площадки отдельно.</div>');
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
let priceGroupNameContext=null;
window.openPriceGroupName=function(){
  if(!priceIsWbMarket()||!priceUi.groupId)return;
  const row=activeRows().find(row=>row.grouped&&String(row.groupImtId)===priceUi.groupId);if(!row)return;
  priceGroupNameContext={market:priceUi.market,groupId:String(row.groupImtId)};
  showSheet('<h3>Название группы</h3><div class="muted">'+pEsc(marketLabel(priceUi.market))+' · Группа '+pEsc(row.groupImtId)+'</div>'+
    '<div class="field"><label>Название</label><input id="priceGroupNameInput" maxlength="80" value="'+pEsc(row.groupName||'')+'" placeholder="Например: Рыбалка"></div>'+
    '<div class="muted">Пустое название вернёт номер группы.</div><button id="priceGroupNameSave" type="button" class="btn dark full" onclick="savePriceGroupName()">Сохранить</button>');
};
window.savePriceGroupName=async function(){
  const context=priceGroupNameContext,input=document.getElementById('priceGroupNameInput'),button=document.getElementById('priceGroupNameSave');
  if(!context||!input||button?.disabled)return;
  const name=input.value.trim();if(name.length>80)return alert('Название должно быть не длиннее 80 символов');
  if(button)button.disabled=true;
  try{
    const response=await fetch(MILLIONER_API+'/api/market-prices/card-groups/name',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...context,name})});
    const data=await response.json();if(!response.ok||data.ok===false)throw new Error(data.error||('HTTP '+response.status));
    for(const row of priceCache.get(context.market)?.rows||[])if(String(row.groupImtId)===context.groupId)row.groupName=data.name;
    if(priceGroupNameContext===context){priceGroupNameContext=null;closeModal()}
    await window.renderPrices(false);setPriceStatus('Название группы сохранено','ok');
  }catch(error){alert(priceErrorText(error))}finally{if(button)button.disabled=false}
};
function selectedPriceRows(){
  const ids=priceSelection();return activeRows().filter(row=>!row.error&&ids.has(priceSelectionId(row)));
}
function groupPreviewRow(row){
  const image=row?.groupPhoto?'<img src="'+pEsc(row.groupPhoto)+'" alt="">':'<span class="thumb"></span>';
  const group=row?.grouped?(priceGroupLabel(row)+' · '+Number(row.groupSize||0)):'Без группы';
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
  if(selected.length<2)return alert('Выберите минимум 2 карточки.');
  if(selected.length>30)return alert('WB позволяет объединить не более 30 карточек.');
  if(!sameSelectedSubject(selected))return alert('WB разрешает объединять только карточки одного предмета.');
  showSheet('<h3>Объединить · '+selected.length+'</h3>'+
    '<div class="muted">Будет создана новая группа только из выбранных товаров. Они выйдут из текущих групп, а невыбранные товары останутся в своих группах.</div>'+
    '<div class="price-group-preview">'+selected.map(groupPreviewRow).join('')+'</div>'+
    '<div class="actions"><button type="button" class="btn" onclick="closeModal()">Отмена</button><button type="button" class="btn dark" onclick="submitPriceGroupMerge()">Объединить выбранные</button></div>');
};
window.submitPriceGroupMerge=async function(){
  const rows=selectedPriceRows(),ids=rows.map(row=>String(row.remoteId||'')).filter(Boolean);
  if(ids.length<2)return alert('Выберите минимум 2 карточки.');
  if(ids.length>30)return alert('WB позволяет объединить не более 30 карточек.');
  if(!confirm('Создать новую группу WB только из '+ids.length+' выбранных карточек? Невыбранные товары останутся в своих группах.'))return;
  try{
    await remoteGroupMove({market:priceUi.market,remoteIds:ids,createNewGroup:true});
    priceSelection().clear();closeModal();bumpPriceEpoch(priceUi.market);await window.renderPrices(true);
    setPriceStatus('WB создал новую группу только из выбранных карточек и подтвердил её состав','ok');
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
async function remotePromoBulk(remoteIds,enabled){return protectedPriceRequest('/api/market-prices/promo/bulk',{market:priceUi.market,remoteIds,enabled:Boolean(enabled)},'promo');}
window.priceBulkPromo=async function(enabled){
  if(!priceIsWbMarket())return;
  const ids=[...priceSelection()].filter(Boolean);if(!ids.length)return;
  const action=enabled?'добавить в акции':'убрать из акций';
  if(!confirm((enabled?'Добавить в акции ':'Убрать из акций ')+ids.length+' товаров?'))return;
  const enableButton=document.getElementById('priceBulkEnablePromo'),disableButton=document.getElementById('priceBulkDisablePromo');
  if(enableButton)enableButton.disabled=true;if(disableButton)disableButton.disabled=true;
  try{
    const result=await remotePromoBulk(ids,enabled);if(!result){updatePriceBulkTools();return;}const applied=new Set((result.remoteIds||ids).map(String));
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
function priceProtectionDialog(body,blocked,scope){
  return new Promise(resolve=>{
    const dialog=document.createElement('dialog');
    dialog.className='price-protection-confirm';
    dialog.setAttribute('aria-labelledby','priceProtectionTitle');
    dialog.style.cssText='border:0;border-radius:24px;padding:22px;width:calc(100% - 32px);max-width:540px;max-height:85vh;box-sizing:border-box;color:#161616;background:#fff';
    const night=scope==='night',promo=scope==='promo'||body.action==='enter';
    const changes=night?'Ночная цена '+pMoney(body.price,'RUB')+' · '+body.start+'–'+body.end+' · '+priceNightDaysLabel(body.weekdays):promo?'Вход в акцию'+(body.discount!=null?' · скидка '+body.discount+'%':' · подбор условий WB'):body.action==='exit'?'Выход из акции · скидка 0%':[(body.price!=null?'Цена '+pMoney(body.price,'RUB'):''),(body.discount!=null?'Скидка '+body.discount+'%':'')].filter(Boolean).join(' · ');
    dialog.innerHTML='<style>.price-protection-confirm::backdrop{background:rgba(0,0,0,.46)}.price-protection-confirm .price-confirm-actions{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:18px}.price-protection-confirm h3{margin:0 0 10px}.price-protection-confirm .price-confirm-list{max-height:30vh;overflow:auto;margin:14px 0}.price-protection-confirm .price-confirm-item{padding:10px 0;border-bottom:1px solid #eee}</style>'+
      '<h3 id="priceProtectionTitle">Включена защита · '+blocked.length+'</h3><div style="background:#fff7e8;border:1px solid #ebd2a2;border-radius:14px;padding:12px">'+pEsc(changes)+'</div>'+
      '<div class="price-confirm-list">'+blocked.map(row=>'<div class="price-confirm-item"><b>'+pEsc(row.name||row.nmId)+'</b><div class="muted">'+pEsc(row.reason||'Защита цены')+'</div></div>').join('')+'</div>'+
      '<div class="muted">'+(night?'Разрешение действует для этого ночного расписания, включая возврат обычной цены. Защита остальных изменений и блок скидок сохранятся.':promo?'Разрешение действует для выбранных акций. Блок скидок будет снят только у этих товаров; защита обычной цены сохранится.':'Новое значение станет защищённым. Если задана положительная скидка, её блок 0% будет снят только у этих товаров.')+'</div><p style="margin:12px 0 0">Применить поверх защиты? Подтверждая, вы принимаете риск изменения цены.</p>'+
      '<div class="price-confirm-actions"><button type="button" class="btn" data-price-confirm-cancel>Отменить</button><button type="button" class="btn dark" data-price-confirm-apply>Подтвердить</button></div>';
    const finish=value=>{dialog.close();dialog.remove();resolve(value)};
    dialog.querySelector('[data-price-confirm-cancel]').addEventListener('click',()=>finish(false),{once:true});
    dialog.querySelector('[data-price-confirm-apply]').addEventListener('click',()=>finish(true),{once:true});
    dialog.addEventListener('cancel',event=>{event.preventDefault();finish(false)},{once:true});
    document.body.appendChild(dialog);dialog.showModal();dialog.querySelector('[data-price-confirm-cancel]').focus();
  });
}
const priceProtectedRequests=new Map();
async function protectedPriceRequest(path,body,scope){
  const captured=JSON.parse(JSON.stringify(body)),key=path+JSON.stringify(captured);
  if(priceProtectedRequests.has(key))return priceProtectedRequests.get(key);
  const task=(async()=>{
    const send=async payload=>{
      const response=await fetch(MILLIONER_API+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...payload,confirm:true})});
      const text=await response.text();let data;
      try{data=JSON.parse(text)}catch{throw new Error('Сервер цен вернул некорректный ответ')}
      if(!response.ok||data?.ok===false){const error=new Error(data?.error||('HTTP '+response.status));error.status=response.status;error.code=data?.code;error.blocked=data?.blocked;error.skippedDetails=data?.skippedDetails;throw error;}return data;
    };
    try{return await send(captured)}catch(error){
      if(!['PRICE_PROTECTION_CONFIRMATION_REQUIRED','NIGHT_PROTECTION_CONFIRMATION_REQUIRED'].includes(error.code)||!error.blocked?.length)throw error;
      if(!await priceProtectionDialog(captured,error.blocked,scope))return null;
      return send({...captured,overrideProtection:true,overrideRemoteIds:error.blocked.map(row=>String(row.nmId))});
    }
  })();
  priceProtectedRequests.set(key,task);try{return await task}finally{priceProtectedRequests.delete(key)}
}
function showPriceBlockedDetails(rows){
  if(!rows?.length)return;
  showSheet('<h3>Не удалось применить · '+rows.length+'</h3>'+rows.map(row=>'<div class="item"><b>'+pEsc(row.name||row.nmId||row.remoteId)+'</b><div class="muted">'+pEsc(row.reason||row.error)+'</div></div>').join('')+'<button type="button" class="btn full" onclick="closeModal()">Понятно</button>');
}
async function remoteNightSchedule(body){return protectedPriceRequest('/api/market-prices/night-schedule',body,'night');}
function priceNightWeekdays(value){return Array.isArray(value)?value:[1,2,3,4,5,6,7];}
function priceNightDaysLabel(value){const days=priceNightWeekdays(value),names=['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];return days.length===7?'Ежедневно':days.map(day=>names[day-1]).join(', ');}
function priceNightDaysPicker(id,value){
  const selected=priceNightWeekdays(value);
  return '<style>.price-night-days{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:5px}.price-night-day{display:flex;align-items:center;justify-content:center;min-height:42px;border:1px solid #e3e3e3;border-radius:12px;cursor:pointer;font-size:14px;position:relative}.price-night-day:has(input:checked){background:#111;color:#fff;border-color:#111}.price-night-day input{position:absolute;opacity:0;width:1px;height:1px}.price-night-day:focus-within{outline:2px solid #218838;outline-offset:2px}</style><fieldset id="'+id+'" style="border:0;padding:0;margin:10px 0 14px"><legend class="muted" style="margin-bottom:7px">Дни начала · Алматы</legend><div class="price-night-days">'+['Пн','Вт','Ср','Чт','Пт','Сб','Вс'].map((name,i)=>'<label class="price-night-day"><input type="checkbox" value="'+(i+1)+'" '+(selected.includes(i+1)?'checked':'')+' aria-label="'+name+'"><span>'+name+'</span></label>').join('')+'</div><small class="muted">Через полночь — день начала ночи.</small></fieldset>';
}
function readPriceNightWeekdays(id,fallback){const box=document.getElementById(id);return box?[...box.querySelectorAll('input:checked')].map(el=>Number(el.value)):priceNightWeekdays(fallback);}
window.savePriceCardNight=async function(index,enabled){
  const row=activeRows()[Number(index)];
  if(!row||(row.market!=='WB'&&row.market!=='WB2'))return;
  const price=Number(document.getElementById('priceNightCardValue')?.value);
  const box=document.getElementById('priceNightEnabled');
  if(enabled&&!(price>0)){
    if(box)box.checked=false;
    alert('Укажите ночную цену.');
    return;
  }
  const start=String(document.getElementById('priceNightCardStart')?.value||row.nightPriceStart||'04:00'),end=String(document.getElementById('priceNightCardEnd')?.value||row.nightPriceEnd||'06:00');
  const weekdays=readPriceNightWeekdays('priceNightCardDays',row.nightPriceWeekdays);
  if(enabled&&!weekdays.length)return alert('Выберите хотя бы один день недели.');
  try{
    const result=await remoteNightSchedule({market:row.market,remoteIds:[row.remoteId],enabled:Boolean(enabled),start,end,weekdays:weekdays.length?weekdays:priceNightWeekdays(row.nightPriceWeekdays),price:price>0?price:0});
    if(!result){if(box)box.checked=Boolean(row.nightPriceEnabled);return;}
    const schedule=(result.schedules||[]).find(item=>String(item.nmId||'')===String(row.remoteId||''));
    if(!schedule)throw new Error('Расписание не сохранено: товар защищён или недоступен');
    row.nightPriceEnabled=Boolean(schedule.enabled);
    row.nightProtectionOverride=Boolean(schedule.protectionOverride);
    if(schedule){
      row.nightPriceWeekdays=priceNightWeekdays(schedule.weekdays);
      row.nightPriceStart=priceMinuteTime(schedule.startMinute);
      row.nightPriceEnd=priceMinuteTime(schedule.endMinute);
      row.nightPriceTarget=Number(schedule.targetPrice)||null;
      row.nightPricePhase=String(schedule.phase||'');
      row.nightPriceError='';
    }else if(price>0)row.nightPriceTarget=price;
    paintPrices();
    setPriceStatus(enabled?'Ночная цена включена':'Ночной режим выключен','ok');
  }catch(error){
    if(box)box.checked=Boolean(row.nightPriceEnabled);
    if(error.skippedDetails?.length)showPriceBlockedDetails(error.skippedDetails);else alert(priceErrorText(error));
  }
};
window.openPriceNightSchedule=function(){
  if(!priceIsWbMarket())return;
  const ids=[...priceSelection()].filter(Boolean);if(!ids.length)return;
  const selectedRows=activeRows().filter(row=>ids.includes(String(row.remoteId||'')));
  const configured=selectedRows.filter(row=>row.nightPriceEnabled);
  const first=configured[0]||selectedRows[0]||{};
  nightWorkbench={market:priceUi.market,ids:[...ids]};
  const start=String(first.nightPriceStart||'04:00'),end=String(first.nightPriceEnd||'06:00'),price=pNum(first.nightPriceTarget)||'';
  const activeCount=configured.length;
  showSheet('<div class="price-night-sheet"><h3>Ночная цена · '+ids.length+'</h3>'+
    '<div class="muted">Время Алматы · возврат к своей обычной цене</div><div class="two"><div class="field"><label>С</label><input id="priceNightStart" type="time" value="'+pEsc(start)+'"></div>'+
    '<div class="field"><label>До</label><input id="priceNightEnd" type="time" value="'+pEsc(end)+'"></div></div>'+
    priceNightDaysPicker('priceNightDays',first.nightPriceWeekdays)+
    '<div class="field"><label>Ночная цена до скидки, ₽</label><input id="priceNightValue" type="number" min="1" step="1" inputmode="decimal" value="'+pEsc(price)+'"></div>'+
    '<div class="actions"><button type="button" class="btn" onclick="savePriceNightSchedule(false)" '+(activeCount?'':'disabled')+'>Выключить</button>'+
    '<button type="button" class="btn dark" onclick="savePriceNightSchedule(true)">Сохранить</button></div></div>');
};
window.savePriceNightSchedule=async function(enabled){
  const ctx=nightWorkbench;if(!ctx)return;
  const ids=ctx.ids;if(!ids.length)return;
  const start=String(document.getElementById('priceNightStart')?.value||'04:00');
  const end=String(document.getElementById('priceNightEnd')?.value||'06:00');
  const price=Number(document.getElementById('priceNightValue')?.value);
  if(enabled&&(!/^\d{2}:\d{2}$/.test(start)||!/^\d{2}:\d{2}$/.test(end)||start===end))return alert('Укажите корректное время.');
  if(enabled&&!(price>0))return alert('Укажите цену больше 0.');
  const weekdays=readPriceNightWeekdays('priceNightDays');
  if(enabled&&!weekdays.length)return alert('Выберите хотя бы один день недели.');
  try{
    const result=await remoteNightSchedule({market:ctx.market,remoteIds:ids,enabled:Boolean(enabled),start,end,price,...(weekdays.length?{weekdays}:{})});
    if(!result)return;
    const schedules=result.schedules||[],applied=new Set(schedules.map(row=>String(row.nmId)));
    for(const id of applied)priceSelection(ctx.market).delete(id);
    closeModal();bumpPriceEpoch(ctx.market);
    if(priceUi.market===ctx.market){await window.renderPrices(true);setPriceStatus((enabled?'Ночь сохранена':'Ночь выключена')+' · '+applied.size+' · пропущено '+(ids.length-applied.size),'ok');}
    if(result.skippedDetails?.length)showPriceBlockedDetails(result.skippedDetails);
  }catch(error){if(error.skippedDetails?.length)showPriceBlockedDetails(error.skippedDetails);else alert(priceErrorText(error))}
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
  if(!same&&priceIsWbMarket(row.market))loadPriceProfit(row.market);
  if(!same)setTimeout(()=>document.querySelector('[data-price-row="'+Number(index)+'"] .price-inline-editor input:not([disabled])')?.focus(),0);
};
window.collapsePriceEditor=function(){
  if(!priceExpanded)return;
  priceExpanded=null;paintPrices();
};

async function remotePromoToggle(body){return protectedPriceRequest('/api/market-prices/promo',body,'promo');}
window.togglePricePromo=async function(index,enabled){
  const row=activeRows()[Number(index)];if(!row||(row.market!=='WB'&&row.market!=='WB2'))return;
  const checkbox=document.querySelector('[data-price-row="'+Number(index)+'"] .price-promo-toggle input');
  if(checkbox)checkbox.disabled=true;
  try{
    const result=await remotePromoToggle({market:row.market,remoteId:row.remoteId,enabled:Boolean(enabled)});
    if(!result){paintPrices();return;}
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
  const workbench=priceIsWbMarket(body.market);
  if(workbench)body={...body,remoteIds:[body.remoteId],action:'price'};
  const data=await protectedPriceRequest('/api/market-prices/update'+(workbench?'/bulk':''),body,'price');
  if(!data)return null;
  if(workbench&&!data.applied?.length)throw new Error(data.skipped?.[0]?.error||'Изменение не сохранено');
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
      if(priceChanged)body.price=enteredPrice;
      if(discountChanged)body.discount=enteredDiscount;
      const result=await remotePriceUpdate(body);if(!result)return;
      if(priceChanged){row.nightBasePrice=enteredPrice;row.price=enteredPrice;row.priceMax=enteredPrice;row.finalPrice=enteredPrice*(1-enteredDiscount/100);row.finalPriceMax=row.finalPrice}
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
