import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');

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

test('Products search aliases and WB identifiers and compute buy filter once',()=>{
  const search=html.slice(html.indexOf('function productSearchHaystack('),html.indexOf('\nfunction readProductUi',html.indexOf('function productSearchHaystack(')));
  for(const token of ['kaspiAliases','wbAliases','wb2Aliases','ozonAliases','vendorCode','nmId','chrtId','barcode'])assert.match(search,new RegExp(token));
  const render=html.slice(html.indexOf('function renderProducts('),html.indexOf('\nfunction wbRelinkNotice',html.indexOf('function renderProducts(')));
  assert.match(render,/buyIds=f==='buy'\?new Set\(purchaseRecommendations\(\)\.map/);
  assert.doesNotMatch(render,/f==='buy'&&!!purchaseRecommendation\(p\)/);
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
