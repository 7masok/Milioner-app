(function(){
'use strict';

const PRICE_UI_KEY=(typeof KEY==='string'?KEY:'sklad_mvp_v2')+'_prices_ui_v1';
const PRICE_MARKETS=['Kaspi','WB','WB2','Ozon'];
let priceUi={market:'Kaspi',q:''};
try{
  const saved=JSON.parse(localStorage.getItem(PRICE_UI_KEY)||'{}')||{};
  if(PRICE_MARKETS.includes(saved.market))priceUi.market=saved.market;
  priceUi.q=String(saved.q||'');
}catch{}
const priceCache=new Map();
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
}
function priceErrorText(error){
  const text=String(error?.message||error||'Не удалось загрузить цены');
  if((priceUi.market==='WB'||priceUi.market==='WB2')&&/403|доступ|forbidden/i.test(text)){
    return 'Токен '+marketLabel(priceUi.market)+' не имеет доступа к категории «Цены и скидки» WB. Добавьте это право у API-ключа и обновите.';
  }
  return text;
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
  const visible=rows.filter(row=>{
    if(!q)return true;
    return [row.name,row.sku,row.remoteId,row.account].some(value=>String(value||'').toLocaleLowerCase('ru-RU').includes(q));
  });
  const valid=rows.filter(row=>!row.error),withDiscount=valid.filter(row=>priceDiscountValue(row)>0).length,noPrice=valid.filter(row=>!(pNum(row.price)>0||pNum(row.finalPrice)>0)).length;
  const count=document.getElementById('pricePositionCount'),discount=document.getElementById('priceDiscountCount'),missing=document.getElementById('priceMissingCount');
  if(count)count.textContent=valid.length.toLocaleString('ru-RU');
  if(discount)discount.textContent=withDiscount.toLocaleString('ru-RU');
  if(missing)missing.textContent=noPrice.toLocaleString('ru-RU');
  const list=document.getElementById('priceList');if(!list)return;
  if(!rows.length){list.innerHTML='<div class="empty">Нет позиций для этого магазина</div>';return;}
  if(!visible.length){list.innerHTML='<div class="empty">Поиск ничего не нашёл</div>';return;}
  list.innerHTML=visible.map(row=>priceCard(row,rows.indexOf(row))).join('');
}
async function priceFetch(market,force=false){
  const url=MILLIONER_API+'/api/market-prices?market='+encodeURIComponent(market)+(force?'&force=1':'');
  const response=await fetch(url,{cache:'no-store'});
  const data=await response.json().catch(()=>({}));
  if(!response.ok||data?.ok===false)throw new Error(data?.error||('HTTP '+response.status));
  return data;
}

window.renderPrices=async function(force=false){
  const view=document.getElementById('prices');if(!view||!view.classList.contains('active'))return;
  setPriceTabs();
  const seq=++priceLoadSeq,existing=priceCache.get(priceUi.market);
  if(existing&&!force){paintPrices();setPriceStatus('Обновлено '+new Date(existing.fetchedAt||Date.now()).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'}));return;}
  const list=document.getElementById('priceList');
  if(list&&!existing)list.innerHTML='<div class="empty">Загружаю цены…</div>';
  setPriceStatus('обновляю…','loading');
  try{
    const data=await priceFetch(priceUi.market,force);
    if(seq!==priceLoadSeq)return;
    priceCache.set(priceUi.market,data);
    paintPrices();
    const when=Number(data.fetchedAt||Date.now());
    setPriceStatus('Обновлено '+new Date(when).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'}),'ok');
  }catch(error){
    if(seq!==priceLoadSeq)return;
    const message=priceErrorText(error);
    setPriceStatus(message,'bad');
    if(list&&!existing)list.innerHTML='<div class="empty">'+pEsc(message)+'</div><button type="button" class="btn full" onclick="priceRefresh()">Повторить</button>';
  }
};
window.priceSetMarket=function(market){
  if(!PRICE_MARKETS.includes(market)||market===priceUi.market)return;
  priceUi.market=market;rememberPriceUi();setPriceTabs();window.renderPrices(false);
};
window.priceSearch=function(value){
  priceUi.q=String(value||'');rememberPriceUi();paintPrices();
};
window.priceRefresh=function(){
  priceCache.delete(priceUi.market);return window.renderPrices(true);
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
  const data=await response.json().catch(()=>({}));
  if(!response.ok||data?.ok===false)throw new Error(data?.error||('HTTP '+response.status));
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
      if(typeof pushWarehouseToServer==='function')await pushWarehouseToServer();
      row.price=price;row.finalPrice=price;row.source='warehouse';
      closeModal();paintPrices();setPriceStatus('Цена Kaspi сохранена · XML обновлён','ok');
      return;
    }
    if(row.market==='WB'||row.market==='WB2'){
      const price=row.canEditPrice===false?null:inputNumber('priceEditCurrent');
      const discount=inputNumber('priceEditDiscount');
      if(row.canEditPrice!==false&&!(price>0))throw new Error('Введите цену больше 0');
      if(!Number.isInteger(discount)||discount<0||discount>99)throw new Error('Скидка должна быть целым числом от 0 до 99');
      const question='Отправить в '+marketLabel(row.market)+' цену '+(row.canEditPrice===false?'без изменения':pMoney(price,row.currency))+' и скидку '+discount+'%?';
      if(!confirm(question))return;
      await remotePriceUpdate({market:row.market,remoteId:row.remoteId,price,discount});
      if(price)row.price=price;
      row.discount=discount;
      if(price)row.finalPrice=price*(1-discount/100);
      priceCache.delete(row.market);
      closeModal();setPriceStatus('Изменение отправлено в '+marketLabel(row.market)+'. Обновите через несколько минут.','ok');
      return;
    }
    if(row.market==='Ozon'){
      const price=inputNumber('priceEditCurrent'),oldPrice=inputNumber('priceEditOld');
      if(!(price>0))throw new Error('Введите цену больше 0');
      if(Number.isFinite(oldPrice)&&oldPrice>0&&oldPrice<=price)throw new Error('Цена до скидки должна быть выше текущей цены или 0');
      if(!confirm('Отправить новую цену Ozon для «'+String(row.name||row.sku)+'»?'))return;
      await remotePriceUpdate({market:'Ozon',accountId:row.accountId,sku:row.sku,price,oldPrice:Number.isFinite(oldPrice)?Math.max(0,oldPrice):0,minPrice:row.minPrice,currency:row.currency});
      row.price=price;row.finalPrice=price;row.oldPrice=Number.isFinite(oldPrice)?Math.max(0,oldPrice):0;
      priceCache.delete('Ozon');
      closeModal();setPriceStatus('Цена отправлена в Ozon. Нажмите ↻ для проверки.','ok');
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