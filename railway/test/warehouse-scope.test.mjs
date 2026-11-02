import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import express from 'express';
import { createInfernoProxy, infernoSession, withWarehouseScopePage } from '../src/warehouse-scope.js';

const bootstrap = readFileSync(new URL('../../warehouse-scope-bootstrap.js', import.meta.url), 'utf8');
const ui = readFileSync(new URL('../../warehouse-scope-v1.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
function storage() {
  const data = new Map();
  return { get length() { return data.size; }, key: i => [...data.keys()][i] ?? null,
    getItem: k => data.get(String(k)) ?? null, setItem: (k,v) => data.set(String(k),String(v)), removeItem: k => data.delete(String(k)), clear: () => data.clear() };
}
function browser({ inferno = true, embedded = true } = {}) {
  const local = storage(), session = storage(), navigations = [], databases = [];
  const ctx = { WAREHOUSE_SCOPE_CONFIG: { inferno, enabled: true }, localStorage: local, sessionStorage: session,
    location: { origin: 'https://warehouse.test', pathname: embedded ? '/inferno/' : '/', search: '?view=purchases', replace: u => navigations.push(u), assign: u => navigations.push(u) },
    indexedDB: { open: name => databases.push(name), deleteDatabase: name => databases.push('delete:' + name) },
    URLSearchParams, AbortController, setTimeout, clearTimeout, fetch: async () => Response.json({token:'inferno-session'}),
  };
  ctx.window = ctx; vm.createContext(ctx); vm.runInContext(bootstrap, ctx);
  return { ctx, local, session, navigations, databases };
}
test('all browser data, literal cache keys, queues and IndexedDB stay separate in one origin', () => {
  const f = browser();
  const keys = ['sklad_mvp_v2','milioner_server_snapshot_cache_v2','milioner_report_market_v1','adsSelectedMarket','pending_edits'];
  for (const key of keys) { f.local.setItem(key,'MAIN'); assert.equal(f.ctx.localStorage.getItem(key), null); f.ctx.localStorage.setItem(key,'INFERNO'); assert.equal(f.local.getItem(key),'MAIN'); }
  f.ctx.localStorage.extra = 'child'; assert.equal(f.local.getItem('extra'),null);
  assert.equal(f.ctx.localStorage.length, keys.length + 1);
  assert.deepEqual(Object.keys(f.ctx.localStorage).sort(), [...keys,'extra'].sort());
  f.ctx.sessionStorage.setItem('unsaved','child'); assert.equal(f.session.getItem('unsaved'),null);
  f.ctx.indexedDB.open('warehouse-cache'); f.ctx.indexedDB.deleteDatabase('warehouse-cache');
  assert.deepEqual(f.databases,['inferno:warehouse-cache','delete:inferno:warehouse-cache']);
  f.ctx.localStorage.clear(); for (const key of keys) assert.equal(f.local.getItem(key),'MAIN');
  assert.equal(f.ctx.MILLIONER_API_URL,'https://warehouse.test/inferno');
});
test('main application retains its existing cache and credentials', () => {
  const f = browser({inferno:false,embedded:false});
  assert.equal(f.ctx.localStorage,f.local); assert.equal(f.ctx.sessionStorage,f.session);
  assert.equal(f.ctx.WB3_ONLY,false); assert.equal(f.ctx.MILLIONER_API_URL,undefined);
});
test('one sign-in exchanges a parent session without copying it into the Inferno namespace', async () => {
  const f = browser(); const key='sklad_mvp_v2_owner_session'; f.local.setItem(key,'main-session');
  f.ctx.fetch=async (path,options) => { assert.equal(path,'/api/inferno/session'); assert.equal(options.headers.Authorization,'Bearer main-session'); return Response.json({token:'inferno-session'}); };
  const session=await f.ctx.warehouseScope.session();
  assert.equal(session.token,'inferno-session'); assert.equal(f.ctx.localStorage.getItem(key),'inferno-session'); assert.equal(f.local.getItem(key),'main-session');
  f.ctx.warehouseScope.logout(); assert.equal(f.local.getItem(key),null); assert.equal(f.ctx.localStorage.getItem(key),null);
});
test('an expired parent session returns to the main sign-in with the requested section', async () => {
  const f=browser(); f.local.setItem('sklad_mvp_v2_owner_session','expired'); f.ctx.fetch=async()=>new Response('',{status:401});
  assert.equal(await f.ctx.warehouseScope.session(),false); assert.deepEqual(f.navigations,['/?warehouse=inferno&view=purchases']);
});
test('a scope handoff remembers its section once so a later reload restores the current tab', () => {
  const f=browser(), urls=[]; f.ctx.history={replaceState:(_state,_title,url)=>urls.push(url)};
  assert.equal(f.ctx.warehouseScope.afterAuth(),true);
  assert.equal(f.ctx.localStorage.getItem('sklad_mvp_v2_active_view_device'),'purchases');
  assert.deepEqual(urls,['/inferno/']);
  assert.equal(f.local.getItem('sklad_mvp_v2_active_view_device'),null);
});
test('delegated sessions retain the parent expiry and are signed only by the Inferno secret', () => {
  const now=Date.now(),expiry=now+123456,parent=expiry+'.parent.signature',result=infernoSession(parent,'inferno-secret',now);
  const [at,nonce,signature]=result.token.split('.'),body=at+'.'+nonce;
  assert.equal(result.expiresAt,expiry);
  assert.equal(signature,crypto.createHmac('sha256','inferno-secret').update(body).digest('base64url'));
  assert.notEqual(signature,crypto.createHmac('sha256','main-secret').update(body).digest('base64url'));
  assert.throws(()=>infernoSession(now+'.expired.signature','inferno-secret',now));
  assert.throws(()=>infernoSession(parent,'',now));
});
test('every section has a shared scope switch, and the main page does not install the Inferno runtime', () => {
  const main=withWarehouseScopePage(html,{enabled:true}), child=withWarehouseScopePage(html,{inferno:true,enabled:true});
  assert.match(main,/id="warehouseScopeSwitch"/); assert.match(main,/Все магазины/); assert.match(main,/data-scope="inferno"/);
  assert.doesNotMatch(main,/<script src="\.\/wb3-profile/);
  assert.ok(child.indexOf('warehouse-scope-bootstrap.js')<child.indexOf("const KEY="));
  assert.ok(child.indexOf('wb3-orders-v1.js')<child.indexOf('<script>initOwnerAuth();'));
  for(const match of child.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
});
test('scope switching blocks pending saves and retains the active section', async () => {
  const f=browser({inferno:false,embedded:false}), alerts=[];
  Object.assign(f.ctx,{document:{getElementById:()=>null,querySelector:()=>({dataset:{view:'reports'}})},alert:m=>alerts.push(m),warehouseSaveInFlight:true,warehouseLocalDirty:true,pushWarehouseToServer:async()=>false});
  vm.runInContext(ui,f.ctx); await f.ctx.switchWarehouseScope('inferno'); assert.equal(f.navigations.length,0);
  f.ctx.warehouseSaveInFlight=false; await f.ctx.switchWarehouseScope('inferno'); assert.equal(f.navigations.length,0);
  f.ctx.pushWarehouseToServer=async()=>{f.ctx.warehouseLocalDirty=false;return true;}; await f.ctx.switchWarehouseScope('inferno');
  assert.deepEqual(f.navigations,['/inferno/?view=reports']); assert.equal(alerts.length,2);
});

async function listen(app,t) { const server=app.listen(0,'127.0.0.1'); await new Promise(resolve=>server.on('listening',resolve)); t.after(()=>{server.closeAllConnections();server.close();});return 'http://127.0.0.1:'+server.address().port; }
test('gateway reads and writes only the isolated backend and preserves auth, revision and binary bodies', async t => {
  const mainState={products:['main'],purchases:['main purchase']}; let childState={products:['inferno'],purchases:['inferno purchase']};
  const child=express(); child.use(express.json());
  child.use((req,res,next)=>{if(req.headers.authorization!=='Bearer child-token')return res.sendStatus(401);next();});
  child.get('/api/warehouse-state',(req,res)=>res.set('X-Warehouse-Revision','12').json({ok:true,state:childState}));
  child.put('/api/warehouse-state',(req,res)=>{assert.equal(req.headers['if-match'],'12');childState=req.body.state;res.json({ok:true,revision:13});});
  child.get('/api/purchase.pdf',(_req,res)=>res.type('application/pdf').send(Buffer.from('%PDF-fixture')));
  const upstream=await listen(child,t),parent=express(); parent.use('/inferno',createInfernoProxy(upstream)); const origin=await listen(parent,t);
  let response=await fetch(origin+'/inferno/api/warehouse-state'); assert.equal(response.status,401);
  const headers={Authorization:'Bearer child-token'};
  response=await fetch(origin+'/inferno/api/warehouse-state',{headers}); assert.equal(response.headers.get('x-warehouse-revision'),'12'); assert.deepEqual((await response.json()).state,childState);
  response=await fetch(origin+'/inferno/api/warehouse-state',{method:'PUT',headers:{...headers,'Content-Type':'application/json','If-Match':'12'},body:JSON.stringify({state:{products:['new inferno'],purchases:['new purchase']}})});
  assert.equal((await response.json()).revision,13); assert.deepEqual(mainState,{products:['main'],purchases:['main purchase']}); assert.deepEqual(childState.products,['new inferno']);
  response=await fetch(origin+'/inferno/api/purchase.pdf',{headers}); assert.equal(await response.text(),'%PDF-fixture');
  assert.equal(response.headers.get('cache-control'),'no-store');
});
