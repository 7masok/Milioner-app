import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
function fixture(fetch,token='saved-session'){
 const timers=new Map(),local=new Map([['session',token]]),session=new Map(local),button={disabled:false,textContent:'Войти'},input={value:'test-code'},errors=[],modes=[];let id=0,started=0;
 const storage=map=>({removeItem:key=>map.delete(key),setItem:(key,value)=>map.set(key,value)});
 const ctx=vm.createContext({AbortController,Promise,Error,Boolean,Number,String,JSON,nativeFetch:fetch,MILLIONER_API:'https://warehouse.test',APP_SESSION_KEY:'session',ownerSessionToken:token,ownerAuthEnabled:false,ownerAuthInfo:{},localStorage:storage(local),sessionStorage:storage(session),setTimeout:fn=>{timers.set(++id,fn);return id},clearTimeout:key=>timers.delete(key),document:{getElementById:key=>key==='ownerLoginButton'?button:key==='ownerPassword'?input:null},setOwnerLoginError:value=>errors.push(value),setOwnerAuthMode:(mode,error)=>modes.push({mode,error}),startOwnerRuntimeAfterAuth:()=>started++,renderOwnerLogin:()=>{},rememberOwnerSession:()=>started++});
 for(const [start,end] of [['async function ownerAuthRequest(', 'async function initOwnerAuth('],['async function initOwnerAuth(', 'function rememberOwnerSession('],['async function ownerAuthSubmit(', 'async function ownerWebAuthnLogin(']]) vm.runInContext(html.slice(html.indexOf(start),html.indexOf(end,html.indexOf(start))),ctx);
 return {ctx,timers,local,session,button,errors,modes,get started(){return started}};
}
const reply=(status,data={})=>({ok:status>=200&&status<300,status,json:async()=>data});
test('stalled login times out, aborts its request and enables another attempt',async()=>{
 let signal;const f=fixture((_url,options)=>{signal=options.signal;return new Promise(()=>{})});
 const pending=f.ctx.ownerAuthSubmit();assert.equal(f.button.disabled,true);[...f.timers.values()][0]();await pending;
 assert.equal(signal.aborted,true);assert.equal(f.button.disabled,false);assert.equal(f.button.textContent,'Войти');assert.match(f.errors.at(-1),/20 секунд/);assert.equal(f.started,0);assert.equal(f.timers.size,0);
});
test('timeout covers a response whose body never arrives',async()=>{
 const f=fixture(async()=>({ok:true,status:200,json:()=>new Promise(()=>{})}));const pending=f.ctx.ownerAuthSubmit();await Promise.resolve();[...f.timers.values()][0]();await pending;assert.match(f.errors.at(-1),/20 секунд/);assert.equal(f.button.disabled,false);assert.equal(f.started,0);
});
test('temporary session errors keep the token and never unlock the app',async()=>{
 for(const status of [429,500,502,503]){const f=fixture(async()=>reply(status));await f.ctx.initOwnerAuth();assert.equal(f.local.get('session'),'saved-session');assert.equal(f.session.get('session'),'saved-session');assert.equal(f.ctx.ownerSessionToken,'saved-session');assert.equal(f.started,0);assert.equal(f.modes.at(-1).mode,'locked')}
});
test('session timeout keeps credentials; retry can validate the same session',async()=>{
 let hang=true;const f=fixture(async()=>hang?new Promise(()=>{}):reply(200));const pending=f.ctx.initOwnerAuth();[...f.timers.values()][0]();await pending;assert.equal(f.local.get('session'),'saved-session');assert.equal(f.started,0);hang=false;await f.ctx.initOwnerAuth();assert.equal(f.started,1);assert.equal(f.timers.size,0);
});
test('expired sessions are cleared while invalid config never bypasses login',async()=>{
 const f=fixture(async url=>url.endsWith('/session')?reply(401):reply(200,{enabled:true}));await f.ctx.initOwnerAuth();assert.equal(f.local.has('session'),false);assert.equal(f.ctx.ownerSessionToken,'');assert.equal(f.started,0);
 for(const response of [reply(502),reply(200,{})]){const invalid=fixture(async()=>response,'');await invalid.ctx.initOwnerAuth();assert.equal(invalid.started,0);assert.equal(invalid.modes.at(-1).mode,'locked')}
});
test('wrong code is visible and permits retry',async()=>{
 const f=fixture(async()=>reply(401,{error:'wrong-password'}));await f.ctx.ownerAuthSubmit();assert.equal(f.errors.at(-1),'Неверный код доступа');assert.equal(f.button.disabled,false);assert.equal(f.started,0);assert.match(html, /id="ownerLoginError" class="login-error" role="alert"/);
});
