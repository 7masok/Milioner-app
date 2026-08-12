from pathlib import Path
p=Path('cloudflare/millioner-api/src/fixed.js')
s=p.read_text(encoding='utf-8')
if 'WB_BUYOUTS_ANALYTICS_V1' not in s:
    marker='// WB_SALES_CACHE_V1'
    if marker not in s: raise SystemExit('cache marker missing')
    block=r'''
// WB_BUYOUTS_ANALYTICS_V1
const WB_ANALYTICS_BASE='https://seller-analytics-api.wildberries.ru';
function almatyPeriodDates(days=1){
  const local=new Date(Date.now()+ALMATY_OFFSET_MS);
  const y=local.getUTCFullYear(),m=local.getUTCMonth(),d=local.getUTCDate();
  const fmt=x=>new Date(x).toISOString().slice(0,10);
  const today=Date.UTC(y,m,d);
  if(Number(days)===-1){const x=today-86400000;return {start:fmt(x),end:fmt(x)}}
  const n=Math.max(1,Math.min(365,Number(days)||1));
  return {start:fmt(today-(n-1)*86400000),end:fmt(today)};
}
async function wbAnalyticsBuyouts(request,env,url){
  const market=normalizeMarket(url.searchParams.get('market'));
  if(!['WB','WB2'].includes(market))return json({ok:false,error:'market must be WB or WB2'},400,request,env);
  const token=String((market==='WB2'?env.WB_TOKEN_2:env.WB_TOKEN)||'').trim();
  if(!token)return json({ok:false,error:'WB token is not configured'},400,request,env);
  const raw=Number(url.searchParams.get('days')||1),days=raw===-1?-1:Math.max(1,Math.min(365,raw||1)),period=almatyPeriodDates(days);
  const body={selectedPeriod:period,nmIds:[],brandNames:[],subjectIds:[],tagIds:[],skipDeletedNm:false,orderBy:{field:'buyoutCount',mode:'desc'},limit:1000,offset:0};
  const r=await fetch(WB_ANALYTICS_BASE+'/api/analytics/v3/sales-funnel/products',{method:'POST',headers:{Authorization:token,Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify(body)});
  let data=null;try{data=await r.json()}catch{}
  if(!r.ok)return json({ok:false,market,status:r.status,error:data?.detail||data?.title||data?.message||data?.data||('WB analytics HTTP '+r.status),raw:data},r.status,request,env);
  const items=Array.isArray(data?.data?.items)?data.data.items:Array.isArray(data?.items)?data.items:Array.isArray(data)?data:[];
  const links=await env.DB.prepare('SELECT sku,product_id AS productId FROM product_links WHERE market=?').bind(market).all();
  const linkMap=new Map((links.results||[]).map(x=>[String(x.sku||'').trim(),String(x.productId||'')]));
  const products=[];let buyoutCount=0,buyoutSum=0;
  for(const item of items){
    const product=item?.product||item,stat=item?.statistic?.selected||item?.selected||item?.statistic||{},nmId=String(product?.nmId??product?.nmID??''),vendorCode=String(product?.vendorCode||'').trim();
    const qty=Number(stat?.buyoutCount||0)||0,sum=Number(stat?.buyoutSum||0)||0;
    if(!qty&&!sum)continue;
    buyoutCount+=qty;buyoutSum+=sum;
    products.push({nmId,vendorCode,title:String(product?.title||product?.name||vendorCode||nmId),productId:linkMap.get(vendorCode)||linkMap.get(nmId)||'',qty,buyoutSum:sum});
  }
  return json({ok:true,market,days,period,buyoutCount,buyoutSum,products,currency:data?.data?.currency||data?.currency||null,itemCount:items.length},200,request,env);
}

'''
    s=s.replace(marker,block+marker,1)
route="    if (request.method === 'GET' && url.pathname === '/api/wb-sales-live') return wbSalesLiveCached(request, env, ctx, url);"
if route not in s: raise SystemExit('sales live route missing')
if "'/api/wb-buyouts-live'" not in s:
    s=s.replace(route,"    if (request.method === 'GET' && url.pathname === '/api/wb-buyouts-live') return wbAnalyticsBuyouts(request,env,url);\n"+route,1)
p.write_text(s,encoding='utf-8')
print('added WB analytics buyouts')
