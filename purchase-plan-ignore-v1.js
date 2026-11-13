(function(){
'use strict';

if(typeof purchaseRecommendations!=='function'||typeof renderPurchasePlan!=='function')return;

const SETTINGS_KEY='purchasePlanIgnored';
const originalPurchaseRecommendations=purchaseRecommendations;
const originalRenderPurchasePlan=renderPurchasePlan;
let lastVisibleRecommendations=[];
let refreshingPlan=false;
let planRefreshMessage='';

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

window.isHistoricalPurchasePlanRow=function({product,available,inbound}){
  if(!product?.variantGroupId||!product.variantLegacyLink||product.wbVariant?.chrtId)return false;
  if(Number(product.stock)>0||Number(available)>0||Number(inbound)>0||reserved(product)>0)return false;
  return !['kaspi','wb','wb2','ozon'].some(field=>
    Boolean(String(product[field]||'').trim())||
    (Array.isArray(product[field+'Aliases'])&&product[field+'Aliases'].some(value=>String(value||'').trim()))
  );
};

purchaseRecommendations=function(){
  const rows=window.WB3_ONLY&&typeof window.wb3PurchaseRecommendations==='function'
    ?window.wb3PurchaseRecommendations():originalPurchaseRecommendations();
  const all=Array.isArray(rows)?rows:[];
  const ignored=ignoredMap();
  lastVisibleRecommendations=all.filter(row=>!ignored[String(row.productId)]?.hidden&&!window.isHistoricalPurchasePlanRow(row));
  window.__lastPurchaseRecommendations=lastVisibleRecommendations;
  return lastVisibleRecommendations;
};

window.ignorePurchasePlanProduct=function(encodedProductId){
  const productId=decodeURIComponent(String(encodedProductId||''));
  let p=null;
  try{p=typeof prod==='function'?prod(productId):null}catch{}
  const row=window.__lastPurchaseRecommendations?.find(x=>String(x.productId)===productId);
  const name=String(row?.product?.name||p?.name||'этот товар');
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

function paintPlanRefresh(root){
  const controls=root?.querySelector('[data-purchase-plan-refresh-controls]');
  if(!controls)return;
  const button=controls.querySelector('[data-purchase-plan-refresh]');
  button.disabled=refreshingPlan;
  button.textContent=refreshingPlan?'Обновляю…':'Обновить';
  controls.querySelector('[role="status"]').textContent=planRefreshMessage;
}

async function refreshPurchasePlan(){
  if(refreshingPlan)return;
  const root=()=>document.getElementById('purchasePlan');
  refreshingPlan=true;
  planRefreshMessage='';
  paintPlanRefresh(root());
  try{
    // Refresh warehouse links before matching the server's orders to products.
    const warehouseReady=await pullWarehouseFromServer({force:true});
    const stores=window.selectedStoreIds?.('purchases')||[];
    const days=Math.max(45,purchaseCoverDays(),stores.includes('WB3')?Number(state.settings?.infernoSettings?.purchaseCoverDays)||0:0);
    const refreshes=[window.loadSharedOrderCache({silent:true,after:reportPeriodStart(days)}).then(result=>Boolean(result&&!result.error))];
    if(stores.includes('Ozon')&&window.ozonFboRefreshStatus){
      refreshes.push(window.ozonFboRefreshStatus({force:true}).then(Boolean));
    }
    if(stores.includes('WB3')&&window.refreshPurchaseWb3Inventory){
      refreshes.push(window.refreshPurchaseWb3Inventory());
    }else if(window.WB3_ONLY&&window.refreshWb3Stock){
      refreshes.push(window.refreshWb3Stock().then(()=>Boolean(window.WB3_inventory?.fetchedAt&&!window.WB3_inventory.error)));
    }
    const results=await Promise.allSettled(refreshes);
    if(!warehouseReady||results.some(result=>result.status!=='fulfilled'||!result.value)){
      planRefreshMessage='Часть данных не обновилась. Показаны последние доступные.';
    }
  }catch(error){
    console.warn('purchase plan refresh failed',error);
    planRefreshMessage='Не удалось обновить. Показаны последние доступные данные.';
  }finally{
    refreshingPlan=false;
    renderPurchasePlan();
  }
}

function addPlanRefresh(root){
  const plan=root.querySelector('.purchase-plan');
  if(!plan||root.querySelector('[data-purchase-plan-refresh-controls]'))return;
  const controls=document.createElement('div');
  controls.className='row';
  controls.dataset.purchasePlanRefreshControls='1';
  controls.style.cssText='gap:8px;flex-wrap:wrap;margin-bottom:10px';
  controls.innerHTML='<button type="button" class="btn" data-purchase-plan-refresh>Обновить</button><span class="muted" role="status"></span>';
  controls.querySelector('[data-purchase-plan-refresh]').onclick=refreshPurchasePlan;
  const period=plan.previousElementSibling;
  if(period?.matches('button')){
    period.style.marginBottom='0';
    root.insertBefore(controls,period);
    controls.prepend(period);
  }else root.insertBefore(controls,plan);
  paintPlanRefresh(root);
}

function decoratePurchasePlan(){
  const root=document.getElementById('purchasePlan');
  if(!root)return;
  addPlanRefresh(root);
  const controls=root.querySelector('[data-purchase-plan-refresh-controls]');
  if(controls&&typeof window.chooseKaspiPurchaseReport==='function'&&!controls.querySelector('[data-kaspi-purchase-report]')){
    const button=document.createElement('button');
    button.type='button';
    button.className='btn';
    button.dataset.kaspiPurchaseReport='1';
    button.textContent='Отчёт Kaspi Pay';
    button.onclick=window.chooseKaspiPurchaseReport;
    controls.appendChild(button);
  }

  const visible=window.__lastPurchaseRecommendations||lastVisibleRecommendations;
  // The existing Buy action contains the rendered row's exact product ID.
  const productIdsByAction=new Map(visible.map(({productId})=>{
    const encodedId=encodeURIComponent(String(productId));
    return [`openRecommendedPurchase('${encodedId}')`,encodedId];
  }));
  const lines=root.querySelectorAll('.purchase-plan .purchase-lines > .purchase-line');
  for(const line of lines){
    const right=line.querySelector('.right');
    const action=right?.querySelector('button[onclick]')?.getAttribute('onclick');
    const encodedId=productIdsByAction.get(action);
    if(!encodedId||line.querySelector('[data-purchase-plan-ignore]'))continue;
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
      window.ignorePurchasePlanProduct(encodedId);
    };
    right.appendChild(button);
  }

  root.querySelector('[data-purchase-plan-hidden-manager]')?.remove();
  const hidden=ignoredEntries();
  if(hidden.length){
    const manager=document.createElement('div');
    manager.className='item';
    manager.dataset.purchasePlanHiddenManager='1';
    manager.style.marginTop='8px';
    manager.innerHTML=`<div class="row"><b>Скрытые</b><button type="button" class="btn" style="margin-left:auto" onclick="openIgnoredPurchasePlanProducts()">Показать · ${hidden.length}</button></div>`;
    root.appendChild(manager);
  }
  if(window.WB3_ONLY&&typeof window.wb3DecoratePurchasePlan==='function')window.wb3DecoratePurchasePlan(root,visible);
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
