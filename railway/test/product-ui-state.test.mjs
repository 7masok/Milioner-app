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
