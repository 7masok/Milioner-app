import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../../cloud-sync-v3.js',import.meta.url),'utf8');
test('warehouse snapshots never serialize excluded marketplace histories or personal finance',()=>{
 const begin=source.indexOf('function serverSnapshot(source){'),end=source.indexOf('function snapshotText',begin),ctx={WAREHOUSE_VOLATILE_SETTINGS:['serverMarketStatus'],FINANCE_STORAGE_KEYS:['personalFinanceTransactions']};
 vm.createContext(ctx);vm.runInContext("const SERVER_MANAGED_CACHE_KEYS=['kaspiOrderFeed','wbOrderFeed','ozonOrderFeed','kaspiOrders','marketOrderState','marketplaceLiveSince'];"+source.slice(begin,end)+'this.snapshot=serverSnapshot;',ctx);
 const large={toJSON(){throw Error('excluded data was copied')}},input={products:[{id:'p',name:'test'}],sales:[],kaspiOrderFeed:large,wbOrderFeed:large,ozonOrderFeed:large,kaspiPayImports:large,settings:{test:true,personalFinanceTransactions:large,serverMarketStatus:large}};
 const result=ctx.snapshot(input);assert.equal(result.products[0].id,'p');assert.equal(result.settings.test,true);assert.equal(result.kaspiOrderFeed,undefined);assert.equal(result.settings.personalFinanceTransactions,undefined);
 result.products[0].name='copy';assert.equal(input.products[0].name,'test');assert.equal(input.kaspiOrderFeed,large);assert.equal(input.settings.personalFinanceTransactions,large);
});
