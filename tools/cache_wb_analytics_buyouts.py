from pathlib import Path
p=Path('cloudflare/millioner-api/src/fixed.js')
s=p.read_text(encoding='utf-8')

if 'WB_BUYOUT_CACHE_V2' not in s:
    marker='// WB_BUYOUTS_ANALYTICS_V1'
    if marker not in s: raise SystemExit('analytics marker missing')
    block=r'''
// WB_BUYOUT_CACHE_V2
const WB_BUYOUT_REFRESH_MS=30*60*1000;
async function ensureWbBuyoutCache(db){
  await db.prepare(`CREATE TABLE IF NOT EXISTS wb_buyout_cache(
    market TEXT NOT NULL,period_key TEXT NOT NULL,payload TEXT NOT NULL DEFAULT '',updated_at INTEGER NOT NULL DEFAULT 0,
    last_attempt_at INTEGER NOT NULL DEFAULT 0,last_error TEXT NOT NULL DEFAULT '',PRIMARY KEY(market,period_key))`).run();
}
async function fetchWbAnalyticsBuyoutsData(env,market,days){
  const token=String((market==='WB2'?env.WB_TOKEN_2:env.WB_TOKEN)||'').trim();
  if(!token)throw Object.assign(new Error('WB token is not configured'),{status:400});
  const period=almatyPeriodDates(days);
  const body={selectedPeriod:period,nmIds:[],brandNames:[],subjectIds:[],tagIds:[],skipDeletedNm:false,orderBy:{field:'buyoutCount',mode:'desc'},limit:1000,offset:0};
  const r=await fetch(WB_ANALYTICS_BASE+'/api/analytics/v3/sales-funnel/products',{method:'POST',headers:{Authorization:token,Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify(body)});
  let data=null;try{data=await r.json()}catch{}
  if(!r.ok){const e=new Error(String(data?.detail||data?.title||data?.message||data?.data||('WB analytics HTTP '+r.status)));e.status=r.status;e.retryAfter=r.headers.get('X-RateLimit-Retry')||r.headers.get('Retry-After')||'';throw e}
  const items=Array.isArray(data?.data?.products)?data.data.products:Array.isArray(data?.data?.items)?data.data.items:Array.isArray(data?.products)?data.products:Array.isArray(data?.items)?data.items:Array.isArray(data)?data:[];
  const links=await env.DB.prepare('SELECT sku,product_id AS productId FROM product_links WHERE market=?').bind(market).all();
  const linkMap=new Map((links.results||[]).map(x=>[String(x.sku||'').trim(),String(x.productId||'')]));
  const products=[];let buyoutCount=0,buyoutSum=0;
  for(const item of items){const product=item?.product||item,stat=item?.statistic?.selected||item?.selected||item?.statistic||{},nmId=String(product?.nmId??product?.nmID??''),vendorCode=String(product?.vendorCode||'').trim(),qty=Number(stat?.buyoutCount||0)||0,sum=Number(stat?.buyoutSum||0)||0;if(!qty&&!sum)continue;buyoutCount+=qty;buyoutSum+=sum;products.push({nmId,vendorCode,title:String(product?.title||product?.name||vendorCode||nmId),productId:linkMap.get(vendorCode)||linkMap.get(nmId)||'',qty,buyoutSum:sum})}
  return {ok:true,available:true,market,days,period,buyoutCount,buyoutSum,products,currency:data?.data?.currency||data?.currency||null,itemCount:items.length,source:'WB Analytics · buyouts'};
}
async function readWbBuyoutCache(env,market,days){
  await ensureWbBuyoutCache(env.DB);const key=String(days);const row=await env.DB.prepare('SELECT * FROM wb_buyout_cache WHERE market=? AND period_key=?').bind(market,key).first();
  if(!row||!row.payload)return {ok:true,available:false,market,days,buyoutCount:null,buyoutSum:null,products:[],updatedAt:null,lastError:String(row?.last_error||''),source:'WB Analytics · cache'};
  let data={};try{data=JSON.parse(row.payload)}catch{}
  return {...data,ok:true,available:true,cached:true,updatedAt:Number(row.updated_at||0)||null,lastError:String(row.last_error||''),stale:Date.now()-Number(row.updated_at||0)>WB_BUYOUT_REFRESH_MS*2};
}
async function refreshWbBuyoutCache(env,market,days=1,{force=false}={}){
  await ensureWbBuyoutCache(env.DB);const key=String(days),now=Date.now(),row=await env.DB.prepare('SELECT * FROM wb_buyout_cache WHERE market=? AND period_key=?').bind(market,key).first();
  if(!force&&row?.last_attempt_at&&now-Number(row.last_attempt_at)<WB_BUYOUT_REFRESH_MS)return readWbBuyoutCache(env,market,days);
  await env.DB.prepare(`INSERT INTO wb_buyout_cache(market,period_key,payload,updated_at,last_attempt_at,last_error) VALUES(?,?,?,?,?,?) ON CONFLICT(market,period_key) DO UPDATE SET last_attempt_at=excluded.last_attempt_at`).bind(market,key,String(row?.payload||''),Number(row?.updated_at||0),now,String(row?.last_error||'')).run();
  try{const data=await fetchWbAnalyticsBuyoutsData(env,market,days);await env.DB.prepare('UPDATE wb_buyout_cache SET payload=?,updated_at=?,last_attempt_at=?,last_error=? WHERE market=? AND period_key=?').bind(JSON.stringify(data),Date.now(),now,'',market,key).run();return {...data,cached:true,updatedAt:Date.now(),lastError:''}}
  catch(e){const msg=String(e?.message||e)+(e?.retryAfter?' · retry '+e.retryAfter:'');await env.DB.prepare('UPDATE wb_buyout_cache SET last_error=? WHERE market=? AND period_key=?').bind(msg,market,key).run();const cached=await readWbBuyoutCache(env,market,days);return {...cached,refreshOk:false,lastError:msg,status:Number(e?.status||0)||null}}
}
async function wbBuyoutsCachedEndpoint(request,env,url){
  const market=normalizeMarket(url.searchParams.get('market'));if(!['WB','WB2'].includes(market))return json({ok:false,error:'market must be WB or WB2'},400,request,env);
  const raw=Number(url.searchParams.get('days')||1),days=raw===-1?-1:Math.max(1,Math.min(365,raw||1));
  const refresh=url.searchParams.get('refresh')==='1';
  const data=refresh?await refreshWbBuyoutCache(env,market,days,{force:false}):await readWbBuyoutCache(env,market,days);
  return json(data,200,request,env);
}

'''
    s=s.replace(marker,block+marker,1)

old="    if (request.method === 'GET' && url.pathname === '/api/wb-buyouts-live') return wbAnalyticsBuyouts(request,env,url);"
new="    if (request.method === 'GET' && url.pathname === '/api/wb-buyouts-live') return wbBuyoutsCachedEndpoint(request,env,url);"
if old not in s: raise SystemExit('buyouts route marker missing')
s=s.replace(old,new,1)

old_sched="""  async scheduled(controller, env, ctx) {
    if (typeof base.scheduled === 'function') base.scheduled(controller, env, ctx);
    if (ctx?.waitUntil) ctx.waitUntil((async()=>{
      for (const market of ['WB','WB2']) await syncWbSalesCache(env, market, {force:false});
    })());
  }"""
new_sched="""  async scheduled(controller, env, ctx) {
    const when=Number(controller?.scheduledTime||Date.now()),minute=new Date(when).getUTCMinutes();
    if(minute===15||minute===45){
      if(ctx?.waitUntil)ctx.waitUntil(Promise.all(['WB','WB2'].map(m=>refreshWbBuyoutCache(env,m,1,{force:false}))));
      return;
    }
    if (typeof base.scheduled === 'function') return base.scheduled(controller, env, ctx);
  }"""
if old_sched not in s: raise SystemExit('scheduled cache block missing')
s=s.replace(old_sched,new_sched,1)

# Disable any external Statistics API refresh from the legacy cached route. It should only return stored rows.
old_live="""  const shouldRefresh = !state?.last_success_at || Date.now()-Number(state.last_success_at)>WB_SALES_REFRESH_MS;
  if (Number(count?.n||0) === 0 && shouldRefresh) await syncWbSalesCache(env, market, {force:false});
  else if (shouldRefresh && ctx?.waitUntil) ctx.waitUntil(syncWbSalesCache(env, market, {force:false}));
  return json(await readWbSalesCache(env, market, days),200,request,env);"""
new_live="""  return json(await readWbSalesCache(env, market, days),200,request,env);"""
if old_live in s:s=s.replace(old_live,new_live,1)
p.write_text(s,encoding='utf-8')

h=Path('index.html');t=h.read_text(encoding='utf-8')
# Switch report/overview reads from legacy supplier/sales cache to dashboard buyouts cache.
t=t.replace("MILLIONER_API+'/api/wb-sales-live?market='+encodeURIComponent(market)+'&days='+encodeURIComponent(days)","MILLIONER_API+'/api/wb-buyouts-live?market='+encodeURIComponent(market)+'&days='+encodeURIComponent(days)")
t=t.replace("MILLIONER_API+'/api/wb-sales-live?market='+encodeURIComponent(market)+'&days='+encodeURIComponent(periodDays)","MILLIONER_API+'/api/wb-buyouts-live?market='+encodeURIComponent(market)+'&days='+encodeURIComponent(periodDays)")
# Overview: analytics uses buyoutCount/buyoutSum instead of netQty/finishedPrice.
t=t.replace("qty=Number(live.netQty||0);const lr=(live.products||[]).reduce((x,p)=>x+(Number(p.finishedPrice)||0),0);if(lr)channelRev=lr;","qty=Number(live.buyoutCount||0);const lr=Number(live.buyoutSum||0);if(lr)channelRev=lr;")
# Detailed rows: buyout endpoint has buyoutSum, not forPay. Finance remains exact when present.
t=t.replace("const preliminaryPayout=Number(x.forPay)||0,profit=preliminaryPayout-cost;","const preliminaryPayout=Number(x.buyoutSum)||0,profit=preliminaryPayout-cost;")
t=t.replace("else body=`<div class=\"empty\">За ${esc(periodText)} WB не вернул выкупов/возвратов в оперативном отчёте.</div>`;","else body=live.available===false?`<div class=\"empty\">Выкупы WB за ${esc(periodText)} ещё синхронизируются. Ноль не подставляется — дождёмся данных WB.</div>`:`<div class=\"empty\">За ${esc(periodText)} выкупов WB нет.</div>`;")
t=t.replace("Количество — фактические продажи/возвраты из оперативного отчёта WB.","Количество — показатель «Выкупы» из аналитики WB.")
t=t.replace("Оперативный выкуп WB · к перечислению предварительно","Выкуп WB · сумма выкупов предварительно")
h.write_text(t,encoding='utf-8')
print('cached WB analytics buyouts; disabled request-on-open')
