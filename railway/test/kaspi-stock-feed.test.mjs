import test from 'node:test';
import assert from 'node:assert/strict';

import { linkedRecoveryStock } from '../src/kaspi-stock-feed.js';

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
