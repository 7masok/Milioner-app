import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

import { automaticOfferFromRow, linkedRecoveryStock, rewriteOfferPrice, includeDeletedKaspiStocks } from '../src/kaspi-stock-feed.js';

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

test('Kaspi diagnostics exposes linked offers missing from the uploaded XML', () => {
  const source = readFileSync(new URL('../src/stock.js', import.meta.url), 'utf8');
  assert.match(source, /missingOffers=rows\.filter/);
  assert.match(source, /name:row\.name/);
  assert.match(source, /automaticOfferFromRow\(row,effective,primaryStoreId\)/);
  assert.match(source, /recoveredOffers:Math\.max\(0,effective\.size-info\.offers\.size\)/);
  assert.match(source, /missingSkus/);
  assert.match(source, /missingPrimaryStore/);
});

test('deleted or unlinked warehouse-managed SKU gets zero, current links win, unrelated template offers stay untouched',()=>{
 const input=new Map([['live',8],['zero',0]]),result=includeDeletedKaspiStocks(input,['deleted','live','zero','']);
 assert.equal(result.get('deleted'),0);assert.equal(result.get('live'),8);assert.equal(result.get('zero'),0);assert.equal(result.has('unmanaged-template'),false);assert.equal(input.has('deleted'),false);
});
test('Kaspi history survives product deletion and alias edits; feed retains zero-stock offers',()=>{
 const migration=readFileSync(new URL('../migrations/149_kaspi_managed_offer_history.sql',import.meta.url),'utf8'),source=readFileSync(new URL('../src/stock.js',import.meta.url),'utf8');
 assert.match(migration,/AFTER INSERT OR UPDATE OR DELETE ON warehouse_products/);assert.match(migration,/kaspi_product_skus\(OLD.payload\)/);assert.match(migration,/kaspi_product_skus\(NEW.payload\)/);assert.match(migration,/kaspiAliases/);assert.match(migration,/CROSS JOIN LATERAL/);assert.match(source,/stocks=includeDeletedKaspiStocks/);assert.match(source,/stock>0\?'yes':'no'/);
});

test('actual XML generator zeroes deleted offer in every store, preserves XML-only stock and restores a new exact link',async()=>{
 const source=readFileSync(new URL('../src/stock.js',import.meta.url),'utf8');let linked=[];
 const raw='<kaspi_catalog><offers><offer sku="deleted"><model>Removed</model><availabilities><availability storeId="PP1" available="yes" stockCount="3.0"/><availability storeId="PP2" available="yes" stockCount="2"/></availabilities><price>690</price></offer><offer sku="external"><availability storeId="PP1" available="yes" stockCount="59"/><price>990</price></offer></offers></kaspi_catalog>';
 const c={Map,Set,Date,Number,String,Math,automaticOfferFromRow,linkedRecoveryStock,rewriteOfferPrice,includeDeletedKaspiStocks,pool:{query:async()=>({rows:[{sku:'deleted'}]})},liveTemplate:async()=>({rawXml:raw,primaryStoreId:'PP1'}),warehouseKaspiRows:async()=>linked,KASPI_RECOVERY_OFFERS:[],templateInfo:()=>({offers:new Map([['deleted',{}],['external',{}]]),storeIds:['PP1','PP2']}),appendOffers:x=>x};
 vm.runInNewContext(source.slice(source.indexOf('function n('),source.indexOf('function recoveryOfferStock(')),c);vm.runInNewContext(source.slice(source.indexOf('async function liveKaspiXml()'),source.indexOf('export async function kaspiFeedRows')),c);
 const xml=await c.liveKaspiXml();assert.match(xml,/<availability storeId="PP1" available="no" stockCount="0"/);assert.match(xml,/<availability storeId="PP2" available="no" stockCount="0"/);assert.match(xml,/<offer sku="external"><availability storeId="PP1" available="yes" stockCount="59"/);assert.match(xml,/<price>690<\/price>/);
 linked=[{sku:'deleted',stock:7,price:690}];const restored=await c.liveKaspiXml();assert.match(restored,/<availability storeId="PP1" available="yes" stockCount="7"/);
});
