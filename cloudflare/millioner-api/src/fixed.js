import base from './index.js';

const ALMATY_OFFSET_MS = 5 * 60 * 60 * 1000;

function json(body, status = 200, request = null, env = null) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0'
  };
  const origin = request?.headers?.get('Origin') || '';
  const allowed = String(env?.CORS_ORIGIN || 'https://7masok.github.io').trim();
  if (origin && origin === allowed) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Vary'] = 'Origin';
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function normalizeMarket(value) {
  const market = String(value || '').trim().toUpperCase();
  return market === 'WB1' ? 'WB' : market;
}

function almatyYesterdayRange(now = Date.now()) {
  const local = new Date(now + ALMATY_OFFSET_MS);
  const todayStartUtc = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate()
  ) - ALMATY_OFFSET_MS;
  return {
    since: todayStartUtc - 86400000,
    until: todayStartUtc
  };
}

function dayIsoAlmaty(ts) {
  return new Date(ts + ALMATY_OFFSET_MS).toISOString().slice(0, 10);
}

async function wbYesterdaySummary(request, env, url) {
  const market = normalizeMarket(url.searchParams.get('market'));
  if (!['WB', 'WB2'].includes(market)) {
    return json({ ok: false, error: 'market must be WB or WB2' }, 400, request, env);
  }

  const { since, until } = almatyYesterdayRange();
  const f = await env.DB.prepare(`
    SELECT SUM(retail_amount) retailAmount,SUM(for_pay) forPay,SUM(acquiring_fee) acquiring,
           SUM(delivery_service) delivery,SUM(paid_storage) storage,SUM(paid_acceptance) acceptance,
           SUM(deduction) deduction,SUM(penalty) penalty,SUM(additional_payment) additionalPayment,
           SUM(rebill_logistic_cost) rebill
    FROM wb_finance_rows
    WHERE market=? AND rr_date>=? AND rr_date<?`
  ).bind(market, since, until).first();

  const day = dayIsoAlmaty(since);
  const a = await env.DB.prepare(`
    SELECT SUM(amount) allAds,
           SUM(CASE WHEN lower(payment_type) LIKE '%счет%' OR lower(payment_type) LIKE '%account%' THEN amount ELSE 0 END) accountAds
    FROM wb_ad_costs
    WHERE market=? AND day=?`
  ).bind(market, day).first();

  const n = x => Number(x || 0);
  const wbCharges = n(f?.acquiring) + n(f?.delivery) + n(f?.storage) + n(f?.acceptance) + n(f?.deduction) + n(f?.penalty) + n(f?.rebill);
  const accountAdvertising = n(a?.accountAds);
  const netBeforeCost = n(f?.forPay) - wbCharges + n(f?.additionalPayment) - accountAdvertising;

  return json({
    ok: true,
    market,
    days: -1,
    range: { since, until, timezone: 'Asia/Almaty' },
    retailAmount: n(f?.retailAmount),
    forPay: n(f?.forPay),
    acquiring: n(f?.acquiring),
    delivery: n(f?.delivery),
    storage: n(f?.storage),
    acceptance: n(f?.acceptance),
    deduction: n(f?.deduction),
    penalty: n(f?.penalty),
    additionalPayment: n(f?.additionalPayment),
    rebill: n(f?.rebill),
    advertising: n(a?.allAds),
    accountAdvertising,
    wbCharges,
    netBeforeCost
  }, 200, request, env);
}

async function wbYesterdayProducts(request, env, url) {
  const market = normalizeMarket(url.searchParams.get('market'));
  if (!['WB', 'WB2'].includes(market)) {
    return json({ ok: false, error: 'market must be WB or WB2' }, 400, request, env);
  }

  const { since, until } = almatyYesterdayRange();
  const rows = await env.DB.prepare(`
    SELECT f.vendor_code AS vendorCode,f.nm_id AS nmId,MAX(f.title) AS title,l.product_id AS productId,
           SUM(CASE WHEN trim(f.doc_type)='Продажа' THEN f.qty WHEN trim(f.doc_type)='Возврат' THEN -f.qty ELSE 0 END) AS qty,
           SUM(f.retail_amount) AS retailAmount,SUM(f.for_pay) AS forPay,
           SUM(f.acquiring_fee) AS acquiring,SUM(f.delivery_service) AS delivery,
           SUM(f.paid_storage) AS storage,SUM(f.paid_acceptance) AS acceptance,
           SUM(f.deduction) AS deduction,SUM(f.penalty) AS penalty,
           SUM(f.additional_payment) AS additionalPayment,SUM(f.rebill_logistic_cost) AS rebill
    FROM wb_finance_rows f
    LEFT JOIN product_links l ON l.market=f.market AND (l.sku=f.vendor_code OR l.sku=f.nm_id)
    WHERE f.market=? AND f.rr_date>=? AND f.rr_date<?
    GROUP BY f.vendor_code,f.nm_id,l.product_id
    ORDER BY SUM(f.for_pay) DESC`
  ).bind(market, since, until).all();

  const n = x => Number(x || 0);
  const products = (rows.results || []).map(x => {
    const wbCharges = n(x.acquiring) + n(x.delivery) + n(x.storage) + n(x.acceptance) + n(x.deduction) + n(x.penalty) + n(x.rebill);
    return {
      ...x,
      qty: n(x.qty),
      retailAmount: n(x.retailAmount),
      forPay: n(x.forPay),
      acquiring: n(x.acquiring),
      delivery: n(x.delivery),
      storage: n(x.storage),
      acceptance: n(x.acceptance),
      deduction: n(x.deduction),
      penalty: n(x.penalty),
      additionalPayment: n(x.additionalPayment),
      rebill: n(x.rebill),
      wbCharges,
      netBeforeCost: n(x.forPay) - wbCharges + n(x.additionalPayment)
    };
  });

  const day = dayIsoAlmaty(since);
  const ad = await env.DB.prepare(`
    SELECT SUM(amount) allAds,
           SUM(CASE WHEN lower(payment_type) LIKE '%счет%' OR lower(payment_type) LIKE '%account%' THEN amount ELSE 0 END) accountAds
    FROM wb_ad_costs
    WHERE market=? AND day=?`
  ).bind(market, day).first();

  return json({
    ok: true,
    market,
    days: -1,
    range: { since, until, timezone: 'Asia/Almaty' },
    products,
    advertising: n(ad?.allAds),
    accountAdvertising: n(ad?.accountAds)
  }, 200, request, env);
}




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
function wbBuyoutRetryMs(row){
  const err=String(row?.last_error||''),m=err.match(/retry\s+(\d+)/i);
  if(m)return Math.max(60,Number(m[1])||60)*1000;
  return WB_BUYOUT_REFRESH_MS;
}
function wbBuyoutCacheDue(row,now=Date.now()){
  if(!row?.last_attempt_at)return true;
  return now-Number(row.last_attempt_at)>=wbBuyoutRetryMs(row);
}
async function refreshWbBuyoutCache(env,market,days=1,{force=false}={}){
  await ensureWbBuyoutCache(env.DB);const key=String(days),now=Date.now(),row=await env.DB.prepare('SELECT * FROM wb_buyout_cache WHERE market=? AND period_key=?').bind(market,key).first();
  if(!force&&!wbBuyoutCacheDue(row,now))return readWbBuyoutCache(env,market,days);
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
  const items=Array.isArray(data?.data?.products)?data.data.products:Array.isArray(data?.data?.items)?data.data.items:Array.isArray(data?.products)?data.products:Array.isArray(data?.items)?data.items:Array.isArray(data)?data:[];
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

// WB_SALES_CACHE_V1
const WB_STATS_BASE = 'https://statistics-api.wildberries.ru';
const WB_SALES_REFRESH_MS = 31 * 60 * 1000;
const WB_SALES_RETRY_MS = 70 * 1000;

async function ensureWbSalesCache(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS wb_sales_live_rows (
    market TEXT NOT NULL,sale_id TEXT NOT NULL,srid TEXT NOT NULL DEFAULT '',sale_date INTEGER NOT NULL DEFAULT 0,
    last_change_date INTEGER NOT NULL DEFAULT 0,vendor_code TEXT NOT NULL DEFAULT '',nm_id TEXT NOT NULL DEFAULT '',
    barcode TEXT NOT NULL DEFAULT '',is_return INTEGER NOT NULL DEFAULT 0,finished_price REAL NOT NULL DEFAULT 0,
    price_with_disc REAL NOT NULL DEFAULT 0,for_pay REAL NOT NULL DEFAULT 0,raw_json TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(market,sale_id))`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_wb_sales_live_market_date ON wb_sales_live_rows(market,sale_date DESC)`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS wb_sales_live_state (
    market TEXT PRIMARY KEY,last_attempt_at INTEGER NOT NULL DEFAULT 0,last_success_at INTEGER NOT NULL DEFAULT 0,
    last_change_date INTEGER NOT NULL DEFAULT 0,last_error TEXT NOT NULL DEFAULT '',updated_at INTEGER NOT NULL DEFAULT 0)`).run();
}

function wbMoscowMs(value) {
  const raw = String(value || '').trim();
  if (!raw) return 0;
  const hasZone = /(?:Z|[+-]\d\d:\d\d)$/i.test(raw);
  const t = Date.parse(hasZone ? raw : raw + '+03:00');
  return Number.isFinite(t) ? t : 0;
}

function wbSalesPeriodBounds(days = 1) {
  const local = new Date(Date.now() + ALMATY_OFFSET_MS);
  const today = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - ALMATY_OFFSET_MS;
  if (Number(days) === -1) return { since: today - 86400000, until: today };
  const n = Math.max(1, Math.min(90, Number(days) || 1));
  return { since: today - (n - 1) * 86400000, until: today + 86400000 };
}

async function syncWbSalesCache(env, market, { force = false } = {}) {
  await ensureWbSalesCache(env.DB);
  const token = String((market === 'WB2' ? env.WB_TOKEN_2 : env.WB_TOKEN) || '').trim();
  if (!token) return { ok: false, skipped: true, error: 'WB token is not configured' };
  const now = Date.now();
  const state = await env.DB.prepare('SELECT * FROM wb_sales_live_state WHERE market=?').bind(market).first();
  const lastAttempt = Number(state?.last_attempt_at || 0);
  const lastSuccess = Number(state?.last_success_at || 0);
  const minGap = state?.last_error ? WB_SALES_RETRY_MS : WB_SALES_REFRESH_MS;
  if (!force && lastAttempt && now - lastAttempt < minGap) {
    return { ok: !state?.last_error, skipped: true, lastSuccessAt: lastSuccess, error: state?.last_error || '' };
  }
  await env.DB.prepare(`INSERT INTO wb_sales_live_state(market,last_attempt_at,last_success_at,last_change_date,last_error,updated_at)
    VALUES(?,?,?,?,?,?) ON CONFLICT(market) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,updated_at=excluded.updated_at`)
    .bind(market, now, lastSuccess, Number(state?.last_change_date || 0), String(state?.last_error || ''), now).run();

  const floor = now - 90 * 86400000;
  const lastChange = Number(state?.last_change_date || 0);
  const fromMs = lastChange ? Math.max(floor, lastChange - 5 * 60000) : Math.max(floor, now - 31 * 86400000);
  const endpoint = WB_STATS_BASE + '/api/v1/supplier/sales?dateFrom=' + encodeURIComponent(new Date(fromMs).toISOString()) + '&flag=0';
  try {
    const r = await fetch(endpoint, { headers: { Authorization: token, Accept: 'application/json' } });
    let data = null;
    try { data = await r.json(); } catch {}
    if (!r.ok) {
      const err = String(data?.detail || data?.message || ('WB statistics HTTP ' + r.status));
      await env.DB.prepare('UPDATE wb_sales_live_state SET last_error=?,updated_at=? WHERE market=?').bind(err, Date.now(), market).run();
      return { ok: false, status: r.status, error: err };
    }
    const rows = Array.isArray(data) ? data : [];
    let maxChange = lastChange;
    const batch = [];
    for (const x of rows) {
      const saleId = String(x?.saleID || x?.saleId || '').trim();
      if (!saleId) continue;
      const saleDate = wbMoscowMs(x?.date || x?.lastChangeDate);
      const changed = wbMoscowMs(x?.lastChangeDate || x?.date);
      if (changed > maxChange) maxChange = changed;
      batch.push(env.DB.prepare(`INSERT INTO wb_sales_live_rows(
        market,sale_id,srid,sale_date,last_change_date,vendor_code,nm_id,barcode,is_return,finished_price,price_with_disc,for_pay,raw_json,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(market,sale_id) DO UPDATE SET
        srid=excluded.srid,sale_date=excluded.sale_date,last_change_date=excluded.last_change_date,vendor_code=excluded.vendor_code,
        nm_id=excluded.nm_id,barcode=excluded.barcode,is_return=excluded.is_return,finished_price=excluded.finished_price,
        price_with_disc=excluded.price_with_disc,for_pay=excluded.for_pay,raw_json=excluded.raw_json,updated_at=excluded.updated_at`)
        .bind(market,saleId,String(x?.srid||''),saleDate,changed,String(x?.supplierArticle||''),String(x?.nmId??''),
          String(x?.barcode||''),saleId.toUpperCase().startsWith('R')?1:0,Number(x?.finishedPrice||0)||0,
          Number(x?.priceWithDisc||0)||0,Number(x?.forPay||0)||0,JSON.stringify(x),now));
    }
    for (let i = 0; i < batch.length; i += 100) await env.DB.batch(batch.slice(i, i + 100));
    await env.DB.prepare(`INSERT INTO wb_sales_live_state(market,last_attempt_at,last_success_at,last_change_date,last_error,updated_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(market) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,last_success_at=excluded.last_success_at,
      last_change_date=excluded.last_change_date,last_error='',updated_at=excluded.updated_at`)
      .bind(market, now, Date.now(), maxChange, '', Date.now()).run();
    return { ok: true, items: rows.length, lastSuccessAt: Date.now(), lastChangeDate: maxChange };
  } catch (e) {
    const err = String(e?.message || e);
    await env.DB.prepare('UPDATE wb_sales_live_state SET last_error=?,updated_at=? WHERE market=?').bind(err, Date.now(), market).run();
    return { ok: false, error: err };
  }
}

async function readWbSalesCache(env, market, days) {
  await ensureWbSalesCache(env.DB);
  const { since, until } = wbSalesPeriodBounds(days);
  const rows = await env.DB.prepare(`SELECT r.vendor_code AS vendorCode,r.nm_id AS nmId,r.barcode AS barcode,
      MAX(l.product_id) AS productId,
      SUM(CASE WHEN r.is_return=1 THEN -1 ELSE 1 END) AS qty,
      SUM(CASE WHEN r.is_return=1 THEN -r.finished_price ELSE r.finished_price END) AS finishedPrice,
      SUM(CASE WHEN r.is_return=1 THEN -r.price_with_disc ELSE r.price_with_disc END) AS priceWithDisc,
      SUM(CASE WHEN r.is_return=1 THEN -r.for_pay ELSE r.for_pay END) AS forPay
    FROM wb_sales_live_rows r
    LEFT JOIN product_links l ON l.market=r.market AND (l.sku=r.vendor_code OR l.sku=r.nm_id OR l.sku=r.barcode)
    WHERE r.market=? AND r.sale_date>=? AND r.sale_date<?
    GROUP BY r.vendor_code,r.nm_id,r.barcode
    ORDER BY SUM(CASE WHEN r.is_return=1 THEN -r.for_pay ELSE r.for_pay END) DESC`)
    .bind(market, since, until).all();
  const totals = await env.DB.prepare(`SELECT COUNT(*) totalRows,
      SUM(CASE WHEN is_return=0 THEN 1 ELSE 0 END) sales,
      SUM(CASE WHEN is_return=1 THEN 1 ELSE 0 END) returns
    FROM wb_sales_live_rows WHERE market=? AND sale_date>=? AND sale_date<?`).bind(market,since,until).first();
  const state = await env.DB.prepare('SELECT * FROM wb_sales_live_state WHERE market=?').bind(market).first();
  const sales = Number(totals?.sales || 0), returns = Number(totals?.returns || 0);
  return {
    ok: true, market, days, since, until, totalRows: Number(totals?.totalRows || 0), sales, returns,
    netQty: sales - returns,
    products: (rows.results || []).map(x => ({...x, qty:Number(x.qty||0),finishedPrice:Number(x.finishedPrice||0),priceWithDisc:Number(x.priceWithDisc||0),forPay:Number(x.forPay||0)})).filter(x=>x.qty!==0),
    cached: true,lastSuccessAt:Number(state?.last_success_at||0)||null,lastError:String(state?.last_error||''),
    stale: !state?.last_success_at || Date.now()-Number(state.last_success_at)>WB_SALES_REFRESH_MS*2
  };
}

async function wbSalesLiveCached(request, env, ctx, url) {
  const market = normalizeMarket(url.searchParams.get('market'));
  if (!['WB','WB2'].includes(market)) return json({ok:false,error:'market must be WB or WB2'},400,request,env);
  const raw = Number(url.searchParams.get('days') || 1);
  const days = raw === -1 ? -1 : Math.max(1, Math.min(90, raw || 1));
  await ensureWbSalesCache(env.DB);
  const count = await env.DB.prepare('SELECT COUNT(*) n FROM wb_sales_live_rows WHERE market=?').bind(market).first();
  const state = await env.DB.prepare('SELECT * FROM wb_sales_live_state WHERE market=?').bind(market).first();
  return json(await readWbSalesCache(env, market, days),200,request,env);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/api/wb-buyouts-live') return wbBuyoutsCachedEndpoint(request,env,url);
    if (request.method === 'GET' && url.pathname === '/api/wb-sales-live') return wbSalesLiveCached(request, env, ctx, url);
    if (request.method === 'GET' && url.searchParams.get('days') === '-1') {
      if (url.pathname === '/api/wb-finance-summary') return wbYesterdaySummary(request, env, url);
      if (url.pathname === '/api/wb-finance-products') return wbYesterdayProducts(request, env, url);
    }
    return base.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    const refreshDue=async()=>{
      await ensureWbBuyoutCache(env.DB);
      let any=false;
      for(const market of ['WB','WB2']){
        const rows=await env.DB.prepare(`SELECT period_key,last_attempt_at,last_error,updated_at FROM wb_buyout_cache WHERE market=?`).bind(market).all();
        const map=new Map((rows.results||[]).map(x=>[String(x.period_key),x]));
        for(const days of [1,-1,7,30]){
          const row=map.get(String(days));
          if(wbBuyoutCacheDue(row)){
            any=true;
            await refreshWbBuyoutCache(env,market,days,{force:false});
            break;
          }
        }
      }
      return any;
    };
    if(ctx?.waitUntil)ctx.waitUntil(refreshDue());
    if (typeof base.scheduled === 'function') return base.scheduled(controller, env, ctx);
  }
};
