import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
const cloud=readFileSync(new URL('../../cloud-sync-v3.js',import.meta.url),'utf8');

test('Products reload preserves tab search and page while removed controls stay reset',()=>{
  assert.match(html,/const PRODUCT_UI_KEY=KEY\+'_product_ui_v1'/);
  assert.match(html,/savedView=localStorage\.getItem\(ACTIVE_VIEW_KEY\)/);
  assert.match(html,/startupView=!freshLogin/);
  assert.match(html,/function readProductUi\(\)/);
  assert.match(html,/function rememberProductUi\(patch=\{\}\)/);
  assert.match(html,/rememberProductUi\(\{q:/);
  assert.match(html,/rememberProductUi\(\{page:productPage\}/);
  assert.match(html,/let productUi=\{\.\.\.readProductUi\(\),filter:'all',sort:'name',sortDirections:\{name:'asc'\},period:'30',customFrom:'',customTo:''\}/);
  assert.match(html,/let productFilter='all';\nlet productFboOnly=false;\nlet productSort='name';/);
});

test('bottom nav allocates one column per eight visible tabs',()=>{
  assert.match(html,/grid-template-columns:repeat\(8,minmax\(0,1fr\)\)/);
});

test('Products reject invalid quantities and remove the ignored duplicate minimum field',()=>{
  assert.doesNotMatch(html,/eminSimple/);
  assert.match(html,/id="pstock" type="number" min="0" step="1"/);
  assert.match(html,/id="pmin" type="number" min="0" step="1"/);
  assert.match(html,/id="emin" type="number" min="0" step="1"/);
  assert.match(html,/Начальный остаток должен быть целым числом от 0/);
  assert.match(html,/Минимальный остаток должен быть целым числом от 0/);
  assert.match(html,/bundle-qty" type="number" min="1" step="1"/);
});

test('Products keep alias search but expose no filter or sort controls',()=>{
  const search=html.slice(html.indexOf('function productSearchHaystack('),html.indexOf('\nfunction readProductUi',html.indexOf('function productSearchHaystack(')));
  for(const token of ['kaspiAliases','wbAliases','wb2Aliases','ozonAliases','vendorCode','nmId','chrtId','barcode'])assert.match(search,new RegExp(token));
  assert.match(html,/id="q" class="search" placeholder="Поиск по названию или артикулам"/);
  assert.doesNotMatch(html,/data-product-filter=/);
  assert.doesNotMatch(html,/data-product-sort=/);
  assert.doesNotMatch(html,/id="productFilterPicker"/);
  assert.doesNotMatch(html,/id="productSortPicker"/);
  assert.doesNotMatch(html,/id="productSortDirection"/);
});

test('Products ignore legacy saved filter sort and direction state',()=>{
  assert.match(html,/let productUi=\{\.\.\.readProductUi\(\),filter:'all',sort:'name',sortDirections:\{name:'asc'\},period:'30',customFrom:'',customTo:''\}/);
  assert.match(html,/let productFilter='all';\nlet productFboOnly=false;\nlet productSort='name';/);
  assert.doesNotMatch(html,/id="productAtWarehouseCard"/);
  assert.doesNotMatch(html,/id="productAtWarehouseQty"/);
});

test('Products protect read-only cached state and live stock deletion',()=>{
  assert.match(html,/function requireWarehouseEditReady\(\)/);
  assert.match(html,/data-warehouse-readonly-cache/);
  assert.match(html,/Нельзя удалить товар с остатком/);
  assert.match(cloud,/applyWarehouseSnapshot=function\(remote\)\{\n  if\(typeof invalidateProductRenderStats==='function'\)invalidateProductRenderStats\(\)/);
  assert.match(cloud,/save=function\(\)\{\n  if\(typeof invalidateProductRenderStats==='function'\)invalidateProductRenderStats\(\)/);
});

test('Marketplace SKU ownership is checked in create edit and relink paths',()=>{
  assert.match(html,/function marketplaceSkuOwner\(field,value,excludeId=''/);
  assert.match(html,/function validateProductMarketplaceSkus\(values,excludeId=''/);
  assert.match(html,/validateProductMarketplaceSkus\(\{kaspi:kaspiSku,wb:wbSku,wb2:wb2Sku,ozon:ozonSku\},p\.id\)/);
  assert.match(html,/validateProductMarketplaceSkus\(\{kaspi:kaspiSku,wb:wbSku,wb2:wb2Sku,ozon:ozonSku\}\)/);
  assert.match(html,/marketplaceSkuOwner\(field,next,p\?\.id\)/);
});

test('Product list cards are compact text-only and Ozon zero is not shown before load',()=>{
  const card=html.split('\n').find(x=>x.startsWith('function productCard('))||'';
  assert.doesNotMatch(card,/p\.photo|class="thumb"|p\.category|Без категории/);
  assert.doesNotMatch(card,/<b>\$\{physical\} шт\.<\/b><div class="muted">в продаже<\/div>/);
  assert.match(card,/class="name">\$\{esc\(p\.name\)\}<\/div>/);
  assert.match(html,/#productList \.name\{font-size:12px;line-height:1\.15;white-space:nowrap;overflow:hidden;text-overflow:ellipsis\}/);
  assert.match(html,/#productList\{gap:1px\}/);
  assert.match(html,/#productList>\.item\{padding:6px 8px;border-radius:9px\}/);
  assert.match(html,/id="productFboQty">—</);
});

test('Product details show progress before waiting on combined finance',()=>{
  const start=html.indexOf('async function openProduct(');
  const end=html.indexOf('\nfunction ',start+10);
  const fn=html.slice(start,end>start?end:start+16000);
  assert.match(fn,/Обновляю данные товара…/);
  assert.ok(fn.indexOf('Обновляю данные товара…')<fn.indexOf('await window.refreshAllMarketUnitProfit()'));
});


test('Products keep search plus the direct FBO metric filter without old dropdown controls',()=>{
  assert.doesNotMatch(html,/<select id="filter"/);
  assert.doesNotMatch(html,/<select id="sort"/);
  assert.doesNotMatch(html,/<input id="filter"/);
  assert.doesNotMatch(html,/<input id="sort"/);
  assert.doesNotMatch(html,/class="product-picker/);
  assert.doesNotMatch(html,/class="product-sort-direction"/);
  assert.doesNotMatch(html,/data-product-period=/);
  assert.match(html,/id="q" class="search" placeholder="Поиск по названию или артикулам"/);
  assert.match(html,/id="productFboCard" type="button" class="card purchase-filter-card" onclick="toggleProductFboFilter\(\)"/);
  assert.match(html,/aria-pressed="false"/);
});

test('FBO Ozon metric toggles a positive-FBO product filter and keeps search combined',()=>{
  assert.match(html,/function syncProductFboFilterCard\(\)/);
  assert.match(html,/button\.classList\.toggle\('active',productFboOnly\)/);
  assert.match(html,/button\.setAttribute\('aria-pressed',productFboOnly\?'true':'false'\)/);
  assert.match(html,/function toggleProductFboFilter\(\)\{productFboOnly=!productFboOnly;productPage=1;/);
  const start=html.indexOf('function renderProducts(rebuildStats=false){');
  const end=html.indexOf('\nfunction wbRelinkNotice(',start);
  const render=html.slice(start,end);
  assert.match(render,/!productFboOnly\|\|\(Number\(stats\.fboMap\?\.get\(String\(p\.id\)\)\)\|\|0\)>0/);
  assert.match(render,/&&\(!q\|\|String\(stats\.searchMap\.get\(String\(p\.id\)\)\|\|''\)\.includes\(q\)\)/);
  assert.match(render,/На FBO Ozon по этому запросу товаров нет\./);
});


test('Products paints the tab before heavy statistics and warms cache off the critical path',()=>{
  assert.match(html,/function scheduleProductRenderWarmup\(delay=350\)/);
  assert.match(html,/productIdle\(warm,1800\)/);
  assert.match(html,/function invalidateProductRenderStats\(\)\{productRenderStatsCache=null;clearTimeout\(productHeavyMetricTimer\);scheduleProductRenderWarmup\(\)\}/);
  const start=html.indexOf('function openView(view,remember=true){');
  const end=html.indexOf("document.querySelectorAll('nav button').forEach(b=>b.onclick",start);
  const fn=html.slice(start,end);
  assert.match(fn,/const productsNeedFirstPaint=view==='products'&&!productRenderStatsCache/);
  assert.match(fn,/requestAnimationFrame\(\(\)=>\{/);
  assert.match(fn,/try\{render\(\)\}/);
  assert.match(fn,/invalidateProductRenderStats\(\);renderProducts\(true\)/);
  assert.ok(fn.indexOf("finalView.classList.add('active')")<fn.indexOf('requestAnimationFrame('));
  assert.ok(fn.indexOf('requestAnimationFrame(')<fn.indexOf('try{render()}'));
});

test('Products show current buyer-delivery stock and projected profit',()=>{
  assert.doesNotMatch(html,/Введено в продажу за 30 дней|productReceived30/);
  assert.match(html,/В пути до покупателя/);
  assert.match(html,/id="productToBuyerQty">—</);
  assert.match(html,/Прибыль в пути до покупателя/);
  assert.match(html,/id="productToBuyerProfit">—</);
  assert.match(html,/function marketplaceOrderInTransitToBuyer\(/);
  assert.match(html,/function marketplaceToBuyerSnapshot\(/);
  assert.match(html,/function marketplaceToBuyerProfit\(periodStats,snapshot=marketplaceToBuyerSnapshot\(\)\)/);
  assert.match(html,/total\+=Math\.max\(0,Number\(qty\)\|\|0\)\*unitProfit/);
  assert.match(html,/buyer&&periodReady\?fmt\(marketplaceToBuyerProfit\(periodStats,buyer\)\):'—'/);
  assert.match(html,/SORTED','ACCEPTED_BY_CARRIER','SENT_TO_CARRIER','READY_FOR_PICKUP/);
  assert.match(html,/KASPI_DELIVERY_TRANSIT/);
  assert.match(html,/DELIVERING/);
  assert.match(html,/SOLD'\]\.includes\(st\)\)return false/);
  assert.match(html,/COMPLETED'\]\.includes\(u\)\|\|st==='ARCHIVE'/);
});

test('Products combine free sale and warehouse stock in one top metric',()=>{
  const section=html.slice(html.indexOf('<section id="products"'),html.indexOf('<section id="movement"'));
  assert.match(section,/<div class="label">Доступно<\/div><div class="num" id="productStockQty">—<\/div>/);
  assert.doesNotMatch(section,/productAtWarehouseQty|productAtWarehouseCard/);
  assert.match(html,/set\('productStockQty',Math\.round\(stats\.availableTotal\+stats\.warehouseTotal\)/);
});

test('Products static shell never shows unconfirmed zero totals',()=>{
  for(const id of ['productStockQty','productReservedQty','productInboundQty','productFboQty','productStockCost','productStockProfit','productToBuyerQty','productToBuyerProfit']){
    assert.match(html,new RegExp('id="'+id+'">—<'));
  }
  assert.match(html,/id="productList" class="list"><div class="empty">Подготавливаю товары…<\/div>/);
});


test('Products expose no time controls while using 30-day sales and six-month card profit internally',()=>{
  assert.doesNotMatch(html,/data-product-period=/);
  assert.doesNotMatch(html,/id="productPeriod"/);
  assert.doesNotMatch(html,/id="productPeriodStatus"/);
  assert.doesNotMatch(html,/id="productCustomRange"/);
  assert.match(html,/let productPeriod='30';/);
  assert.match(html,/period:'30',customFrom:'',customTo:''/);
  assert.match(html,/function productPeriodSpec\(\)/);
  assert.match(html,/function ensureProductPeriodStats\(force=false\)/);
  assert.match(html,/PRODUCT_CARD_PROFIT_SPEC=\{days:180,key:'card-profit-180',label:'6 мес\.'/);
  assert.match(html,/function ensureProductCardProfitStats\(force=false\)/);
  assert.doesNotMatch(html,/Продажи\/день за 25 дней/);
});

test('Products use deterministic alphabetical order after removing sort controls',()=>{
  assert.match(html,/let productSort='name';/);
  assert.match(html,/sortDirections:\{name:'asc'\}/);
  const start=html.indexOf('function renderProducts(rebuildStats=false){');
  const end=html.indexOf('\nfunction wbRelinkNotice(',start);
  const render=html.slice(start,end);
  assert.match(render,/rows\.sort\(\(a,b\)=>String\(a\?\.name\|\|''\)\.localeCompare\(String\(b\?\.name\|\|''\),'ru'\)\)/);
  assert.doesNotMatch(render,/currentProductSort\(|productSortDirection\(|data-product-sort/);
  assert.doesNotMatch(html,/productSortDirection" type="button"/);
});
