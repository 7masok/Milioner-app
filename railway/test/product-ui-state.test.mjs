import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
const cloud=readFileSync(new URL('../../cloud-sync-v3.js',import.meta.url),'utf8');

test('Products reload preserves tab and product-list controls',()=>{
  assert.match(html,/const PRODUCT_UI_KEY=KEY\+'_product_ui_v1'/);
  assert.match(html,/savedView=localStorage\.getItem\(ACTIVE_VIEW_KEY\)/);
  assert.match(html,/startupView=!freshLogin/);
  assert.match(html,/function readProductUi\(\)/);
  assert.match(html,/function rememberProductUi\(patch=\{\}\)/);
  assert.match(html,/rememberProductUi\(\{q:/);
  assert.match(html,/rememberProductUi\(\{filter:/);
  assert.match(html,/rememberProductUi\(\{page:productPage\}/);
  const sortStart=html.indexOf('function productSortChanged(){');
  const sortEnd=html.indexOf('\nfunction toggleProductSortDirection',sortStart);
  assert.doesNotMatch(html.slice(sortStart,sortEnd),/save\(\)/);
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

test('Products search aliases and expose the agreed stock filters',()=>{
  const search=html.slice(html.indexOf('function productSearchHaystack('),html.indexOf('\nfunction readProductUi',html.indexOf('function productSearchHaystack(')));
  for(const token of ['kaspiAliases','wbAliases','wb2Aliases','ozonAliases','vendorCode','nmId','chrtId','barcode'])assert.match(search,new RegExp(token));
  for(const value of ['all','sale','warehouse','fbo','transit','zero'])assert.ok(html.includes('data-product-filter="'+value+'"'));
  assert.doesNotMatch(html,/data-product-filter="low"/);
  assert.doesNotMatch(html,/data-product-filter="buy"/);
  const render=html.slice(html.indexOf('function renderProducts('),html.indexOf('\nfunction wbRelinkNotice',html.indexOf('function renderProducts(')));
  assert.match(render,/f==='zero'&&sale<=0&&warehouse<=0&&transit<=0&&fbo<=0/);
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

test('Product cards escape image URL and Ozon zero is not shown before load',()=>{
  const card=html.split('\n').find(x=>x.startsWith('function productCard('));
  assert.match(card,/src="\$\{esc\(p\.photo\)\}"/);
  assert.match(html,/id="productFboQty">—</);
});

test('Product details show progress before waiting on combined finance',()=>{
  const start=html.indexOf('async function openProduct(');
  const end=html.indexOf('\nfunction ',start+10);
  const fn=html.slice(start,end>start?end:start+16000);
  assert.match(fn,/Обновляю данные товара…/);
  assert.ok(fn.indexOf('Обновляю данные товара…')<fn.indexOf('await window.refreshAllMarketUnitProfit()'));
});


test('Products filter and sort use anchored in-page pickers instead of Android native selects',()=>{
  assert.doesNotMatch(html,/<select id="filter"/);
  assert.doesNotMatch(html,/<select id="sort"/);
  assert.match(html,/<input id="filter" type="hidden"/);
  assert.match(html,/<input id="sort" type="hidden"/);
  assert.match(html,/id="productFilterPicker" class="product-picker product-filter-picker"/);
  assert.match(html,/id="productSortPicker" class="product-picker product-sort-picker"/);
  assert.match(html,/\.product-picker-menu\{position:absolute;top:calc\(100% \+ 5px\);z-index:40/);
  assert.match(html,/function setProductFilter\(value\)/);
  assert.match(html,/function setProductSort\(value\)/);
});


test('Products paints the tab before heavy statistics and warms cache off the critical path',()=>{
  assert.match(html,/function scheduleProductRenderWarmup\(delay=250\)/);
  assert.match(html,/requestIdleCallback\(warm,\{timeout:1800\}\)/);
  assert.match(html,/function invalidateProductRenderStats\(\)\{productRenderStatsCache=null;scheduleProductRenderWarmup\(\)\}/);
  const start=html.indexOf('function openView(view,remember=true){');
  const end=html.indexOf("document.querySelectorAll('nav button').forEach(b=>b.onclick",start);
  const fn=html.slice(start,end);
  assert.match(fn,/const productsNeedFirstPaint=view==='products'&&!productRenderStatsCache/);
  assert.match(fn,/requestAnimationFrame\(\(\)=>\{if\(document\.getElementById\('products'\)\?\.classList\.contains\('active'\)\)render\(\)\}\)/);
  assert.ok(fn.indexOf("finalView.classList.add('active')")<fn.indexOf('requestAnimationFrame('));
});

test('Products static shell never shows unconfirmed zero totals',()=>{
  for(const id of ['productStockQty','productReservedQty','productInboundQty','productAtWarehouseQty','productFboQty','productStockCost','productStockProfit','productReceived30']){
    assert.match(html,new RegExp('id="'+id+'">—<'));
  }
  assert.match(html,/id="productList" class="list"><div class="empty">Подготавливаю товары…<\/div>/);
});


test('Products use the unified period standard instead of a fixed 25-day sales window',()=>{
  for(const value of ['today','yesterday','7','30','custom'])assert.ok(html.includes('data-product-period="'+value+'"'));
  for(const label of ['Сегодня','Вчера','7 дней','30 дней','Свой период'])assert.ok(html.includes('>'+label+'</button>'));
  assert.match(html,/function productPeriodSpec\(\)/);
  assert.match(html,/function ensureProductPeriodStats\(force=false\)/);
  assert.doesNotMatch(html,/Продажи\/день за 25 дней/);
});

test('Products sorts are explicit and keep a direction per sort',()=>{
  for(const value of ['name','sales','profit','unitProfit','stock','days'])assert.ok(html.includes('data-product-sort="'+value+'"'));
  assert.match(html,/productUi\.sortDirections\?\.\[sort\]/);
  assert.match(html,/sort==='sales'\?xq-yq/);
  assert.match(html,/sort==='profit'\?xp-yp/);
  assert.match(html,/sort==='unitProfit'\?xu-yu/);
});
