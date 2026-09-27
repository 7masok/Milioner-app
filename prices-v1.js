(function(){
'use strict';

const PRICE_UI_KEY=(typeof KEY==='string'?KEY:'sklad_mvp_v2')+'_prices_ui_v1';
const PRICE_MARKETS=['Kaspi','WB','WB2','Ozon'];
const PRICE_CLIENT_TTL_MS=2*60*1000;
let priceUi={market:'Kaspi',q:'',sort:'asc'};
try{
  const saved=JSON.parse(localStorage.getItem(PRICE_UI_KEY)||'{}')||{};
  if(PRICE_MARKETS.includes(saved.market))priceUi.market=saved.market;
  priceUi.q=String(saved.q||'');
  if(saved.sort==='desc'||saved.sort==='asc')priceUi.sort=saved.sort;
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
function activeRows(){
  return Array.isArray(priceCache.get(priceUi.market)?.rows)?priceCache.get(priceUi.market).rows:[];
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
}
function priceRetryLabel(retryAt){
  const ts=Number(retryAt)||0;
  return ts>Date.now()?new Date(ts).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'}):'через несколько секунд';
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
function priceCard(row,index){
  if(row?.error){
    return '<div class="item price-item"><div class="name">'+pEsc(row.account||'Ozon')+'</div><div class="muted price-error">'+pEsc(row.error)+'</div></div>';
  }
  const discount=priceDiscountValue(row),linked=row.linked!==false;
  const account=row.account&&row.account!==marketLabel(row.market)?'<span>'+pEsc(row.account)+'</span>':'';
  let lines='';
  if(row.market==='WB'||row.market==='WB2'){
    lines='<span>Цена: <b>'+pRange(row.price,row.priceMax,row.currency)+'</b></span>'+
      '<span>Скидка: <b>'+(discount?discount+'%':'0%')+'</b></span>'+
      '<span>После скидки: <b>'+pRange(row.finalPrice,row.finalPriceMax,row.currency)+'</b></span>'+
      (pNum(row.clubFinalPrice)>0?'<span>WB Клуб: <b>'+pMoney(row.clubFinalPrice,row.currency)+'</b></span>':'');
  }else if(row.market==='Ozon'){
    lines='<span>Цена: <b>'+pMoney(row.price,row.currency)+'</b></span>'+
      '<span>Скидка: <b>'+(discount?discount+'%':'0%')+'</b></span>'+
      '<span>Со скидкой: <b>'+pMoney(row.finalPrice||row.price,row.currency)+'</b></span>'+
      (pNum(row.oldPrice)>0?'<span>Старая цена: <b>'+pMoney(row.oldPrice,row.currency)+'</b></span>':'');
  }else{
    lines='<span>Цена: <b>'+pMoney(row.price,row.currency)+'</b></span>'+
      '<span>Скидка: <b>—</b></span>';
  }
  return '<button type="button" class="item price-item '+(!linked?'unlinked':'')+'" data-price-row="'+index+'" onclick="openPriceEditor('+index+')">'+
    '<div class="price-item-head"><div class="grow"><div class="name">'+pEsc(row.name||row.sku||'Товар')+'</div>'+
    '<div class="muted">'+pEsc(account?(row.account+' · '):'')+pEsc(row.sku?('Арт. '+row.sku):row.remoteId||'')+(linked?'':' · не привязан к товару склада')+'</div></div><span class="price-chevron">›</span></div>'+
    '<div class="price-values">'+lines+'</div></button>';
}
function paintPrices(){
  setPriceTabs();
  const rows=activeRows(),q=priceUi.q.trim().toLocaleLowerCase('ru-RU');
  const indexed=rows.map((row,index)=>({row,index})).filter(({row})=>{
    if(!q)return true;
    return [row.name,row.sku,row.remoteId,row.account].some(value=>String(value||'').toLocaleLowerCase('ru-RU').includes(q));
  }).sort((a,b)=>{
    const av=priceSortValue(a.row),bv=priceSortValue(b.row),aMissing=!(av>0),bMissing=!(bv>0);
    if(aMissing!==bMissing)return aMissing?1:-1;
    if(!aMissing&&Math.abs(av-bv)>.000001)return priceUi.sort==='desc'?bv-av:av-bv;
    const byName=String(a.row?.name||a.row?.sku||'').localeCompare(String(b.row?.name||b.row?.sku||''),'ru',{sensitivity:'base'});
    return byName||a.index-b.index;
  });
  const valid=rows.filter(row=>!row.error),withDiscount=valid.filter(row=>priceDiscountValue(row)>0).length,noPrice=valid.filter(row=>!(pNum(row.price)>0||pNum(row.finalPrice)>0)).length;
  const count=document.getElementById('pricePositionCount'),discount=document.getElementById('priceDiscountCount'),missing=document.getElementById('priceMissingCount');
  if(count)count.textContent=valid.length.toLocaleString('ru-RU');
  if(discount)discount.textContent=withDiscount.toLocaleString('ru-RU');
  if(missing)missing.textContent=noPrice.toLocaleString('ru-RU');
  const list=document.getElementById('priceList');if(!list)return;
  if(!rows.length){
    const failure=priceErrors.get(priceUi.market);
    if(failure){priceRenderError(failure.message);return;}
    list.innerHTML='<div class="empty">Нет позиций для этого магазина</div>';return;
  }
  if(!indexed.length){list.innerHTML='<div class="empty">Поиск ничего не нашёл</div>';return;}
  list.innerHTML=indexed.map(({row,index})=>priceCard(row,index)).join('');
}

async function priceFetch(market,force=false){
  const epoch=priceEpochValue(market),key=market+':'+epoch;
  const running=priceFetchInFlight.get(key);if(running)return running;
  const task=(async()=>{
    const url=MILLIONER_API+'/api/market-prices?market='+encodeURIComponent(market)+(force?'&force=1':'');
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
    setPriceStatus('Обновлено '+new Date(existing.fetchedAt||Date.now()).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'}),'ok');
    return;
  }
  const cooldown=Number(priceCooldowns.get(market)||0);
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
    const when=Number(data.fetchedAt||Date.now()),stamp=new Date(when).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'});
    if(data.stale){
      const message='Не удалось обновить. Показаны данные на '+stamp+(Number(data.retryAt)>Date.now()?'. Следующая попытка '+priceRetryLabel(data.retryAt):'.');
      setPriceStatus(message,'warn');
    }else setPriceStatus('Обновлено '+stamp,'ok');
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
  priceUi.market=market;rememberPriceUi();setPriceTabs();window.renderPrices(false);
};
window.priceSearch=function(value){
  priceUi.q=String(value||'');rememberPriceUi();paintPrices();
};
window.priceToggleSort=function(){
  priceUi.sort=priceUi.sort==='desc'?'asc':'desc';rememberPriceUi();setPriceTabs();paintPrices();
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
  window.__priceEditRow=row;
  if(row.market==='Kaspi'){
    showSheet('<h3>Цена · Kaspi</h3><div class="item"><b>'+pEsc(row.name)+'</b><div class="muted">Арт. '+pEsc(row.sku)+'</div></div>'+
      '<div class="field"><label>Цена, ₸</label><input id="priceEditCurrent" type="number" min="1" step="1" inputmode="decimal" value="'+pEsc(pNum(row.price)||'')+'"></div>'+
      '<div class="link-note">Цена сохраняется в складе и попадает в XML-прайс Kaspi. Отдельной процентной скидки в нашем прайс-листе Kaspi нет.</div>'+
      '<button class="btn dark full" onclick="submitPriceEdit()">Сохранить цену</button>');
    return;
  }
  if(row.market==='WB'||row.market==='WB2'){
    const priceDisabled=row.canEditPrice===false;
    showSheet('<h3>Цена и скидка · '+pEsc(marketLabel(row.market))+'</h3><div class="item"><b>'+pEsc(row.name)+'</b><div class="muted">Арт. '+pEsc(row.sku)+' · nmID '+pEsc(row.remoteId)+'</div></div>'+
      '<div class="field"><label>Цена до скидки, '+pEsc(row.currency||'RUB')+'</label><input id="priceEditCurrent" type="number" min="1" step="1" inputmode="decimal" value="'+pEsc(pNum(row.price)||'')+'" '+(priceDisabled?'disabled':'')+'></div>'+
      (priceDisabled?'<div class="link-note">У товара разные цены по размерам. Чтобы не перезаписать их одной суммой, здесь можно менять только общую скидку.</div>':'')+
      '<div class="field"><label>Скидка, %</label><input id="priceEditDiscount" type="number" min="0" max="99" step="1" inputmode="numeric" value="'+pEsc(Math.round(pNum(row.discount)))+'"></div>'+
      '<div class="link-note">Изменение отправляется напрямую в WB после подтверждения. WB может применить его не мгновенно; резкое снижение цены может попасть на дополнительную проверку.</div>'+
      '<button class="btn dark full" onclick="submitPriceEdit()">Отправить в WB</button>');
    return;
  }
  if(row.market==='Ozon'){
    showSheet('<h3>Цена и скидка · Ozon</h3><div class="item"><b>'+pEsc(row.name)+'</b><div class="muted">'+pEsc(row.account||'Ozon')+' · '+pEsc(row.sku)+'</div></div>'+
      '<div class="field"><label>Текущая цена, '+pEsc(row.currency||'RUB')+'</label><input id="priceEditCurrent" type="number" min="1" step="1" inputmode="decimal" value="'+pEsc(pNum(row.price)||'')+'"></div>'+
      '<div class="field"><label>Цена до скидки</label><input id="priceEditOld" type="number" min="0" step="1" inputmode="decimal" value="'+pEsc(pNum(row.oldPrice)||'')+'"></div>'+
      '<div class="link-note">Скидка Ozon здесь рассчитывается из «цены до скидки» и текущей цены. Минимальная цена товара сохраняется без изменения.</div>'+
      '<button class="btn dark full" onclick="submitPriceEdit()">Отправить в Ozon</button>');
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
window.submitPriceEdit=async function(){
  const row=window.__priceEditRow;if(!row)return;
  const button=document.querySelector('#sheet .btn.dark.full');if(button){button.disabled=true;button.textContent='Сохраняю…';}
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
      closeModal();paintPrices();
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
      if(!priceChanged&&!discountChanged)throw new Error('Цена и скидка не изменились');
      const changes=[];
      if(priceChanged)changes.push('цену на '+pMoney(enteredPrice,row.currency));
      if(discountChanged)changes.push('скидку на '+enteredDiscount+'%');
      const question='Отправить в '+marketLabel(row.market)+' '+changes.join(' и ')+'?';
      if(!confirm(question))return;
      const body={market:row.market,remoteId:row.remoteId};
      if(priceChanged)body.price=enteredPrice;
      if(discountChanged)body.discount=enteredDiscount;
      const result=await remotePriceUpdate(body);
      if(priceChanged){row.price=enteredPrice;row.finalPrice=enteredPrice*(1-enteredDiscount/100)}
      if(discountChanged){row.discount=enteredDiscount;if(!priceChanged&&pNum(row.price)>0)row.finalPrice=pNum(row.price)*(1-enteredDiscount/100)}
      bumpPriceEpoch(row.market);
      const cached=priceCache.get(row.market);if(cached){cached.stale=true;cached.fetchedAt=Number(cached.fetchedAt)||Date.now()}
      closeModal();paintPrices();
      setPriceStatus('WB принял изменение'+(result.uploadId?' · операция '+result.uploadId:'')+'. Применение может занять несколько минут.','ok');
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
      closeModal();paintPrices();setPriceStatus('Ozon подтвердил обновление цены. Нажмите ↻ для проверки.','ok');
    }
  }catch(error){
    alert(priceErrorText(error));
  }finally{
    if(button){button.disabled=false;button.textContent=row.market==='Kaspi'?'Сохранить цену':row.market==='Ozon'?'Отправить в Ozon':'Отправить в WB';}
  }
};

window.priceTabRestore=function(){
  setPriceTabs();
  const input=document.getElementById('priceSearch');if(input)input.value=priceUi.q;
};
window.priceTabRestore();
})();