// Keep the original Kaspi Ads module intact; load it from the preserved blob copy.
(function(){
  const s=document.createElement('script');
  s.src='./kaspi-ads-v2-original.js?v=20260820-low-stock-alerts';
  s.async=false;
  document.head.appendChild(s);
})();

/* one-day stock alerts + guided inventory */
(function(){
'use strict';
const ALERT_DAYS=1.15;
const COVER_DAYS=25;
let lastSignature='';

function safeNum(v){const n=Number(v);return Number.isFinite(n)?n:0}
function escText(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function serverReady(){try{return typeof warehouseRemoteReady!=='undefined'&&warehouseRemoteReady}catch{return false}}
function products(){try{return typeof stockProducts==='function'?stockProducts():Array.isArray(state?.products)?state.products:[]}catch{return []}}
function isBundle(p){try{return typeof isBundleProduct==='function'&&isBundleProduct(p)}catch{return false}}
function activeReserved(p){try{return Math.max(0,safeNum(reserved(p)))}catch{return 0}}
function availableStock(p){try{return Math.max(0,safeNum(productAvailableStock(p)))}catch{return Math.max(0,safeNum(p?.stock)-activeReserved(p))}}
function atWarehouse(pid){try{return Math.max(0,safeNum(purchaseAtWarehouseQty(pid)))}catch{return 0}}
function inbound(pid){try{return Math.max(0,safeNum(purchaseInboundQty(pid)))}catch{return 0}}
function demand(p,days){try{return Math.max(0,safeNum(purchaseDemandQty(p,days)))}catch{return 0}}
function lastUnitCost(pid){try{return Math.max(0,safeNum(purchaseLastUnitCost(pid)))}catch{return 0}}

function stockAlertFor(p){
  if(!p||isBundle(p))return null;
  const d7=demand(p,7)/7,d25=demand(p,25)/25,daily=Math.max(d7,d25);
  if(!(daily>0))return null;
  const available=availableStock(p),days=available/daily;
  if(days>ALERT_DAYS)return null;
  const warehouse=atWarehouse(p.id),coming=inbound(p.id),book=Math.max(0,safeNum(p.stock)),reserve=activeReserved(p);
  const target=Math.ceil(daily*COVER_DAYS);
  const buyQty=Math.max(0,target-available-warehouse-coming);
  return {p,daily,available,days,warehouse,coming,book,reserve,buyQty,target};
}
function currentAlerts(){return products().map(stockAlertFor).filter(Boolean).sort((a,b)=>a.days-b.days||b.daily-a.daily||String(a.p.name).localeCompare(String(b.p.name),'ru'))}
function dayText(x){if(!Number.isFinite(x))return '—';if(x<=0)return 'закончился';if(x<0.1)return '< 0,1 дня';return x.toFixed(1).replace('.',',')+' дня'}

function ensureStyle(){
  if(document.getElementById('stockAlertStyle'))return;
  const st=document.createElement('style');st.id='stockAlertStyle';st.textContent=`
  .stock-alert-button{position:relative;min-width:44px;height:44px;padding:0 12px;font-size:20px;display:inline-flex;align-items:center;justify-content:center}
  .stock-alert-count{position:absolute;right:-4px;top:-5px;min-width:19px;height:19px;padding:0 5px;border-radius:12px;background:#c62828;color:#fff;font:800 11px/19px system-ui;text-align:center;border:2px solid #fff}
  .stock-alert-card{border-left:4px solid #c62828;cursor:pointer}.stock-alert-card+.stock-alert-card{margin-top:8px}
  .stock-alert-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;margin-top:10px}.stock-alert-mini{background:#f6f7f8;border-radius:11px;padding:9px}
  .inventory-diff-note{margin:10px 0;padding:11px;border-radius:12px;background:#f6f7f8;line-height:1.45}.inventory-diff-note.bad{background:#fff1f1;color:#9d1717}.inventory-diff-note.ok{background:#edf8ef;color:#196b2b}
  `;document.head.appendChild(st);
}
function ensureBell(){
  ensureStyle();
  const head=document.querySelector('header .headrow');if(!head)return null;
  let btn=document.getElementById('stockAlertBell');if(btn)return btn;
  btn=document.createElement('button');btn.id='stockAlertBell';btn.type='button';btn.className='btn stock-alert-button';btn.innerHTML='◉<span id="stockAlertCount" class="stock-alert-count" hidden>0</span>';btn.title='Товары, которые заканчиваются';btn.onclick=()=>window.openStockAlerts?.();
  const sync=head.querySelector('button[onclick*="syncNow"]')||head.querySelector('button:last-child');
  if(sync)head.insertBefore(btn,sync);else head.appendChild(btn);
  return btn;
}
function paintBell(){
  const btn=ensureBell();if(!btn)return;
  const alerts=currentAlerts(),badge=document.getElementById('stockAlertCount');
  if(badge){badge.textContent=String(alerts.length);badge.hidden=!alerts.length}
  btn.style.display=alerts.length?'inline-flex':'none';
  const sig=alerts.map(x=>`${x.p.id}:${x.available}:${x.daily.toFixed(2)}`).join('|');
  if(sig!==lastSignature){lastSignature=sig;btn.animate?.([{transform:'scale(1)'},{transform:'scale(1.08)'},{transform:'scale(1)'}],{duration:260})}
}

function alertCard(x){
  const action=x.warehouse>0?`На складе ждёт ввода в продажу: <b>${x.warehouse} шт.</b>`:x.buyQty>0?`Рекомендуется закупить примерно <b>${x.buyQty} шт.</b>`:'Поставка уже в пути';
  return `<div class="item stock-alert-card" onclick="openStockAlertProduct('${String(x.p.id).replace(/'/g,"\\'")}')">
    <div class="row"><div class="grow"><div class="name">${escText(x.p.name)}</div><div class="muted">Запаса к продаже осталось примерно на ${dayText(x.days)}</div></div><span class="badge bad">${x.available} шт.</span></div>
    <div class="stock-alert-grid">
      <div class="stock-alert-mini"><div class="label">По учёту в продаже</div><b>${x.book} шт.</b></div>
      <div class="stock-alert-mini"><div class="label">В резерве</div><b>${x.reserve} шт.</b></div>
      <div class="stock-alert-mini"><div class="label">Темп продаж</div><b>${x.daily.toFixed(1)} шт./день</b></div>
      <div class="stock-alert-mini"><div class="label">В пути</div><b>${x.coming} шт.</b></div>
    </div><div class="muted" style="margin-top:9px">${action}. Нажмите, чтобы пересчитать товар и начать инвентаризацию.</div>
    <div class="actions" onclick="event.stopPropagation()">
      ${x.warehouse>0?`<button class="btn" onclick="openStockAlertWarehouse('${String(x.p.id).replace(/'/g,"\\'")}')">Со склада</button>`:''}
      <button class="btn" onclick="openStockAlertPurchase('${String(x.p.id).replace(/'/g,"\\'")}')">Закупить</button>
      <button class="btn dark" onclick="openStockAlertProduct('${String(x.p.id).replace(/'/g,"\\'")}')">Пересчитать</button>
    </div>
  </div>`;
}
window.openStockAlerts=function(){
  const alerts=currentAlerts();
  if(!alerts.length)return alert('Сейчас нет товаров с запасом примерно на один день.');
  showSheet(`<h3>Нужно проверить остаток · ${alerts.length}</h3><div class="link-note">Тревога считается по реальным заказам за 7 и 25 дней. Берётся более высокий среднесуточный темп. Остаток — свободное количество после активного резерва. Перед закупкой лучше физически пересчитать товар.</div>${alerts.map(alertCard).join('')}`);
};
function findProduct(pid){try{return prod(pid)}catch{return products().find(p=>String(p.id)===String(pid))||null}}
function focusProduct(pid){
  const p=findProduct(pid);if(!p)return false;
  openView('products',true);
  const q=document.getElementById('q'),filter=document.getElementById('filter');
  if(q)q.value=String(p.name||'');if(filter)filter.value='all';
  try{productPage=1}catch{}
  try{render()}catch{}
  setTimeout(()=>document.getElementById('productList')?.scrollIntoView({behavior:'smooth',block:'start'}),80);
  return true;
}
function decorateInventory(pid){
  const p=findProduct(pid),input=document.getElementById('iq');if(!p||!input)return;
  const expected=Math.max(0,safeNum(p.stock)),reserve=activeReserved(p),available=availableStock(p),warehouse=atWarehouse(pid);
  let note=document.getElementById('inventoryExpectedNote');if(!note){note=document.createElement('div');note.id='inventoryExpectedNote';note.className='inventory-diff-note';input.closest('.two')?.insertAdjacentElement('afterend',note)}
  const update=()=>{const actual=Math.max(0,safeNum(input.value)),diff=actual-expected;note.className='inventory-diff-note '+(diff===0?'ok':'bad');note.innerHTML=`<b>Проверка учёта</b><br>По системе: ${expected} шт. · резерв ${reserve} шт. · свободно ${available} шт.${warehouse?` · отдельно на складе ${warehouse} шт.`:''}<br><b>${diff===0?'Совпадает с учётом':`Расхождение: ${diff>0?'+':''}${diff} шт.`}</b>`};
  input.addEventListener('input',update);update();input.focus();input.select();
}
window.openStockAlertProduct=function(pid){
  if(!serverReady())return alert('Сейчас показаны последние данные. Дождитесь статуса «онлайн», чтобы инвентаризация не изменила склад до проверки сервера.');
  closeModal();if(!focusProduct(pid))return;
  setTimeout(()=>{openModal('inventory',pid);setTimeout(()=>decorateInventory(pid),30)},130);
};
window.openStockAlertWarehouse=function(pid){
  if(!serverReady())return alert('Дождитесь статуса «онлайн».');
  closeModal();focusProduct(pid);setTimeout(()=>openProductWarehouseRelease(pid),120);
};
window.openStockAlertPurchase=function(pid){
  if(!serverReady())return alert('Дождитесь статуса «онлайн».');
  const x=stockAlertFor(findProduct(pid));if(!x)return;
  const qty=Math.max(1,x.buyQty||Math.ceil(x.daily*COVER_DAYS));
  window.pendingPurchaseRecommendations=[{productId:pid,qty,unitCost:lastUnitCost(pid)}];
  window.pendingPurchaseHint=`Запас примерно на ${dayText(x.days)}; цель — около ${COVER_DAYS} дней.`;
  closeModal();openView('purchases',true);setTimeout(()=>openModal('purchase'),100);
};

function start(){ensureBell();paintBell();setInterval(paintBell,30000);document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')setTimeout(paintBell,300)});window.addEventListener('focus',()=>setTimeout(paintBell,300));}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
setTimeout(paintBell,1800);setTimeout(paintBell,5000);
})();
