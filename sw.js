const SHARE_CACHE='sklad-share-target-v1';
const SHARE_KEY='/__shared_finance_statement__';

self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));

self.addEventListener('fetch',event=>{
  const request=event.request;
  const url=new URL(request.url);
  if(request.method==='POST'&&url.pathname==='/share/finance-statement'){
    event.respondWith((async()=>{
      try{
        const form=await request.formData();
        const file=form.get('statement');
        if(!(file instanceof File)||(!/\.pdf$/i.test(file.name)&&file.type!=='application/pdf')){
          return Response.redirect(new URL('/?share=finance-statement&error=pdf',self.location.origin).href,303);
        }
        if(file.size>4800000){
          return Response.redirect(new URL('/?share=finance-statement&error=size',self.location.origin).href,303);
        }
        const cache=await caches.open(SHARE_CACHE);
        const key=new Request(new URL(SHARE_KEY,self.location.origin).href);
        await cache.put(key,new Response(file,{
          headers:{
            'Content-Type':file.type||'application/pdf',
            'X-Sklad-Shared-Filename':encodeURIComponent(file.name||'statement.pdf')
          }
        }));
        return Response.redirect(new URL('/?share=finance-statement',self.location.origin).href,303);
      }catch(error){
        return Response.redirect(new URL('/?share=finance-statement&error=read',self.location.origin).href,303);
      }
    })());
  }
});
