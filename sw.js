self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
// Retire the bank-statement share target for previously installed warehouse PWAs.
self.addEventListener('fetch',event=>{
 const url=new URL(event.request.url);
 if(event.request.method==='POST'&&url.pathname==='/share/finance-statement'){
  event.respondWith(Promise.resolve(Response.redirect(new URL('/',self.location.origin).href,303)));
 }
});
