import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../../index.html',import.meta.url),'utf8');
const fn=name=>html.slice(html.indexOf('function '+name+'('),html.indexOf('\nfunction ',html.indexOf('function '+name+'(')+10));
test('old finance view redirects to Home and remembers the valid view',()=>{
 const classes=new Set(),saved=[];
 const home={classList:{add:x=>classes.add(x),contains:()=>true}};
 const context={document:{getElementById:id=>id==='home'?home:null,querySelectorAll:()=>[],querySelector:()=>null},localStorage:{setItem:(...x)=>saved.push(x)},ACTIVE_VIEW_KEY:'view',state:{settings:{}},saveLocalOnly(){},render(){},productRenderStatsCache:true};
 vm.runInNewContext(fn('openView').split("\ndocument.querySelectorAll('nav button')")[0]+';openView("finance");',context);
 assert.ok(classes.has('active'));assert.equal(context.state.settings.activeView,'home');assert.deepEqual(saved,[['view','home']]);
});
test('warehouse startup never starts finance hydration, watcher or statement import',()=>{
 const runtime=fn('startAppRuntime');
 assert.doesNotMatch(runtime,/bootstrapFinance|financeCacheRead|startFinanceServerWatcher|financeConsumeSharedStatement/);
 assert.match(runtime,/bootstrapWarehouseFromServer/);
 assert.doesNotMatch(html,/<section id="finance"|data-view="finance"/);
 assert.match(html,/FINANCE_OUTBOX_STORE='outbox'/);
 assert.match(html,/normalizedFinanceForBackup\(financeStateSnapshot\(\)\)/);
});
test('installed PWA retires old statement shares without reading or deleting data',async()=>{
 const manifest=JSON.parse(fs.readFileSync(new URL('../../manifest.webmanifest',import.meta.url),'utf8'));
 assert.equal(manifest.name,'Склад');assert.equal(manifest.share_target,undefined);
 const handlers={};vm.runInNewContext(fs.readFileSync(new URL('../../sw.js',import.meta.url),'utf8'),{self:{location:{origin:'https://warehouse.example'},addEventListener:(name,fn)=>handlers[name]=fn},URL,Response,Promise});
 let response;handlers.fetch({request:{method:'POST',url:'https://warehouse.example/share/finance-statement',formData(){throw Error('must not read statement')}},respondWith:r=>response=r});
 const redirect=await response;assert.equal(redirect.status,303);assert.equal(redirect.headers.get('location'),'https://warehouse.example/');
 response=null;handlers.fetch({request:{method:'GET',url:'https://warehouse.example/'},respondWith:r=>response=r});assert.equal(response,null);
});
