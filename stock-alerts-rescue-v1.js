(function(){
'use strict';
const ALERT_DAYS=1.15;
const COVER_DAYS=25;
const LEGACY_HIDDEN_KEY='milioner_low_stock_hidden_v1';
const LOCAL_SEEN_KEY='milioner_low_stock_seen_v1';
const SHARED_HIDDEN_KEY='stockAlertDismissals';
const SHARED_SEEN_KEY='stockAlertAcknowledged';
let lastSignature='';
let legacyHiddenMigrated=false;

function safeNum(v){const n=Number(v);return Number.isFinite(n)?n:0}
function escText(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot',"'":'&#39;'}[c]))}
function serverReady(){try{return typeof warehouseRemoteReady!=='undefined'&&warehouseRemoteReady}catch{return false}}
function products(){try{return typeof stockProducts==='function'?stockProducts():Array.isArray(state?.products)?state.products:[]}catch{return []}}
function isBundle(p){try{return typeof isBundleProduct==='function'&&isBundleProduct(p)}catch{return false}}
function activeReserved(p){try{return Math.max(0,safeNum(reserved(p)))}catch{return 0}}
function availableStock(p){try{return Math.max(0,safeNum(productAvailableStock(p)))}catch{return Math.max(0,safeNum(p?.stock)-activeReserved(p))}}
function atWarehouse(pid){try{return Math.max(0,safeNum(purchaseAtWarehouseQty(pid)))}catch{return 0}}
function inbound(pid){try{return Math.max(0,safeNum(purchaseInboundQty(pid)))}catch{return 0}}
function demand(p,days){try{return Math.max(0,safeNum(purchaseDemandQty(p,days)))}catch{return 0}}
function lastUnitCost(pid){try{return Math.max(0,safeNum(purchaseLastUnitCost(pid)))}catch{return 0}}
function readLocalMap(key){try{const x=JSON.parse(localStorage.getItem(key)||'{}');return x&&typeof x==='object'&&!Array.isArray(x)?x:{}}catch{return {}}}
function writeLocalMap(key,value){try{localStorage.setItem(key,JSON.stringify(value||{}))}catch{}}
function sharedSettings(){try{return state&&state.settings&&typeof state.settings==='object'?state.settings:null}catch{return null}}
function readSharedMap(key){const value=sharedSettings()?.[key];return value&&typeof value==='object'&&!Array.isArray(value)?value:{}}
function writeSharedMap(key,value){const settings=sharedSettings();if(!settings)return false;settings[key]=value;try{if(typeof save==='function')save()}catch{}return true}
function readHidden(){return {...readLocalMap(LEGACY_HIDDEN_KEY),...readSharedMap(SHARED_HIDDEN_KEY)}}
function alertFingerprint(x){return [x.p.id,x.available,x.book,x.reserve,x.daily.toFixed(4),x.warehouse,x.coming,x.buyQty].join('|')}
function wasSeen(x,seen){const value=seen[String(x.p.id)];return value===alertFingerprint(x)||value?.fingerprint===alertFingerprint(x)}
function migrateLegacyHidden(){if(legacyHiddenMigrated)return;const legacy=readLocalMap(LEGACY_HIDDEN_KEY),ids=Object.keys(legacy),settings=sharedSettings();if(!ids.length||!settings)return;const shared=readSharedMap(SHARED_HIDDEN_KEY),next={...shared};let changed=false;for(const id of ids)if(!next[id]){next[id]=legacy[id];changed=true}legacyHiddenMigrated=true;if(changed)writeSharedMap(SHARED_HIDDEN_KEY,next)}
function acknowledgeAlerts(alerts){if(!alerts?.length)return;const seen=readSharedMap(SHARED_SEEN_KEY),next={...seen};let changed=false;for(const x of alerts){const id=String(x.p.id),fingerprint=alertFingerprint(x);if(next[id]!==fingerprint){next[id]=fingerprint;changed=true}}if(changed){if(!writeSharedMap(SHARED_SEEN_KEY,next)){const local=readLocalMap(LOCAL_SEEN_KEY);for(const x of alerts)local[String(x.p.id)]=alertFingerprint(x);writeLocalMap(LOCAL_SEEN_KEY,local)}}}

function stockAlertFor(p){
  if(!p||isBundle(p))return null;
  const d7=demand(p,7)/7,d25=demand(p,25)/25,daily=Math.max(d7,d25);
  if(!(daily>0))return null;
  const available=availableStock(p),days=available/daily;
  if(days>ALERT_DAYS)return null;
  const warehouse=atWarehouse(p.id),coming=inbound(p.id),book=Math.max(0,safeNum(p.stock)),reserve=activeReserved(p);
  const target=Math.ceil(daily*COVER_DAYS),buyQty=Math.max(0,target-available-warehouse-coming);
  return {p,daily,available,days,warehouse,coming,book,reserve,buyQty,target};
}
function allAlerts(){return products().map(stockAlertFor).filter(Boolean).sort((a,b)=>a.days-b.days||b.daily-a.daily||String(a.p.name).localeCompare(String(b.p.name),'ru'))}
function currentAlerts(){
  const hidden=readHidden(),seen={...readLocalMap(LOCAL_SEEN_KEY),...readSharedMap(SHARED_SEEN_KEY)};
  return allAlerts().filter(x=>!hidden[String(x.p.id)]&&!wasSeen(x,seen));
}
function dayText(x){if(!Number.isFinite(x))return '—';if(x<=0)return 'закончился';if(x<0.1)return '< 0,1 дня';return x.toFixed(1).replace('.',',')+' дня'}

function ensureStyle(){if(document.getElementById('stockAlertStyle'))return;const st=document.createElement('style');st.id='stockAlertStyle';st.textContent=`
.stock-alert-button{position:relative;width:44px;min-width:44px;height:44px;padding:0;border:0;background:transparent;display:inline-flex;align-items:center;justify-content:center;color:#111}
.stock-alert-button:hover{background:#f4f5f6}.stock-alert-button:active{transform:scale(.96)}
.stock-alert-icon{display:block;width:27px;height:27px;fill:none;stroke:currentColor;stroke-width:2.15;stroke-linecap:round;stroke-linejoin:round}
.stock-alert-count{position:absolute;right:-3px;top:-4px;min-width:20px;height:20px;padding:0 5px;border-radius:12px;background:#d52b2b;color:#fff;font:800 11px/18px system-ui;text-align:center;border:2px solid #fff}
.stock-alert-card{position:relative;border-left:4px solid #c62828;cursor:pointer}.stock-alert-card+.stock-alert-card{margin-top:8px}
.stock-alert-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;margin-top:10px}.stock-alert-mini{background:#f6f7f8;border-radius:11px;padding:9px}
.inventory-diff-note{margin:10px 0;padding:11px;border-radius:12px;background:#f6f7f8;line-height:1.45}.inventory-diff-note.bad{background:#fff1f1;color:#9d1717}.inventory-diff-note.ok{background:#edf8ef;color:#196b2b}
.stock-alert-dismiss{position:absolute;right:8px;top:8px;width:36px;height:36px;border:0;border-radius:50%;background:#eceef0;color:#555;font:500 26px/34px system-ui;z-index:3;padding:0;text-align:center}.stock-alert-dismiss:active{background:#dde0e3;transform:scale(.95)}
.stock-alert-card>.row:first-of-type{padding-right:38px}`;document.head.appendChild(st)}
function ensureBell(){ensureStyle();const head=document.querySelector('header .headrow');if(!head)return null;let btn=document.getElementById('stockAlertBell');if(btn)return btn;btn=document.createElement('button');btn.id='stockAlertBell';btn.type='button';btn.className='btn stock-alert-button';btn.innerHTML='<svg class="stock-alert-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"></path><path d="M10 21h4"></path></svg><span id="stockAlertCount" class="stock-alert-count" hidden>0</span>';btn.title='Предупреждения по остаткам';btn.setAttribute('aria-label','Предупреждения по остаткам');btn.onclick=()=>window.openStockAlerts?.();const sync=head.querySelector('button[onclick*="syncNow"]')||head.querySelector('button:last-child');if(sync)head.insertBefore(btn,sync);else head.appendChild(btn);return btn}
function paintBell(){const btn=ensureBell();if(!btn)return;const alerts=currentAlerts(),badge=document.getElementById('stockAlertCount'),label=alerts.length?`Предупреждения по остаткам: ${alerts.length}. Нажмите, чтобы просмотреть.`:'Нет новых предупреждений по остаткам';if(badge){badge.textContent=String(alerts.length);badge.hidden=!alerts.length}btn.title=label;btn.setAttribute('aria-label',label);btn.style.display='inline-flex';const sig=alerts.map(alertFingerprint).join('|');if(sig!==lastSignature){lastSignature=sig;btn.animate?.([{transform:'scale(1)'},{transform:'scale(1.08)'},{transform:'scale(1)'}],{duration:260})}}
function findProduct(pid){try{return prod(pid)}catch{return products().find(p=>String(p.id)===String(pid))||null}}
function alertCard(x){const pid=String(x.p.id).replace(/'/g,"\\'");const action=x.warehouse>0?`На складе ждёт ввода в продажу: <b>${x.warehouse} шт.</b>`:x.buyQty>0?`Рекомендуется закупить примерно <b>${x.buyQty} шт.</b>`:'Поставка уже в пути';return `<div class="item stock-alert-card" onclick="openStockAlertProduct('${pid}')"><button type="button" class="stock-alert-dismiss" aria-label="Скрыть" title="Скрыть на всех устройствах" onclick="event.stopPropagation();hideStockAlert('${pid}')">×</button><div class="row"><div class="grow"><div class="name">${escText(x.p.name)}</div><div class="muted">Запаса к продаже осталось примерно на ${dayText(x.days)}</div></div><span class="badge bad">${x.available} шт.</span></div><div class="stock-alert-grid"><div class="stock-alert-mini"><div class="label">По учёту в продаже</div><b>${x.book} шт.</b></div><div class="stock-alert-mini"><div class="label">В резерве</div><b>${x.reserve} шт.</b></div><div class="stock-alert-mini"><div class="label">Темп продаж</div><b>${x.daily.toFixed(1)} шт./день</b></div><div class="stock-alert-mini"><div class="label">В пути</div><b>${x.coming} шт.</b></div></div><div class="muted" style="margin-top:9px">${action}. Нажмите, чтобы пересчитать товар и начать инвентаризацию.</div><div class="actions" onclick="event.stopPropagation()">${x.warehouse>0?`<button class="btn" onclick="openStockAlertWarehouse('${pid}')">Со склада</button>`:''}<button class="btn" onclick="openStockAlertPurchase('${pid}')">Закупить</button><button class="btn dark" onclick="openStockAlertProduct('${pid}')">Пересчитать</button></div></div>`}
window.openStockAlerts=function(){const alerts=currentAlerts();if(!alerts.length)return alert('Сейчас нет новых предупреждений по остаткам.');acknowledgeAlerts(alerts);paintBell();showSheet(`<h3>Предупреждения по остаткам · ${alerts.length}</h3><div class="link-note">После открытия предупреждения отмечаются просмотренными в общей базе — на телефоне и компьютере. Они появятся снова, если изменятся остаток, резерв, поставка или спрос. Крестик × скрывает конкретный товар на всех устройствах.</div>${alerts.map(alertCard).join('')}`)};
window.hideStockAlert=function(pid){
  if(!findProduct(pid))return;
  const hidden={...readSharedMap(SHARED_HIDDEN_KEY)};
  hidden[String(pid)]={dismissed:true,at:Date.now()};
  if(!writeSharedMap(SHARED_HIDDEN_KEY,hidden)){
    const local=readLocalMap(LEGACY_HIDDEN_KEY);
    local[String(pid)]=hidden[String(pid)];
    writeLocalMap(LEGACY_HIDDEN_KEY,local);
  }
  paintBell();
  const left=currentAlerts();
  if(!left.length){closeModal();return}
  window.openStockAlerts();
};
function focusProduct(pid){const p=findProduct(pid);if(!p)return false;openView('products',true);const q=document.getElementById('q'),filter=document.getElementById('filter');if(q)q.value=String(p.name||'');if(filter)filter.value='all';try{productPage=1}catch{}try{render()}catch{}setTimeout(()=>document.getElementById('productList')?.scrollIntoView({behavior:'smooth',block:'start'}),80);return true}
function decorateInventory(pid){const p=findProduct(pid),input=document.getElementById('iq');if(!p||!input)return;const expected=Math.max(0,safeNum(p.stock)),reserve=activeReserved(p),available=availableStock(p),warehouse=atWarehouse(pid);let note=document.getElementById('inventoryExpectedNote');if(!note){note=document.createElement('div');note.id='inventoryExpectedNote';note.className='inventory-diff-note';input.closest('.two')?.insertAdjacentElement('afterend',note)}const update=()=>{const actual=Math.max(0,safeNum(input.value)),diff=actual-expected;note.className='inventory-diff-note '+(diff===0?'ok':'bad');note.innerHTML=`<b>Проверка учёта</b><br>По системе: ${expected} шт. · резерв ${reserve} шт. · свободно ${available} шт.${warehouse?` · отдельно на складе ${warehouse} шт.`:''}<br><b>${diff===0?'Совпадает с учётом':`Расхождение: ${diff>0?'+':''}${diff} шт.`}</b>`};input.addEventListener('input',update);update();input.focus();input.select()}
window.openStockAlertProduct=function(pid){if(!serverReady())return alert('Дождитесь статуса «онлайн», чтобы безопасно начать инвентаризацию.');closeModal();if(!focusProduct(pid))return;setTimeout(()=>{openModal('inventory',pid);setTimeout(()=>decorateInventory(pid),30)},130)};
window.openStockAlertWarehouse=function(pid){if(!serverReady())return alert('Дождитесь статуса «онлайн».');closeModal();focusProduct(pid);setTimeout(()=>openProductWarehouseRelease(pid),120)};
window.openStockAlertPurchase=function(pid){if(!serverReady())return alert('Дождитесь статуса «онлайн».');const x=stockAlertFor(findProduct(pid));if(!x)return;const qty=Math.max(1,x.buyQty||Math.ceil(x.daily*COVER_DAYS));window.pendingPurchaseRecommendations=[{productId:pid,qty,unitCost:lastUnitCost(pid)}];window.pendingPurchaseHint=`Запас примерно на ${dayText(x.days)}; цель — около ${COVER_DAYS} дней.`;closeModal();openView('purchases',true);setTimeout(()=>openModal('purchase'),100)};

function start(){migrateLegacyHidden();ensureBell();paintBell();setInterval(()=>{migrateLegacyHidden();paintBell()},30000);document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')setTimeout(paintBell,300)});window.addEventListener('focus',()=>setTimeout(paintBell,300))}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();setTimeout(paintBell,1800);setTimeout(paintBell,5000);
})();
