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
const wb3StockByNm=new Map();let wb3StockReady=false;
function productNm(p){return String(p?.variantNmId||p?.wbVariant?.nmId||p?.wbIdentity?.nmId||p?.nmId||'');}
function fboQty(p){const nm=productNm(p);if(!wb3StockReady||!nm||!wb3StockByNm.has(nm))return null;if(p.variantGroupId)return 0;const peers=(state.products||[]).filter(x=>!x.variantGroupId&&productNm(x)===nm);return peers.length===1?wb3StockByNm.get(nm):null;}
const originalStats=buildProductRenderStats;buildProductRenderStats=function(){const stats=originalStats();stats.fboMap=new Map((stats.products||[]).map(p=>[String(p.id),fboQty(p)||0]));return stats;};
async function loadWb3Stock(){try{const r=await fetch(MILLIONER_API+'/api/market-prices?market=WB',{cache:'no-store'}),data=await r.json();if(!r.ok||!data.ok)return;wb3StockByNm.clear();for(const row of data.rows||[])if(row.wbStockKnown)wb3StockByNm.set(String(row.remoteId),Math.max(0,Number(row.wbAvailable)||0));wb3StockReady=Number(data.wbStockFetchedAt)>0;if(typeof invalidateProductRenderStats==='function')invalidateProductRenderStats();if(document.getElementById('products')?.classList.contains('active'))renderProducts(false);decorate();}catch{}}
const originalProductCard=productCard;
productCard=function(p,...args){let html=originalProductCard(p,...args);const fbo=fboQty(p);html=html.replace(/FBO Ozon: [^<]*/g,'FBO WB: '+(fbo===null?'—':fbo+' шт.'));if(/^https:\/\//i.test(String(p?.photo||'')))html=html.replace(/(<div class="item[^>]*>)/,'$1<img class="wb3-product-photo" src="'+esc(p.photo)+'" alt="" loading="lazy" referrerpolicy="no-referrer">');return html;};
const originalOpenProduct=openProduct;
openProduct=function(pid,market='',days=null){return originalOpenProduct(pid,market&&unwanted.includes(market)?'WB':market,days);};
const oldAdd=openAddStore;openAddStore=function(){selectStore('WB');openView('settings');};
const oldReturnSelect=selectReturnOrderMarket;selectReturnOrderMarket=function(){return oldReturnSelect('WB');};
const oldRenderStores=renderStoreSettings;renderStoreSettings=function(){storeConnections=storeConnections.filter(x=>x.id==='WB');selectedStoreId='WB';oldRenderStores();};
selectedOrderMarket='WB';selectedWbAccount='WB';state.settings.selectedOrderMarket='WB';state.settings.selectedWbAccount='WB';
try{localStorage.setItem('milioner_report_market_v1','WB');localStorage.setItem(KEY+'_prices_ui_v1',JSON.stringify({...JSON.parse(localStorage.getItem(KEY+'_prices_ui_v1')||'{}'),market:'WB'}));}catch{}
const oldMarket=selectOrderMarket;selectOrderMarket=function(){return oldMarket('WB');};
const oldWb=selectWbAccount;selectWbAccount=function(){return oldWb('WB');};
const oldAuth=startOwnerRuntimeAfterAuth;startOwnerRuntimeAfterAuth=function(){selectedOrderMarket='WB';selectedWbAccount='WB';state.settings.selectedOrderMarket='WB';state.settings.selectedWbAccount='WB';oldAuth();loadWb3Stock();setInterval(loadWb3Stock,120000);};
const oldRender=render;render=function(...args){selectedOrderMarket='WB';selectedWbAccount='WB';return oldRender(...args);};
window.wb3ImportCatalog=async function(){if(!requireWarehouseEditReady())return;const button=document.getElementById('wb3CatalogImport');if(button){button.disabled=true;button.textContent='Загружаю…';}try{const response=await fetch(MILLIONER_API+'/api/wb3/catalog',{cache:'no-store'}),data=await response.json();if(!response.ok||!data.ok)throw new Error(data.error||'Не удалось получить товары');const cards=data.cards||[],draft=[];for(const card of cards)for(const size of card.sizes||[]){const found=(state.products||[]).find(p=>String(p?.wbVariant?.chrtId||'')===String(size.chrtId)||String(p.wb||'')===String(size.barcode)||(card.sizes.length===1&&String(p.wb||'')===String(card.vendorCode)));if(found)continue;draft.push({id:id(),name:card.title+(card.sizes.length>1?' · '+size.size:''),category:card.subjectName||'',photo:card.photo||'',kind:'simple',wb:card.sizes.length>1?String(size.barcode):String(card.vendorCode),kaspi:'',wb2:'',ozon:'',stock:0,cost:0,min:0,createdAt:Date.now(),wbVariant:{market:'WB',nmId:String(card.nmId),vendorCode:String(card.vendorCode),chrtId:Number(size.chrtId),barcode:String(size.barcode),barcodes:size.barcodes||[],size:String(size.size)},wbIdentity:{nmId:String(card.nmId),chrtId:Number(size.chrtId)}});}if(!draft.length){alert('Все товары уже добавлены');return;}if(!confirm('Добавить '+draft.length+' товаров из WB?\nСкладской остаток и закупки сохранятся. Начальное количество укажи через инвентаризацию.'))return;state.products.push(...draft);save();render();alert('Добавлено товаров: '+draft.length);}catch(e){alert(String(e.message||e));}finally{if(button){button.disabled=false;button.textContent='Загрузить товары из WB';}}};
function decorate(){
 document.title='Склад · WB 3';
 const fboCard=document.getElementById('productFboCard');if(fboCard){const label=fboCard.querySelector('.label');if(label&&label.textContent!=='На FBO WB')label.textContent='На FBO WB';fboCard.setAttribute('aria-label','Товары на FBO WB');const count=document.getElementById('productFboQty'),value=wb3StockReady?[...wb3StockByNm.values()].reduce((n,x)=>n+x,0)+' шт.':'—';if(count&&count.textContent!==value)count.textContent=value;}
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
