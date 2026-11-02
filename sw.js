const SCOPE_BASE=new URL('.',self.location.href||self.location.origin+'/sw.js').pathname;
const OFFLINE_PATH=SCOPE_BASE+'offline.html';
const OFFLINE_CACHE='sklad-connection-screen-v3-'+SCOPE_BASE;
self.addEventListener('install',event=>event.waitUntil((async()=>{const cache=await caches.open(OFFLINE_CACHE);await cache.add(new Request(OFFLINE_PATH,{cache:'reload'}));await self.skipWaiting()})()));
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
// Business data, authenticated responses and access tokens are never cached here.
self.addEventListener('fetch',event=>{
 const url=new URL(event.request.url);
 if(url.origin!==self.location.origin)return;
 if(event.request.method==='POST'&&url.pathname==='/share/finance-statement'){
  event.respondWith(Promise.resolve(Response.redirect(new URL('/',self.location.origin).href,303)));return;
 }
 if(event.request.method!=='GET'||event.request.mode!=='navigate'||![SCOPE_BASE,SCOPE_BASE+'index.html'].includes(url.pathname))return;
 event.respondWith((async()=>{
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);let code='NETWORK';
  try{const response=await fetch(event.request,{cache:'no-store',signal:controller.signal});if(response.ok||response.status<500){await response.clone().text();return response;}code='HTTP '+response.status}
  catch(error){if(error.name==='AbortError')code='TIMEOUT'}finally{clearTimeout(timer)}
  const cached=await (await caches.open(OFFLINE_CACHE)).match(OFFLINE_PATH);
  const html=cached?await cached.text():'<!doctype html><meta name="viewport" content="width=device-width"><title>Склад · нет связи</title><h1>Склад временно недоступен</h1><p>Обновите страницу, чтобы проверить связь.</p>';
  return new Response(html.replace('__CONNECTION_CODE__',code),{status:503,headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}});
 })());
});

