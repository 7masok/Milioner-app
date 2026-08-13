from pathlib import Path

p=Path('cloudflare/millioner-api/src/fixed.js')
s=p.read_text()
marker='\nexport default {\n'
if marker not in s: raise SystemExit('export marker not found')

if '// WB_REALIZED_STATUS_TRACKER_V1' not in s:
    code=r'''

// WB_REALIZED_STATUS_TRACKER_V1
// Tracks the first moment our normal Marketplace sync observes wbStatus=sold.
// This avoids the seller-wide Statistics limiter while still counting only actual realizations.
async function ensureWbRealizedTracker(db){
  await db.prepare(`CREATE TABLE IF NOT EXISTS wb_realized_status_tracker(
    market TEXT NOT NULL,order_id TEXT NOT NULL,rid TEXT NOT NULL DEFAULT '',sku TEXT NOT NULL DEFAULT '',nm_id TEXT NOT NULL DEFAULT '',
    unit_price REAL NOT NULL DEFAULT 0,current_status TEXT NOT NULL DEFAULT '',sold_at INTEGER NOT NULL DEFAULT 0,returned_at INTEGER NOT NULL DEFAULT 0,
    baseline INTEGER NOT NULL DEFAULT 1,updated_at INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(market,order_id))`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS wb_realized_tracker_state(
    market TEXT PRIMARY KEY,initialized_at INTEGER NOT NULL DEFAULT 0,last_sync_at INTEGER NOT NULL DEFAULT 0,last_error TEXT NOT NULL DEFAULT '',recovery_tag TEXT NOT NULL DEFAULT '')`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_wb_realized_market_sold ON wb_realized_status_tracker(market,sold_at)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_wb_realized_market_returned ON wb_realized_status_tracker(market,returned_at)`).run();
}
function wbTrackerStatus(v){return String(v||'').trim().toLowerCase()}
function wbTrackerSold(v){return wbTrackerStatus(v)==='sold'}
function wbTrackerReturned(v){const x=wbTrackerStatus(v);return ['canceled','cancelled','declined_by_client','canceled_by_client','return','returned'].includes(x)}
function wbTrackerRowData(row){
  let raw={};try{raw=JSON.parse(String(row?.rawJson||'{}'))}catch{}
  const order=raw?.order||{};
  return {
    orderId:String(row?.orderId||''),rid:String(order?.rid||'').trim(),sku:String(row?.sku||order?.article||'').trim(),
    nmId:String(order?.nmId??''),unitPrice:Number(row?.unitPrice||0)||0,status:wbTrackerStatus(row?.state||row?.status||''),
    creationDate:Number(row?.creationDate||0)||0
  };
}
function almatyTodayStart(now=Date.now()){
  const d=new Date(now+ALMATY_OFFSET_MS);return Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate())-ALMATY_OFFSET_MS;
}
const WB1_REALIZED_RECOVERY_20260813=['5439850585','5433583008','5427481460'];
async function syncWbRealizedTracker(env,market='WB'){
  if(!['WB','WB2'].includes(market))throw new Error('Unsupported WB realized tracker market');
  await ensureWbRealizedTracker(env.DB);
  const now=Date.now(),cutoff=now-60*86400000;
  const src=await env.DB.prepare(`SELECT order_id AS orderId,status,state,creation_date AS creationDate,sku,unit_price AS unitPrice,raw_json AS rawJson
    FROM marketplace_order_lines WHERE market=? AND creation_date>=?`).bind(market,cutoff).all();
  const current=(src.results||[]).map(wbTrackerRowData).filter(x=>x.orderId);
  const previousRows=await env.DB.prepare('SELECT * FROM wb_realized_status_tracker WHERE market=?').bind(market).all();
  const previous=new Map((previousRows.results||[]).map(x=>[String(x.order_id),x]));
  const state=await env.DB.prepare('SELECT * FROM wb_realized_tracker_state WHERE market=?').bind(market).first();
  const firstRun=!Number(state?.initialized_at||0);
  const initializedAt=firstRun?now:Number(state.initialized_at);
  const statements=[];let transitions=0;
  for(const x of current){
    const prev=previous.get(x.orderId)||null,prevStatus=wbTrackerStatus(prev?.current_status||'');
    let soldAt=Number(prev?.sold_at||0),returnedAt=Number(prev?.returned_at||0),baseline=prev?Number(prev.baseline||0):1;
    if(!firstRun){
      if(prev){
        if(!wbTrackerSold(prevStatus)&&wbTrackerSold(x.status)){soldAt=now;returnedAt=0;baseline=0;transitions++}
        else if(wbTrackerSold(prevStatus)&&wbTrackerReturned(x.status)){returnedAt=now;baseline=0;transitions++}
      }else if(x.creationDate>=initializedAt&&wbTrackerSold(x.status)){
        soldAt=now;returnedAt=0;baseline=0;transitions++;
      }
    }
    statements.push(env.DB.prepare(`INSERT INTO wb_realized_status_tracker(market,order_id,rid,sku,nm_id,unit_price,current_status,sold_at,returned_at,baseline,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(market,order_id) DO UPDATE SET rid=excluded.rid,sku=excluded.sku,nm_id=excluded.nm_id,
      unit_price=excluded.unit_price,current_status=excluded.current_status,sold_at=excluded.sold_at,returned_at=excluded.returned_at,baseline=excluded.baseline,updated_at=excluded.updated_at`)
      .bind(market,x.orderId,x.rid,x.sku,x.nmId,x.unitPrice,x.status,soldAt,returnedAt,baseline,now));
  }
  for(let i=0;i<statements.length;i+=80)await env.DB.batch(statements.slice(i,i+80));
  let recoveryTag=String(state?.recovery_tag||'');
  if(firstRun&&market==='WB'){
    // Before this tracker was installed, supplier/sales successfully confirmed exactly three
    // realizations for 2026-08-13. Their exact Marketplace order IDs were resolved by nmId/rid.
    const seedAt=Math.max(almatyTodayStart(now)+1000,now-1000);
    const q=WB1_REALIZED_RECOVERY_20260813.map(id=>env.DB.prepare(`UPDATE wb_realized_status_tracker SET sold_at=?,returned_at=0,baseline=0,updated_at=? WHERE market='WB' AND order_id=? AND current_status='sold'`).bind(seedAt,now,id));
    if(q.length)await env.DB.batch(q);
    recoveryTag='wb1-2026-08-13-seed-3';
  }
  await env.DB.prepare(`INSERT INTO wb_realized_tracker_state(market,initialized_at,last_sync_at,last_error,recovery_tag) VALUES(?,?,?,?,?)
    ON CONFLICT(market) DO UPDATE SET last_sync_at=excluded.last_sync_at,last_error='',recovery_tag=CASE WHEN wb_realized_tracker_state.recovery_tag<>'' THEN wb_realized_tracker_state.recovery_tag ELSE excluded.recovery_tag END`)
    .bind(market,initializedAt,now,'',recoveryTag).run();
  return {ok:true,market,firstRun,rows:current.length,transitions,initializedAt,recoveryTag};
}
async function wbTrackerPayoutRatios(env,market){
  const since=Date.now()-45*86400000;
  const rows=await env.DB.prepare(`SELECT vendor_code AS vendorCode,nm_id AS nmId,
      SUM(retail_amount) AS gross,SUM(for_pay-acquiring_fee-delivery_service-paid_storage-paid_acceptance-deduction-penalty-rebill_logistic_cost+additional_payment) AS net
    FROM wb_finance_rows WHERE market=? AND sale_date>=? GROUP BY vendor_code,nm_id`).bind(market,since).all();
  const byKey=new Map();let gross=0,net=0;
  for(const x of rows.results||[]){const g=Number(x.gross||0),n=Number(x.net||0);if(!(g>0))continue;const ratio=Math.max(0,Math.min(1.2,n/g));for(const k of [x.vendorCode,String(x.nmId||'')].map(v=>String(v||'').trim()).filter(Boolean))byKey.set(k,ratio);gross+=g;net+=n}
  return {byKey,fallback:gross>0?Math.max(0,Math.min(1.2,net/gross)):null};
}
async function wbRealizedStatusEndpoint(request,env,url){
  const market=normalizeMarket(url.searchParams.get('market'));
  if(!['WB','WB2'].includes(market))return json({ok:false,error:'market must be WB or WB2'},400,request,env);
  const raw=Number(url.searchParams.get('days')||1),days=raw===-1?-1:Math.max(1,Math.min(365,raw||1));
  try{
    // No WB network call here: this only processes the latest Marketplace statuses already in D1.
    await syncWbRealizedTracker(env,market);
    const {since,until}=wbSalesPeriodBounds(days),state=await env.DB.prepare('SELECT * FROM wb_realized_tracker_state WHERE market=?').bind(market).first();
    const rows=await env.DB.prepare(`SELECT * FROM wb_realized_status_tracker WHERE market=? AND ((sold_at>=? AND sold_at<?) OR (returned_at>=? AND returned_at<?))`)
      .bind(market,since,until,since,until).all();
    let ratioData={byKey:new Map(),fallback:null};try{ratioData=await wbTrackerPayoutRatios(env,market)}catch{}
    const map=new Map();let sales=0,returns=0,buyoutSum=0,forPay=0,ratioComplete=true;
    for(const x of rows.results||[]){
      const key=String(x.sku||x.nm_id||x.order_id),product=map.get(key)||{vendorCode:String(x.sku||''),nmId:String(x.nm_id||''),title:String(x.sku||x.nm_id||''),qty:0,buyoutSum:0,forPay:0,pricedRows:0,sourceRows:0,priceLinked:true};
      const ratio=ratioData.byKey.get(String(x.sku||'').trim())??ratioData.byKey.get(String(x.nm_id||'').trim())??ratioData.fallback;
      if(Number(x.sold_at)>=since&&Number(x.sold_at)<until){const price=Number(x.unit_price||0);sales++;product.qty+=1;product.sourceRows++;product.pricedRows+=price>0?1:0;product.buyoutSum+=price;buyoutSum+=price;if(ratio==null)ratioComplete=false;else{product.forPay+=price*ratio;forPay+=price*ratio}}
      if(Number(x.returned_at)>=since&&Number(x.returned_at)<until){const price=Number(x.unit_price||0);returns++;product.qty-=1;product.sourceRows++;product.pricedRows+=price>0?1:0;product.buyoutSum-=price;buyoutSum-=price;if(ratio==null)ratioComplete=false;else{product.forPay-=price*ratio;forPay-=price*ratio}}
      map.set(key,product);
    }
    const products=[...map.values()].filter(x=>x.qty!==0).map(x=>({...x,priceLinked:x.sourceRows>0&&x.pricedRows===x.sourceRows}));
    const initializedAt=Number(state?.initialized_at||0),recoveryTag=String(state?.recovery_tag||'');
    const recoveredToday=market==='WB'&&recoveryTag==='wb1-2026-08-13-seed-3'&&dayIsoAlmaty(since)==='2026-08-13';
    const coverageComplete=initializedAt>0&&(initializedAt<=since||recoveredToday);
    return json({ok:true,available:coverageComplete,market,days,range:{since,until,timezone:'Asia/Almaty'},sales,returns,netQty:sales-returns,buyoutCount:sales-returns,buyoutSum,forPay,
      products,currency:'KZT',priceComplete:products.every(x=>x.priceLinked)&&ratioComplete,payoutEstimated:true,statusTracked:true,coverageComplete,
      initializedAt,lastSyncAt:Number(state?.last_sync_at||0),recoveryTag,source:'WB Marketplace sold transitions'},200,request,env);
  }catch(e){return json({ok:false,available:false,market,days,error:String(e?.message||e)},500,request,env)}
}
'''
    s=s.replace(marker,code+marker,1)

route="    if (request.method === 'GET' && url.pathname === '/api/wb-realized-status') return wbRealizedStatusEndpoint(request,env,url);\n"
route_anchor="    if (request.method === 'GET' && url.pathname === '/api/wb-sold-history-debug') return wbSoldHistoryDebug(request,env,url);\n"
if route not in s:
    if route_anchor not in s: raise SystemExit('route anchor not found')
    s=s.replace(route_anchor,route+route_anchor,1)

# Stop hammering supplier/sales in cron. Track status transitions every normal cron instead.
scheduled_old="""    const minute = new Date(Number(controller?.scheduledTime || Date.now())).getUTCMinutes();
    // supplier/sales is our operational source of realized WB sales. It is updated
    // every ~30 minutes and WB allows only one request per seller per minute.
    // Run it only at :05 and :35, store everything in D1, and never call it from UI.
    if ((minute === 5 || minute === 35) && ctx?.waitUntil) {
      ctx.waitUntil((async () => {
        for (const market of ['WB','WB2']) {
          try { await syncWbSalesCache(env, market, { force: false }); }
          catch (e) { console.warn('WB realized sales sync', market, String(e?.message || e)); }
        }
      })());
    }"""
scheduled_new="""    // Process the Marketplace statuses already synchronized by the main worker.
    // No Statistics API call here, so the seller-wide global limiter cannot break reports.
    if (ctx?.waitUntil) {
      ctx.waitUntil((async () => {
        for (const market of ['WB','WB2']) {
          try { await syncWbRealizedTracker(env, market); }
          catch (e) { console.warn('WB realized status tracker', market, String(e?.message || e)); }
        }
      })());
    }"""
if scheduled_old not in s: raise SystemExit('scheduled supplier/sales block not found')
s=s.replace(scheduled_old,scheduled_new,1)
p.write_text(s)

# Frontend: for Today, status tracker is the first source; old statistics is backup only.
p=Path('index.html')
h=p.read_text()
a=h.index('async function ensureWbLiveOverview')
b=h.index('\nfunction renderReports',a)
old=h[a:b]
new=r'''async function ensureWbLiveOverview(market,days){
  const key=market+':'+days,old=wbLiveOverviewCache[key];
  if(old&&Date.now()-Number(old.at||0)<60000)return old.data;
  if(Number(days)===1){
    try{
      const tracked=await apiJson(MILLIONER_API+'/api/wb-realized-status?market='+encodeURIComponent(market)+'&days=1');
      if(tracked?.ok&&tracked?.available){
        const data={...tracked,analyticsOnly:true,source:'WB Marketplace sold transitions'};
        wbLiveOverviewCache[key]={at:Date.now(),data};return data;
      }
    }catch(_){}
  }
  try{
    const data=await apiJson(MILLIONER_API+'/api/wb-sales-live?market='+encodeURIComponent(market)+'&days='+encodeURIComponent(days));
    if(!data?.ok||data?.stale&&data?.lastError)throw new Error(data?.error||data?.lastError||'WB sales unavailable');
    wbLiveOverviewCache[key]={at:Date.now(),data};return data;
  }catch(primary){
    try{
      const fallback=await apiJson(MILLIONER_API+'/api/wb-sales-direct?market='+encodeURIComponent(market)+'&days='+encodeURIComponent(days));
      if(!fallback?.ok)throw new Error(fallback?.error||'WB sales unavailable');
      const data={...fallback,available:true,analyticsOnly:true,source:'WB Statistics supplier/sales · direct fallback'};
      wbLiveOverviewCache[key]={at:Date.now(),data};return data;
    }catch(e){
      wbLiveOverviewCache[key]={at:Date.now(),data:old?.data||null,error:String(e.message||primary.message||e)};
      return old?.data||null;
    }
  }
}'''
h=h[:a]+new+h[b:]
p.write_text(h)
