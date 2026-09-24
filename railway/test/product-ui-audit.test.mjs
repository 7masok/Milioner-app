import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
const cloud=readFileSync(new URL('../../cloud-sync-v3.js',import.meta.url),'utf8');
const ozon=readFileSync(new URL('../../ozon-fbo-v1.js',import.meta.url),'utf8');

test('Products reload keeps the current tab without changing real-login Home behavior',()=>{
  const start=html.indexOf('function startAppRuntime(){');
  const fn=html.slice(start,start+8000);
  assert.match(fn,/savedView=localStorage\.getItem\(ACTIVE_VIEW_KEY\)/);
  assert.match(fn,/startupView=!freshLogin/);
  assert.match(fn,/localStorage\.setItem\(ACTIVE_VIEW_KEY,'home'\);orderPeriodMode='today'/);
});

test('Products UI state is device-local and survives refresh',()=>{
  assert.match(html,/const PRODUCT_UI_KEY=KEY\+'_product_ui_v1'/);
  assert.match(html,/function readProductUi\(\)/);
  assert.match(html,/function rememberProductUi\(patch=\{\}\)/);
  assert.match(html,/function restoreProductUiControls\(\)/);
  const sortStart=html.indexOf('function productSortChanged(){');
  const sortEnd=html.indexOf('\nfunction toggleProductSortDirection',sortStart);
  assert.doesNotMatch(html.slice(sortStart,sortEnd),/save\(\)/);
  assert.match(html,/rememberProductUi\(\{q:/);
  assert.match(html,/rememberProductUi\(\{filter:/);
  assert.match(html,/rememberProductUi\(\{page:productPage\}/);
});

test('Products refresh invalidates cached stock stats for both local and server changes',()=>{
  assert.match(cloud,/applyWarehouseSnapshot=function\(remote\)\{\n  if\(typeof invalidateProductRenderStats==='function'\)invalidateProductRenderStats\(\)/);
  assert.match(cloud,/save=function\(\)\{\n  if\(typeof invalidateProductRenderStats==='function'\)invalidateProductRenderStats\(\)/);
});

test('Products search covers aliases and WB variant identifiers',()=>{
  const start=html.indexOf('function productSearchHaystack(');
  const end=html.indexOf('\nfunction scheduleProductSearch',start);
  const fn=html.slice(start,end);
  for(const token of ['kaspiAliases','wbAliases','wb2Aliases','ozonAliases','vendorCode','nmId','chrtId','barcode'])assert.match(fn,new RegExp(token));
});

test('Products buy filter computes recommendations once per render',()=>{
  const start=html.indexOf('function renderProducts(');
  const end=html.indexOf('\nfunction productAllTimeProfitStats',start);
  const fn=html.slice(start,end>start?end:start+22000);
  assert.match(fn,/buyIds=f==='buy'\?new Set\(purchaseRecommendations\(\)\.map/);
  assert.doesNotMatch(fn,/f==='buy'&&!!purchaseRecommendation\(p\)/);
});

test('Product editor has one minimum-stock field and integer stock inputs',()=>{
  assert.doesNotMatch(html,/eminSimple/);
  assert.match(html,/id="pstock" type="number" min="0" step="1"/);
  assert.match(html,/id="pmin" type="number" min="0" step="1"/);
  assert.match(html,/id="emin" type="number" min="0" step="1"/);
  assert.match(html,/Начальный остаток должен быть целым числом от 0/);
  assert.match(html,/Минимальный остаток должен быть целым числом от 0/);
  assert.match(html,/bundle-qty" type="number" min="1" step="1"/);
});

test('Product cards escape image URLs and are keyboard reachable',()=>{
  const line=html.split('\n').find(x=>x.startsWith('function productCard('));
  assert.match(line,/src="\$\{esc\(p\.photo\)\}"/);
  assert.match(line,/role="button"/);
  assert.match(line,/tabindex="0"/);
  assert.match(line,/event\.key==='Enter'/);
});

test('Products use honest loading states for warehouse and Ozon data',()=>{
  assert.match(html,/Загружаю товары…/);
  assert.match(html,/id="productFboQty">—</);
  assert.match(ozon,/el\.textContent=data\?fboTotal/);
  assert.match(ozon,/qty===null\?'—'/);
});

test('bottom navigation allocates one column per actual tab',()=>{
  assert.match(html,/grid-template-columns:repeat\(8,minmax\(0,1fr\)\)/);
  assert.ok((html.match(/data-view="/g)||[]).length>=8);
});
