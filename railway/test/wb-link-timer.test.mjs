import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../src/server.js',import.meta.url),'utf8');
const start=source.indexOf('  let checkingLinks=false;'),end=source.indexOf('  setTimeout(checkLinks',start);
test('link timer contains DB discovery failures and releases its guard for the next attempt',async()=>{
 let failDiscovery=true,failFirst=false;const checked=[],warnings=[];
 const ctx={configuredWbConnectionIds:async()=>{if(failDiscovery)throw Error('connection timeout');return ['WB','WB2']},validateWbStockLinks:async market=>{checked.push(market);if(failFirst&&market==='WB')throw Error('fixture validation error');return {detached:0}},console:{warn:(...args)=>warnings.push(args),info(){}},Number,String,JSON};
 vm.runInNewContext(source.slice(start,end)+'globalThis.check=checkLinks;',ctx);
 await assert.doesNotReject(ctx.check());assert.match(warnings[0].join(' '),/configuration check failed.*connection timeout/);
 failDiscovery=false;failFirst=true;await ctx.check();assert.deepEqual(checked,['WB','WB2']);
 failFirst=false;await ctx.check();assert.deepEqual(checked,['WB','WB2','WB','WB2']);
});
