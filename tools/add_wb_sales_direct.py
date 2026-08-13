from pathlib import Path

p=Path('cloudflare/millioner-api/src/fixed.js')
s=p.read_text()
marker='\nexport default {\n'
if marker not in s:
    raise SystemExit('export marker not found')
if 'async function wbSalesDirectEndpoint(' not in s:
    fn=r'''

// WB_SALES_DIRECT_V1 — D1-independent operational realized sales.
async function wbSalesDirectEndpoint(request,env,url){
  const market=normalizeMarket(url.searchParams.get('market'));
  if(!['WB','WB2'].includes(market))return json({ok:false,error:'market must be WB or WB2'},400,request,env);
  const token=String((market==='WB2'?env.WB_TOKEN_2:env.WB_TOKEN)||'').trim();
  if(!token)return json({ok:false,error:'WB token is not configured'},400,request,env);
  const raw=Number(url.searchParams.get('days')||1),days=raw===-1?-1:Math.max(1,Math.min(90,raw||1));
  const {since,until}=wbSalesPeriodBounds(days);
  const cacheKey=new Request('https://wb-direct-cache.local/sales?market='+encodeURIComponent(market)+'&days='+encodeURIComponent(days));
  const force=url.searchParams.get('refresh')==='1';
  try{
    if(!force){
      const cached=await caches.default.match(cacheKey);
      if(cached){const data=await cached.json();return json({...data,cached:true},200,request,env)}
    }
  }catch(_){}
  // WB Statistics timestamps are Moscow time. Query from the Moscow calendar date
  // containing the beginning of the selected Almaty period, then filter precisely below.
  const dateFrom=new Date(since+3*60*60*1000).toISOString().slice(0,10);
  const apiUrl=WB_STATS_BASE+'/api/v1/supplier/sales?dateFrom='+encodeURIComponent(dateFrom)+'&flag=0';
  const r=await fetch(apiUrl,{headers:{Accept:'application/json',Authorization:token}});
  let data=null;try{data=await r.json()}catch{}
  if(!r.ok){
    const retry=r.headers.get('X-RateLimit-Retry')||r.headers.get('Retry-After')||'';
    return json({ok:false,available:false,market,days,status:r.status,retryAfter:retry||null,error:data?.detail||data?.message||data?.error||('WB sales HTTP '+r.status)},r.status,request,env);
  }
  const rows=Array.isArray(data)?data:[];
  const map=new Map();let sales=0,returns=0,netQty=0,finishedPriceSum=0,priceWithDiscSum=0,forPaySum=0;
  const currencies=new Set();
  for(const x of rows){
    const saleDate=wbMoscowMs(x?.date||x?.lastChangeDate);
    if(!(saleDate>=since&&saleDate<until))continue;
    const saleId=String(x?.saleID||x?.saleId||'').trim();
    const isReturn=saleId.toUpperCase().startsWith('R');
    const sign=isReturn?-1:1;
    if(isReturn)returns++;else sales++;
    netQty+=sign;
    const finished=Number(x?.finishedPrice||0)||0,disc=Number(x?.priceWithDisc||0)||0,pay=Number(x?.forPay||0)||0;
    finishedPriceSum+=sign*finished;priceWithDiscSum+=sign*disc;forPaySum+=sign*pay;
    if(x?.currencyCode)currencies.add(String(x.currencyCode));
    const vendorCode=String(x?.supplierArticle||'').trim(),nmId=String(x?.nmId??''),barcode=String(x?.barcode||'').trim();
    const key=vendorCode||nmId||barcode||'unknown';
    let item=map.get(key);
    if(!item){item={vendorCode,nmId,barcode,title:vendorCode||nmId||barcode,qty:0,buyoutSum:0,forPay:0};map.set(key,item)}
    item.qty+=sign;item.buyoutSum+=sign*finished;item.forPay+=sign*pay;
  }
  const products=[...map.values()].filter(x=>Number(x.qty)!==0).sort((a,b)=>Math.abs(Number(b.qty))-Math.abs(Number(a.qty)));
  const result={ok:true,available:true,market,days,range:{since,until,timezone:'Asia/Almaty'},sales,returns,netQty,buyoutCount:netQty,buyoutSum:finishedPriceSum,finishedPriceSum,priceWithDiscSum,forPay:forPaySum,products,currencies:[...currencies],source:'WB Statistics supplier/sales · direct',updatedAt:Date.now()};
  try{await caches.default.put(cacheKey,new Response(JSON.stringify(result),{headers:{'Content-Type':'application/json','Cache-Control':'public,max-age=300'}}))}catch(_){}
  return json(result,200,request,env);
}
'''
    s=s.replace(marker,fn+marker,1)
route="    if (request.method === 'GET' && url.pathname === '/api/wb-sales-direct') return wbSalesDirectEndpoint(request,env,url);\n"
fetch_anchor="    if (request.method === 'GET' && url.pathname === '/api/wb-buyouts-live') return wbBuyoutsCachedEndpoint(request,env,url);\n"
if route not in s:
    if fetch_anchor not in s: raise SystemExit('fetch anchor not found')
    s=s.replace(fetch_anchor,route+fetch_anchor,1)
p.write_text(s)

# Frontend fallback: when D1-backed sales endpoint fails, use direct supplier/sales,
# not funnel analytics (which attributes buyouts to the original order date).
p=Path('index.html')
h=p.read_text()
old="const fallback=await apiJson(MILLIONER_API+'/api/wb-buyouts-live?market='+encodeURIComponent(market)+'&days='+encodeURIComponent(days)+'&refresh=1');"
new="const fallback=await apiJson(MILLIONER_API+'/api/wb-sales-direct?market='+encodeURIComponent(market)+'&days='+encodeURIComponent(days));"
if old not in h: raise SystemExit('frontend fallback URL not found')
h=h.replace(old,new,1)
h=h.replace("source:'WB Seller Analytics · buyouts fallback'","source:'WB Statistics supplier/sales · direct fallback'",1)
p.write_text(h)
