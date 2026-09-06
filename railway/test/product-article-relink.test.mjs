import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
const source=html.split('\n').find(line=>line.startsWith('function applyEditedMarketplaceSku('));
test('changing an article clears aliases and stale WB characteristic',()=>{
 const context={};vm.runInNewContext(source,context);
 const p={wb:'old',wbAliases:['new','legacy'],wbVariant:{market:'WB',chrtId:5}};
 assert.equal(context.applyEditedMarketplaceSku(p,'wb','new'),true);
 assert.equal(p.wb,'new');assert.deepEqual([...p.wbAliases],[]);assert.equal(p.wbVariant,undefined);
});
test('unchanged article keeps confirmed aliases and variant',()=>{
 const context={};vm.runInNewContext(source,context);
 const p={wb:'same',wbAliases:['barcode'],wbVariant:{market:'WB',chrtId:5}};
 assert.equal(context.applyEditedMarketplaceSku(p,'wb','same'),false);
 assert.deepEqual([...p.wbAliases],['barcode']);assert.equal(p.wbVariant.chrtId,5);
});
test('server removes marketplace links absent from the authoritative snapshot',()=>{
 const source=readFileSync(new URL('../src/warehouse.js',import.meta.url),'utf8');
 assert.match(source,/DELETE FROM product_links WHERE product_id=\$1 AND market=\$2 AND NOT \(sku = ANY\(\$3::text\[\]\)\)/);
});
