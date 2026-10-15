(function(){
'use strict';
if(!window.WB3_ONLY)return;
window.WB3_PROFILE_VERSION='2026-10-15';
const unwanted=['Kaspi','WB2','Ozon'];
const css=document.createElement('style');css.textContent=`
[data-market="Kaspi"],[data-market="Ozon"],[data-wb-account="WB2"],[data-price-market="Kaspi"],[data-price-market="WB2"],[data-price-market="Ozon"],[data-report-market="Kaspi"],[data-report-market="WB2"],[data-report-market="Ozon"],[data-report-market="all"],#wbAccountTabs,#kaspiStatusRow,#wb2StatusRow,#ozonStatusRow,[onclick="openAddStore()"],.store-tab.add,#ozonSuppliesSection{display:none!important}
.wb3-product-photo{width:42px;height:52px;object-fit:cover;border-radius:8px;flex:none;margin-right:9px;background:#f3f3f3}#productList .item.row{align-items:flex-start}#productList .name{white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
`;
document.head.appendChild(css);
let wb3Inventory={items:{},sizes:{},fetchedAt:0,error:''};let wb3StockReady=false,wb3StockTimer=null;
function productNm(p){return String(p?.variantNmId||p?.wbVariant?.nmId||p?.wbIdentity?.nmId||p?.nmId||'');}
function fboQty(p){
 if(!wb3StockReady)return null;if(p.variantGroupId)return 0;
 const nm=productNm(p),chrt=String(p?.wbVariant?.chrtId||p?.wbIdentity?.chrtId||'');if(!nm)return null;
 const size=chrt?wb3Inventory.sizes?.[nm+':'+chrt]:null;if(size)return Number(size.quantity)||0;
 const peers=(state.products||[]).filter(x=>!x.variantGroupId&&productNm(x)===nm);
 if(chrt&&Object.keys(wb3Inventory.sizes||{}).some(key=>key.startsWith(nm+':')))return 0;
 return peers.length===1?Number(wb3Inventory.items?.[nm]?.quantity)||0:null;
}
const originalStats=buildProductRenderStats;buildProductRenderStats=function(){const stats=originalStats();stats.fboReady=wb3StockReady;stats.fboMap=new Map((stats.products||[]).map(p=>[String(p.id),fboQty(p)||0]));return stats;};
// Inferno replenishes the shortfall, rather than buying a full batch again.
let wb3PurchaseUnknown=0;
window.wb3PurchaseRecommendations=function(){
 const cover=purchaseCoverDays(),since=reportPeriodStart(cover),until=reportPeriodEnd(cover),demandByProduct=new Map();
 wb3PurchaseUnknown=0;
 for(const order of state.wbOrderFeed||[]){
  const date=Number(order.creationDate)||0,qty=Math.max(0,Number(order.qty)||0);
  if(!qty||date<since||date>=until||['cancel','return','returnDefective'].includes(order.orderStatus)||marketplaceLifecycleStage('WB',order.status,order.state)==='cancelled')continue;
  const p=prod(order.productId);
  if(!p)continue;
  const parts=isBundleProduct(p)?bundleComponents(p):[{productId:p.id,qty:1}];
  for(const part of parts){const key=String(part.productId);demandByProduct.set(key,(demandByProduct.get(key)||0)+qty*part.qty);}
 }
 return stockProducts().map(product=>{
  if(state.settings?.purchasePlanIgnored?.[String(product.id)]?.hidden)return null;
  const demand=demandByProduct.get(String(product.id))||0;if(!demand)return null;
  const fbo=fboQty(product);if(fbo===null){wb3PurchaseUnknown++;return null;}
  const localAvailable=productAvailableStock(product),available=localAvailable+fbo;
  const timeline=purchaseInboundTimeline(product.id).filter(x=>purchaseWorkflowStage(x.row)!=='cart').map(x=>({...x,qty:x.status==='at_warehouse'?purchaseWarehouseQty(x.row):x.qty})).filter(x=>x.qty>0);
  const inbound=timeline.reduce((n,x)=>n+x.qty,0),daily=demand/cover,target=Math.ceil(demand),qty=Math.max(0,Math.ceil(target-available-inbound));
  if(!qty)return null;
  const unitCost=purchaseLastUnitCost(product.id),stockDays=available/daily;
  return {productId:product.id,product,qty,demand,daily,target,available,localAvailable,fbo,inbound,days:stockDays,stockDays,unitCost,estimatedCost:qty*unitCost,timeline,nextArrivalDays:timeline.length?timeline[0].days:Infinity};
 }).filter(Boolean).sort((a,b)=>a.days-b.days||b.qty-a.qty||a.product.name.localeCompare(b.product.name,'ru'));
};
window.wb3DecoratePurchasePlan=function(root,rows){
 const lines=[...root.querySelectorAll('.purchase-plan .purchase-lines > .purchase-line')];
 lines.forEach((line,index)=>{const x=rows[index],detail=line.querySelector('.grow > .muted');if(!x||!detail)return;
  detail.textContent='У меня '+x.localAvailable+' · FBO '+x.fbo+' · закуплено '+x.inbound+' · нужно на '+purchaseCoverDays()+' дн.: '+x.target+' шт.';
 });
 const note=document.createElement('div');note.className='muted';note.style.cssText='font-size:12px;margin:6px 0';
 if(wb3PurchaseUnknown){
  note.textContent='Нет остатков FBO для '+wb3PurchaseUnknown+' поз. — расчёт по ним недоступен.';
  if(!rows.length){const label=root.querySelector('.purchase-plan-toggle .muted');if(label)label.textContent='Ожидаю остатки FBO';const cost=root.querySelector('.purchase-plan-cost');if(cost)cost.textContent='—';}
 }else if(wb3Inventory.fetchedAt)note.textContent='FBO · '+new Date(wb3Inventory.fetchedAt).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Almaty'})+(wb3Inventory.error?' · сохранённые остатки':'');
 if(note.textContent)root.appendChild(note);
};
editPurchaseCoverDays=function(){const current=purchaseCoverDays();showSheet('<h3>Запас на сколько дней</h3><div class="field"><label>Дней</label><input id="purchaseCoverDaysInput" type="number" min="25" max="180" step="1" value="'+current+'"></div><div class="actions"><button type="button" class="btn" onclick="closeModal()">Отмена</button><button type="button" class="btn dark" onclick="savePurchaseCoverDays()">Сохранить</button></div>');setTimeout(()=>document.getElementById('purchaseCoverDaysInput')?.focus(),0);};
async function loadWb3Stock(){try{
 const r=await fetch(MILLIONER_API+'/api/wb3/inventory',{cache:'no-store'}),data=await r.json();if(!r.ok||!data.ok)throw new Error(data.error||'Не удалось загрузить остатки WB');
 wb3Inventory=data;wb3StockReady=Number(data.fetchedAt)>0;window.WB3_inventory=data;
 if(typeof invalidateProductRenderStats==='function')invalidateProductRenderStats();
 if(document.getElementById('products')?.classList.contains('active'))renderProducts(false);
 if(document.getElementById('purchases')?.classList.contains('active'))renderPurchasePlan();decorate();
 }catch(error){wb3Inventory.error=String(error.message||error);decorate();}}
window.refreshWb3Stock=loadWb3Stock;
const originalProductCard=productCard;
productCard=function(p,...args){let html=originalProductCard(p,...args);const fbo=fboQty(p);
 html=html.replace('В продаже:','У меня:');
 html=html.replace('<div class="product-stock-secondary">','<div class="product-stock-secondary"><span style="color:#6f42c1">FBO WB: '+(fbo===null?'не загружено':fbo+' шт.')+'</span>');
 if(/^https:\/\//i.test(String(p?.photo||'')))html=html.replace(/(<div class="item[^>]*>)/,'$1<img class="wb3-product-photo" src="'+esc(p.photo)+'" alt="" loading="lazy" referrerpolicy="no-referrer">');return html;};
const oldFboFilter=toggleProductFboFilter;toggleProductFboFilter=function(){if(!wb3StockReady)return alert(wb3Inventory.error||'Остатки WB ещё загружаются');return oldFboFilter();};
const originalOpenProduct=openProduct;
openProduct=function(pid,market='',days=null){return originalOpenProduct(pid,market&&unwanted.includes(market)?'WB':market,days);};
const oldAdd=openAddStore;openAddStore=function(){selectStore('WB');openView('settings');};
const oldReturnSelect=selectReturnOrderMarket;selectReturnOrderMarket=function(){return oldReturnSelect('WB');};
const oldRenderStores=renderStoreSettings;renderStoreSettings=function(){storeConnections=storeConnections.filter(x=>x.id==='WB');selectedStoreId='WB';oldRenderStores();};
selectedOrderMarket='WB';selectedWbAccount='WB';state.settings.selectedOrderMarket='WB';state.settings.selectedWbAccount='WB';
try{localStorage.setItem('milioner_report_market_v1','WB');localStorage.setItem(KEY+'_prices_ui_v1',JSON.stringify({...JSON.parse(localStorage.getItem(KEY+'_prices_ui_v1')||'{}'),market:'WB'}));}catch{}
const oldMarket=selectOrderMarket;selectOrderMarket=function(){return oldMarket('WB');};
const oldWb=selectWbAccount;selectWbAccount=function(){return oldWb('WB');};
const oldAuth=startOwnerRuntimeAfterAuth;startOwnerRuntimeAfterAuth=function(){selectedOrderMarket='WB';selectedWbAccount='WB';state.settings.selectedOrderMarket='WB';state.settings.selectedWbAccount='WB';oldAuth();loadWb3Stock();if(!wb3StockTimer)wb3StockTimer=setInterval(loadWb3Stock,120000);};
const oldRender=render;render=function(...args){selectedOrderMarket='WB';selectedWbAccount='WB';return oldRender(...args);};
window.wb3ImportCatalog=async function(){if(!requireWarehouseEditReady())return;const button=document.getElementById('wb3CatalogImport');if(button){button.disabled=true;button.textContent='Загружаю…';}try{const response=await fetch(MILLIONER_API+'/api/wb3/catalog',{cache:'no-store'}),data=await response.json();if(!response.ok||!data.ok)throw new Error(data.error||'Не удалось получить товары');const cards=data.cards||[],draft=[];for(const card of cards)for(const size of card.sizes||[]){const found=(state.products||[]).find(p=>String(p?.wbVariant?.chrtId||'')===String(size.chrtId)||String(p.wb||'')===String(size.barcode)||(card.sizes.length===1&&String(p.wb||'')===String(card.vendorCode)));if(found)continue;draft.push({id:id(),name:card.title+(card.sizes.length>1?' · '+size.size:''),category:card.subjectName||'',photo:card.photo||'',kind:'simple',wb:card.sizes.length>1?String(size.barcode):String(card.vendorCode),kaspi:'',wb2:'',ozon:'',stock:0,cost:0,min:0,createdAt:Date.now(),wbVariant:{market:'WB',nmId:String(card.nmId),vendorCode:String(card.vendorCode),chrtId:Number(size.chrtId),barcode:String(size.barcode),barcodes:size.barcodes||[],size:String(size.size)},wbIdentity:{nmId:String(card.nmId),chrtId:Number(size.chrtId)}});}if(!draft.length){alert('Все товары уже добавлены');return;}if(!confirm('Добавить '+draft.length+' товаров из WB?\nСкладской остаток и закупки сохранятся. Начальное количество укажи через инвентаризацию.'))return;state.products.push(...draft);save();render();alert('Добавлено товаров: '+draft.length);}catch(e){alert(String(e.message||e));}finally{if(button){button.disabled=false;button.textContent='Загрузить товары из WB';}}};
function decorate(){
 document.title='Инферно · склад';
 const stockQty=document.getElementById('productStockQty');if(stockQty?.previousElementSibling&&stockQty.previousElementSibling.textContent!=='У меня')stockQty.previousElementSibling.textContent='У меня';
 const fboCard=document.getElementById('productFboCard');if(fboCard){
 const label=fboCard.querySelector('.label');if(label&&label.textContent!=='На FBO WB')label.textContent='На FBO WB';fboCard.setAttribute('aria-label','Товары на FBO WB');
 const count=document.getElementById('productFboQty'),total=Number(wb3Inventory.total??Object.values(wb3Inventory.items||{}).reduce((n,x)=>n+(Number(x.quantity)||0),0)),value=wb3StockReady?total+' шт.':'Не загружено';if(count&&count.textContent!==value)count.textContent=value;
 let note=document.getElementById('wb3StockStatus');if(!note){note=document.createElement('div');note.id='wb3StockStatus';note.className='muted';note.style.cssText='font-size:11px;margin-top:5px';fboCard.append(note);}
 const info=wb3Inventory.error|| (wb3Inventory.loading?'Загружаю…':wb3Inventory.fetchedAt?'Обновлено '+new Date(wb3Inventory.fetchedAt).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Almaty'}):'');if(note.textContent!==info)note.textContent=info;
 }

 for(const label of document.querySelectorAll('#wb1StatusRow b,#reportMarketTitle'))if(/^WB\s*1$/.test(label.textContent.trim()))label.textContent='WB 3';
 for(const selector of ['[data-price-market="WB"]','[data-report-market="WB"]','[data-market="WB"]'])for(const el of document.querySelectorAll(selector))if(el.textContent.trim()!=='WB 3')el.textContent='WB 3';
 for(const el of document.querySelectorAll('[data-market="Kaspi"],[data-market="Ozon"],[data-wb-account="WB2"],[data-price-market="Kaspi"],[data-price-market="WB2"],[data-price-market="Ozon"],[data-report-market="Kaspi"],[data-report-market="WB2"],[data-report-market="Ozon"],[data-report-market="all"]'))el.hidden=true;
 for(const opt of document.querySelectorAll('option'))if(unwanted.includes(opt.value)||['Kaspi','WB 2','WB2','Ozon','Ozon FBO'].includes(opt.textContent.trim()))opt.remove();
 for(const id of ['ek','ekprice','ew2','eo','pk','pkprice','pw2','po']){const el=document.getElementById(id);if(el)el.closest('.field')?.setAttribute('hidden','');}
 for(const id of ['dotKaspi','dotWB2','dotOzonTop']){const el=document.getElementById(id);if(el)el.closest('.compact-market-row')?.setAttribute('hidden','');}
 for(const el of document.querySelectorAll('.business-sub'))if(el.textContent.includes('Kaspi'))el.textContent=el.textContent.includes('часам')?'WB 3 · по часам':'WB 3 · по дням';
 if(!document.getElementById('wb3CatalogImport')){const panel=document.getElementById('storeDetail');if(panel?.children.length){const b=document.createElement('button');b.id='wb3CatalogImport';b.type='button';b.className='btn full';b.textContent='Загрузить товары из WB';b.onclick=window.wb3ImportCatalog;panel.append(b);}}
}
let scheduled=false;new MutationObserver(()=>{if(scheduled)return;scheduled=true;requestAnimationFrame(()=>{scheduled=false;decorate();});}).observe(document.getElementById('app')||document.body,{childList:true,subtree:true});decorate();
})();
