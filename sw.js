const SCOPE_BASE=new URL('.',self.location.href||self.location.origin+'/sw.js').pathname;
const OFFLINE_PATH=SCOPE_BASE+'offline.html';
const APP_CACHE='sklad-offline-app-v1-'+SCOPE_BASE;
const OFFLINE_CACHE='sklad-connection-screen-v4-'+SCOPE_BASE;
self.addEventListener('install',event=>event.waitUntil((async()=>{const cache=await caches.open(OFFLINE_CACHE);await cache.add(new Request(OFFLINE_PATH,{cache:'reload'}));const app=await caches.open(APP_CACHE);try{const page=await fetch(SCOPE_BASE,{cache:'reload'});if(page.ok){await app.put(SCOPE_BASE,page.clone());const html=await page.text();const urls=[...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)].map(x=>new URL(x[1],self.location.origin+SCOPE_BASE)).filter(u=>u.origin===self.location.origin&&!u.pathname.includes('/api/')&&/\.(js|css|svg|png|webmanifest)$/.test(u.pathname));await Promise.allSettled(urls.map(async u=>{const r=await fetch(u.href);if(r.ok)await app.put(u.href,r)}))}}catch{}await self.skipWaiting()})()));
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
// Business data, authenticated responses and access tokens are never cached here.
self.addEventListener('fetch',event=>{
 const url=new URL(event.request.url);
 if(url.origin!==self.location.origin)return;
 if(event.request.method==='POST'&&url.pathname==='/share/finance-statement'){
  event.respondWith(Promise.resolve(Response.redirect(new URL('/',self.location.origin).href,303)));return;
 }
 if(event.request.method==='GET'&&!url.pathname.includes('/api/')&&/\.(js|css|svg|png|webmanifest)$/.test(url.pathname)){
  event.respondWith((async()=>{const cache=await caches.open(APP_CACHE);try{const r=await fetch(event.request);if(r.ok)await cache.put(event.request,r.clone());if(r.status>=500){const saved=await cache.match(event.request);if(saved)return saved}return r}catch(error){const saved=await cache.match(event.request);if(saved)return saved;throw error}})());return;
 }
 if(event.request.method!=='GET'||event.request.mode!=='navigate'||![SCOPE_BASE,SCOPE_BASE+'index.html'].includes(url.pathname))return;
 event.respondWith((async()=>{
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);let code='NETWORK';
  try{if(self.navigator?.onLine===false)throw new TypeError('offline');const response=await fetch(event.request,{cache:'no-store',signal:controller.signal});if(response.ok||response.status<500){if(response.ok)await (await caches.open(APP_CACHE)).put(SCOPE_BASE,response.clone());return response;}code='HTTP '+response.status}
  catch(error){if(error.name==='AbortError')code='TIMEOUT'}finally{clearTimeout(timer)}
  const savedApp=await (await caches.open(APP_CACHE)).match(SCOPE_BASE);if(savedApp)return savedApp;
 const cached=await (await caches.open(OFFLINE_CACHE)).match(OFFLINE_PATH);
  const html=cached?await cached.text():'<!doctype html><meta name="viewport" content="width=device-width"><title>Склад · нет связи</title><h1>Склад временно недоступен</h1><p>Обновите страницу, чтобы проверить связь.</p>';
  return new Response(html.replace('__CONNECTION_CODE__',code),{status:503,headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}});
 })());
});

