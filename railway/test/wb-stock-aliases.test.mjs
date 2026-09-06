import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../src/wb-stock-sync.js',import.meta.url),'utf8');
const declaration=source.match(/export function wbStockAliases[\s\S]*?\n\}/)[0].replace('export ','');
const context={};vm.runInNewContext(declaration,context);

test('WB stock sync reads aliases saved as a string',()=>{
 assert.deepEqual([...context.wbStockAliases({wb:'Я тебя люблю',wbAliases:'barcode1; barcode2\nbarcode1'},'wb')],['Я тебя люблю','barcode1','barcode2']);
});
