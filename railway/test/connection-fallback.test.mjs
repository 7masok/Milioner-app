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
 const context={window,URL,Date,JSON,AbortController,setTimeout,clearTimeout,location:{href:'https://warehouse.test/'},MILLIONER_API:'https://warehouse.test',navigator:{onLine:true},localStorage:{getItem:()=>null},document:{getElementById:id=>elements.get(id),addEventListener(){},createElement:()=>({}),head:{appendChild(){}}}};
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


function offline(fetch){
 const elements=new Map(),events={},timers=[];let reloads=0;
 const get=id=>{if(!elements.has(id))elements.set(id,{textContent:id==='code'?'NETWORK':''});return elements.get(id)};
 const context={Date,JSON,Promise,AbortController,navigator:{onLine:true},document:{getElementById:get},location:{reload:()=>reloads++},localStorage:{getItem:()=>null,setItem(){}},window:{addEventListener:(n,f)=>events[n]=f},fetch,setInterval(){},setTimeout:f=>(timers.push(f),timers.length),clearTimeout(){}};
 vm.runInNewContext(page.match(/<script>([\s\S]*?)<\/script>/)[1],context);
 return {elements,context,timers,reloads:()=>reloads};
}
test('manual opening never waits for stuck health or automatic page probe',()=>{
 const p=offline(()=>new Promise(()=>{}));p.elements.get('retry').onclick();assert.equal(p.reloads(),1);assert.notEqual(p.elements.get('retry').disabled,true);
});
test('a working page recovers even when database health stays unavailable',async()=>{
 const p=offline(async path=>path.startsWith('/?')?new Response('<script>initOwnerAuth();</script>'):new Response('{}',{status:503}));
 for(let i=0;i<20;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(p.reloads(),1);assert.match(p.elements.get('serverCheck').textContent,/HTTP 503/);
});
test('offline probes bound stalled response bodies and show both results',async()=>{
 const p=offline(async()=>({ok:true,status:200,text:()=>new Promise(()=>{})}));
 for(const timer of p.timers)timer();
 for(let i=0;i<8;i++)await Promise.resolve();
 assert.match(p.elements.get('pageCheck').textContent,/TIMEOUT/);assert.match(p.elements.get('serverCheck').textContent,/TIMEOUT/);
});
test('HTTP 200 with an invalid warehouse body is a visible error',async()=>{
 const p=panel();p.respond(async()=>new Response('<html>proxy</html>'));await assert.rejects(p.window.fetch('https://warehouse.test/api/warehouse-state'));assert.equal(p.elements.get('connectionCode').textContent.includes('INVALID_RESPONSE'),true);
});
test('warehouse request ends even when the transport ignores abort',async()=>{
 const p=panel(),timers=[];p.context.setTimeout=f=>(timers.push(f),timers.length);p.context.clearTimeout=()=>{};
 p.respond(()=>new Promise(()=>{}));const request=p.window.fetch('https://warehouse.test/api/warehouse-state');const rejected=assert.rejects(request,{name:'TimeoutError'});timers[0]();await rejected;assert.match(p.elements.get('connectionCode').textContent,/TIMEOUT/);
});
const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
function boot(){
 const elements=new Map(),events={},timers=[];let removed=false;
 const document={scripts:[{src:'https://warehouse.test/module.js',dataset:{}}],createElement:()=>({setAttribute(){},style:{},remove(){removed=true}}),documentElement:{appendChild(){}},getElementById:id=>{if(!elements.has(id))elements.set(id,{});return elements.get(id)}};
 const window={addEventListener:(name,fn)=>events[name]=fn};
 vm.runInNewContext(html.match(/<script id="warehouse-boot-guard">([\s\S]*?)<\/script>/)[1],{window,document,Date,URL,Array,location:{href:'https://warehouse.test/',reload(){}},setTimeout:f=>(timers.push(f),1),clearTimeout(){}});
 return {window,events,timers,elements,removed:()=>removed};
}
test('boot watchdog reports a stuck script before auth runtime and allows late recovery',()=>{
 const p=boot();p.timers[0]();assert.match(p.elements.get('warehouseBootResource').textContent,/module.js/);assert.equal(p.window.warehouseBoot.canStart(),true);p.window.warehouseBoot.complete();assert.equal(p.removed(),true);
});
test('a failed required script blocks launching a partially loaded app',()=>{
 const p=boot();p.events.error({target:{tagName:'SCRIPT',src:'https://warehouse.test/missing.js'}});assert.equal(p.window.warehouseBoot.canStart(),false);assert.match(p.elements.get('warehouseBootReason').textContent,/missing.js/);
});
const server=readFileSync(new URL('../src/server.js',import.meta.url),'utf8');
test('recovered diagnostics are authenticated, bounded and strip secrets and query strings',()=>{
 const source=server.slice(server.indexOf("app.post('/api/system/client-diagnostics'"),server.indexOf("app.get('/api/system/storage-status'"));
 let handler;const logs=[],gate={};
 vm.runInNewContext(source,{app:{post:(_path,middleware,fn)=>{assert.equal(middleware,gate);handler=fn}},requireTrustedOrigin:gate,Array,String,Number,Math,Date,URL,JSON,console:{warn:(...args)=>logs.push(args)}});
 let response;handler({body:{attempts:[{path:'/?token=secret',code:'BOOT_TIMEOUT',at:Date.now(),ms:15000,secret:'do-not-log'},{path:'/api/orders',code:'NETWORK'},{path:'/health',code:'PASSWORD secret'}]}},{set(){return this},json:r=>response=r});
 assert.equal(response.ok,true);assert.equal(logs.length,1);const payload=JSON.parse(logs[0][1]);assert.equal(payload.attempts.length,1);assert.equal(payload.attempts[0].path,'/');assert.doesNotMatch(logs[0][1],/secret|token|password/i);
 assert.ok(server.indexOf("app.use('/api', requireAppSession)")<server.indexOf("app.post('/api/system/client-diagnostics'"));
});
