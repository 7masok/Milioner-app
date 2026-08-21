(function(){
'use strict';

if(typeof purchaseRecommendations!=='function'||typeof renderPurchasePlan!=='function')return;

const SETTINGS_KEY='purchasePlanIgnored';
const originalPurchaseRecommendations=purchaseRecommendations;
const originalRenderPurchasePlan=renderPurchasePlan;
let lastVisibleRecommendations=[];

function ignoredMap(){
  state.settings||={};
  const raw=state.settings[SETTINGS_KEY];
  if(!raw||typeof raw!=='object'||Array.isArray(raw))state.settings[SETTINGS_KEY]={};
  return state.settings[SETTINGS_KEY];
}
function ignoredEntries(){
  const map=ignoredMap();
  return Object.entries(map)
    .filter(([,v])=>v&&v.hidden)
    .map(([productId,v])=>{
      let p=null;
      try{p=typeof prod==='function'?prod(productId):null}catch{}
      return {productId,name:String(p?.name||v.name||'Удалённый товар'),hiddenAt:Number(v.hiddenAt||0)};
    })
    .sort((a,b)=>a.name.localeCompare(b.name,'ru'));
}

purchaseRecommendations=function(){
  const rows=originalPurchaseRecommendations();
  const all=Array.isArray(rows)?rows:[];
  const ignored=ignoredMap();
  lastVisibleRecommendations=all.filter(x=>!ignored[String(x?.productId)]?.hidden);
  return lastVisibleRecommendations;
};

window.ignorePurchasePlanProduct=function(encodedProductId){
  const productId=decodeURIComponent(String(encodedProductId||''));
  let p=null;
  try{p=typeof prod==='function'?prod(productId):null}catch{}
  const row=lastVisibleRecommendations.find(x=>String(x?.productId)===String(productId));
  const name=String(p?.name||row?.product?.name||'этот товар');
  if(!confirm(`Больше не предлагать «${name}» к закупке?\n\nТовар останется в складе. Остатки, продажи и история не изменятся. Вернуть его можно через «Скрытые из закупки».`))return;
  const map=ignoredMap();
  map[String(productId)]={hidden:true,hiddenAt:Date.now(),name};
  try{purchasePlanSelection?.delete?.(String(productId))}catch{}
  save();
  renderPurchasePlan();
};

window.restorePurchasePlanProduct=function(encodedProductId){
  const productId=decodeURIComponent(String(encodedProductId||''));
  const map=ignoredMap();
  if(!map[String(productId)])return;
  delete map[String(productId)];
  save();
  renderPurchasePlan();
  const left=ignoredEntries();
  if(left.length)window.openIgnoredPurchasePlanProducts();
  else closeModal();
};

window.openIgnoredPurchasePlanProducts=function(){
  const rows=ignoredEntries();
  if(!rows.length)return alert('Скрытых товаров нет.');
  const html=rows.map(x=>{
    const key=encodeURIComponent(String(x.productId));
    const date=x.hiddenAt?new Date(x.hiddenAt).toLocaleDateString('ru-RU'):'';
    return `<div class="item row" style="margin-bottom:8px"><div class="grow"><b>${esc(x.name)}</b><div class="muted">Не предлагать к закупке${date?' · скрыто '+date:''}</div></div><button type="button" class="btn" onclick="restorePurchasePlanProduct('${key}')">Вернуть</button></div>`;
  }).join('');
  showSheet(`<h3>Скрытые из закупки · ${rows.length}</h3><div class="link-note">Эти товары остаются в складе, отчётах и истории, но не попадают в автоматический список «Надо купить». Вернуть рекомендацию можно вручную.</div>${html}`);
};

function decoratePurchasePlan(){
  const root=document.getElementById('purchasePlan');
  if(!root)return;

  // originalRenderPurchasePlan() has already calculated these rows. Reuse them
  // instead of running the expensive purchase recommendation calculation twice.
  const visible=lastVisibleRecommendations;
  const lines=[...root.querySelectorAll('.purchase-plan .purchase-lines > .purchase-line')];
  lines.forEach((line,index)=>{
    const row=visible[index];
    if(!row||line.querySelector('[data-purchase-plan-ignore]'))return;
    const right=line.querySelector('.right')||line;
    const button=document.createElement('button');
    button.type='button';
    button.className='btn danger';
    button.dataset.purchasePlanIgnore='1';
    button.textContent='×';
    button.title='Больше не предлагать к закупке';
    button.setAttribute('aria-label','Больше не предлагать к закупке');
    button.style.marginLeft='7px';
    button.style.minWidth='42px';
    button.style.fontSize='22px';
    button.style.lineHeight='1';
    button.onclick=e=>{
      e.preventDefault();
      e.stopPropagation();
      window.ignorePurchasePlanProduct(encodeURIComponent(String(row.productId)));
    };
    right.appendChild(button);
  });

  root.querySelector('[data-purchase-plan-hidden-manager]')?.remove();
  const hidden=ignoredEntries();
  if(hidden.length){
    const manager=document.createElement('div');
    manager.className='item';
    manager.dataset.purchasePlanHiddenManager='1';
    manager.style.marginTop='8px';
    manager.innerHTML=`<div class="row"><div class="grow"><b>Скрытые из закупки</b><div class="muted">Не будут появляться в рекомендациях, пока вы их не вернёте.</div></div><button type="button" class="btn" onclick="openIgnoredPurchasePlanProducts()">Показать · ${hidden.length}</button></div>`;
    root.appendChild(manager);
  }
}

renderPurchasePlan=function(){
  const result=originalRenderPurchasePlan();
  decoratePurchasePlan();
  return result;
};

// Do not recalculate the expensive plan on every page startup. Only redraw if
// the purchase tab was already active when this late-loaded module arrived.
setTimeout(()=>{
  try{
    if(document.getElementById('purchases')?.classList.contains('active'))renderPurchasePlan();
  }catch(e){console.warn('purchase plan ignore render failed',e)}
},0);
})();
