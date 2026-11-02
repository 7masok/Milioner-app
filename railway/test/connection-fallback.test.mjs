import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const sw=readFileSync(new URL('../../sw.js',import.meta.url),'utf8');
const ui=readFileSync(new URL('../../connection-status-v1.js',import.meta.url),'utf8');
const page=readFileSync(new URL('../../offline.html',import.meta.url),'utf8');
function worker(fetch){
 const handlers={};const cached=[];
 const context={URL,Request,Response,AbortController,setTimeout,clearTimeout,fetch,caches:{open:async()=>({add:async r=>cached.push(r.url),match:async()=>new Response(page)})},self:{location:{origin:'https://warehouse.test'},addEventListener:(name,fn)=>handlers[name]=fn,skipWaiting:async()=>{},clients:{claim:async()=>{}}}};
 vm.runInNewContext(sw,context);
 const navigate=()=>{let result;handlers.fetch({request:{url:'https://warehouse.test/',method:'GET',mode:'navigate'},respondWith:r=>result=r});return result};
 return {handlers,navigate,cached};
}
test('navigation failure supplies a deliberate page with the observed error, never old orders',async()=>{
 const w=worker(async()=>new Response('upstream failure',{status:502}));const r=await w.navigate();const html=await r.text();assert.equal(r.status,503);assert.match(html,/HTTP 502/);assert.match(html,/Старая страница не подставляется/);assert.doesNotMatch(html,/__CONNECTION_CODE__/);
});
test('network failure and timeout remain distinguishable, success is passed through',async()=>{
 for(const [error,code] of [[new TypeError('fetch failed'),'NETWORK'],[Object.assign(new Error(),{name:'AbortError'}),'TIMEOUT']]){const w=worker(async()=>{throw error});assert.match(await (await w.navigate()).text(),new RegExp(code))}
 const response=new Response('current warehouse');assert.equal(await worker(async()=>response).navigate(),response);
});
test('worker leaves authenticated API, unrelated pages and foreign sites alone',()=>{
 const w=worker(()=>{throw new Error('must not fetch')});
 for(const [url,mode] of [['https://warehouse.test/api/warehouse-state','cors'],['https://warehouse.test/developers','navigate'],['https://other.test/','navigate']])w.handlers.fetch({request:{url,method:'GET',mode},respondWith:()=>assert.fail('intercepted unrelated request')});
});
test('worker caches only the public status page, no business snapshot',async()=>{
 // Cache.add uses a browser-relative URL; substitute Request for this install check.
 const handlers={},cached=[];vm.runInNewContext(sw,{URL,Response,AbortController,setTimeout,clearTimeout,Request:class{constructor(url){this.url=url}},fetch:async()=>{},caches:{open:async()=>({add:async r=>cached.push(r.url)})},self:{location:{origin:'https://warehouse.test'},addEventListener:(name,fn)=>handlers[name]=fn,skipWaiting:async()=>{},clients:{claim:async()=>{}}}});
 let pending;handlers.install({waitUntil:p=>pending=p});await pending;assert.deepEqual(cached,['/offline.html']);
});
function panel(){
 const elements=new Map();for(const id of ['warehouseConnectionPanel','connectionTitle','connectionSummary','connectionReason','connectionTime','connectionSafety','connectionCode','connectionDetails','connectionDetailsToggle','connectionRetry','cloudStatus'])elements.set(id,{textContent:'',style:{},setAttribute(){}});
 let next=async()=>new Response(JSON.stringify({ok:true}),{headers:{'Content-Type':'application/json'}});
 const window={fetch:(...args)=>next(...args),addEventListener(){}};
 const context={window,URL,Date,JSON,location:{href:'https://warehouse.test/'},MILLIONER_API:'https://warehouse.test',navigator:{onLine:true},localStorage:{getItem:()=>null},document:{getElementById:id=>elements.get(id),addEventListener(){},createElement:()=>({}),head:{appendChild(){}}}};
 vm.runInNewContext(ui,context);return {window,elements,context,respond:fn=>next=fn};
}
test('warehouse errors stay visible through unrelated successes, then clear on warehouse recovery',async()=>{
 const p=panel();p.respond(async()=>new Response('{}',{status:503}));await p.window.fetch('https://warehouse.test/api/warehouse-state');assert.equal(p.elements.get('cloudStatus').textContent,'нет связи');assert.match(p.elements.get('connectionCode').textContent,/HTTP 503/);
 p.respond(async()=>new Response('{"ok":true}'));await p.window.fetch('https://warehouse.test/health');assert.equal(p.elements.get('warehouseConnectionPanel').hidden,false);
 await p.window.fetch('https://warehouse.test/api/warehouse-state');assert.equal(p.elements.get('warehouseConnectionPanel').hidden,true);
});
test('offline is an observed browser signal; unknown network failure does not blame Railway',async()=>{
 const p=panel();p.context.navigator.onLine=false;p.respond(async()=>{throw new TypeError('fetch failed')});await assert.rejects(p.window.fetch('https://warehouse.test/api/warehouse-state'));assert.equal(p.elements.get('connectionTitle').textContent,'Нет подключения к интернету');
 p.context.navigator.onLine=true;await assert.rejects(p.window.fetch('https://warehouse.test/api/warehouse-state'));assert.match(p.elements.get('connectionReason').textContent,/нельзя определить/);
});
