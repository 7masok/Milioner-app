import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { automaticOfferFromRow, linkedRecoveryStock, rewriteOfferPrice } from '../src/kaspi-stock-feed.js';

test('Kaspi recovery uses the stock of the exact linked SKU before name matching', () => {
  const offer={sku:'737386976',model:'Брелок LuxAr Череп Золотистый 6 см металл 1 шт',hints:['череп золот']};
  const rowsBySku=new Map([[offer.sku,{sku:offer.sku,stock:17,name:'Любое внутреннее название'}]]);

  assert.deepEqual(linkedRecoveryStock(offer.sku,rowsBySku),{found:true,stock:17});
});

test('Kaspi recovery keeps a linked zero stock offer in the feed', () => {
  const offer={sku:'521547783',model:'Брелок LuxAr Cat Crazy 6 см металл 1 шт',hints:[]};
  const rowsBySku=new Map([[offer.sku,{sku:offer.sku,stock:0}]]);

  assert.deepEqual(linkedRecoveryStock(offer.sku,rowsBySku),{found:true,stock:0});
});

test('a new linked warehouse product becomes a complete Kaspi XML offer', () => {
  assert.deepEqual(automaticOfferFromRow({sku:'new-1',name:'Новый товар',brand:'LuxAr',price:1590,stock:8},new Set(),'30412942_PP1'),{
    sku:'new-1',model:'Новый товар',brand:'LuxAr',price:1590,stock:8,storeId:'30412942_PP1'
  });
});

test('a new Kaspi offer is not generated without its sale price', () => {
  assert.equal(automaticOfferFromRow({sku:'new-1',name:'Новый товар',stock:8},new Set(),'store'),null);
});

test('warehouse Kaspi price replaces both price formats in an existing offer', () => {
  assert.equal(rewriteOfferPrice('<price>990</price><cityprices><cityprice cityId="750000000">990</cityprice></cityprices>',1290),'<price>1290</price><cityprices><cityprice cityId="750000000">1290</cityprice></cityprices>');
});

test('Kaspi diagnostics exposes named offers missing from the uploaded XML', () => {
  const source = readFileSync(new URL('../src/stock.js', import.meta.url), 'utf8');
  assert.match(source, /missingOffers=rows\.filter/);
  assert.match(source, /name:row\.name/);
  assert.match(source, /automaticOfferFromRow\(row,effective,primaryStoreId\)/);
  assert.match(source, /effective\.size-info\.offers\.size/);
  assert.match(source, /inXml:true/);
  assert.match(source, /inXml:false/);
});
