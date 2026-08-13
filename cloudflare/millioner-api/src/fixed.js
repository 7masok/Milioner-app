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
const WB_BUYOUT_REFRESH_MS=60*60*1000;
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
function wbBuyoutMarketBlockedUntil(rows=[]){
  let until=0;
  for(const row of rows||[]){
    if(!String(row?.last_error||'').trim())continue;
    until=Math.max(until,Number(row?.last_attempt_at||0)+wbBuyoutRetryMs(row));
  }
  return until;
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
  try {
    const refresh=url.searchParams.get('refresh')==='1';
    const data=refresh?await refreshWbBuyoutCache(env,market,days,{force:false}):await readWbBuyoutCache(env,market,days);
    return json(data,200,request,env);
  } catch(e) {
    return wbAnalyticsBuyouts(request,env,url);
  }
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
  let linkMap=new Map();
  try {
    const links=await env.DB.prepare('SELECT sku,product_id AS productId FROM product_links WHERE market=?').bind(market).all();
    linkMap=new Map((links.results||[]).map(x=>[String(x.sku||'').trim(),String(x.productId||'')]));
  } catch (_) {
    // D1 fallback: browser can match vendorCode/nmId against local warehouse state.
  }
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
const WB_SALES_REFRESH_MS = 29 * 60 * 1000;
const WB_SALES_RETRY_MS = 31 * 60 * 1000;
function wbSalesRetryMs(state) {
  const m = String(state?.last_error || '').match(/retry\s+(\d+)/i);
  return m ? Math.max(60, Number(m[1]) || 60) * 1000 : WB_SALES_RETRY_MS;
}

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
  const minGap = state?.last_error ? wbSalesRetryMs(state) : WB_SALES_REFRESH_MS;
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
      const baseErr = String(data?.detail || data?.message || ('WB statistics HTTP ' + r.status));
      const retryRaw = r.headers.get('X-RateLimit-Retry') || r.headers.get('Retry-After') || '';
      const retrySec = Math.max(0, Number(String(retryRaw).match(/\d+/)?.[0] || 0));
      const err = baseErr + (retrySec ? ' · retry ' + retrySec : '');
      await env.DB.prepare('UPDATE wb_sales_live_state SET last_error=?,updated_at=? WHERE market=?').bind(err, Date.now(), market).run();
      return { ok: false, status: r.status, error: err, retryAfter: retrySec || null };
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
  const rows = await env.DB.prepare(`
    WITH priced AS (
      SELECT r.*,
        COALESCE(
          (SELECT l.product_id FROM product_links l WHERE l.market=r.market AND trim(l.sku)=trim(r.vendor_code) LIMIT 1),
          (SELECT l.product_id FROM product_links l WHERE l.market=r.market AND trim(l.sku)=trim(r.nm_id) LIMIT 1),
          (SELECT l.product_id FROM product_links l WHERE l.market=r.market AND trim(l.sku)=trim(r.barcode) LIMIT 1),
          ''
        ) AS linked_product_id,
        COALESCE(
          (SELECT o.unit_price FROM marketplace_order_lines o
             WHERE o.market=r.market AND o.unit_price>0
               AND trim(COALESCE(json_extract(o.raw_json,'$.order.rid'),''))=trim(r.srid)
             ORDER BY o.creation_date DESC LIMIT 1),
          (SELECT o.unit_price FROM marketplace_order_lines o
             WHERE o.market=r.market AND o.unit_price>0
               AND (trim(o.sku)=trim(r.vendor_code) OR trim(o.sku)=trim(r.nm_id) OR trim(o.sku)=trim(r.barcode))
             ORDER BY o.creation_date DESC LIMIT 1),
          0
        ) AS seller_unit_price
      FROM wb_sales_live_rows r
      WHERE r.market=? AND r.sale_date>=? AND r.sale_date<?
    )
    SELECT r.vendor_code AS vendorCode,r.nm_id AS nmId,r.barcode AS barcode,
      MAX(r.linked_product_id) AS productId,
      SUM(CASE WHEN r.is_return=1 THEN -1 ELSE 1 END) AS qty,
      SUM(CASE WHEN r.is_return=1 THEN -ABS(r.finished_price) ELSE ABS(r.finished_price) END) AS finishedPriceRub,
      SUM(CASE WHEN r.is_return=1 THEN -ABS(r.price_with_disc) ELSE ABS(r.price_with_disc) END) AS priceWithDiscRub,
      SUM(CASE WHEN r.is_return=1 THEN -ABS(r.for_pay) ELSE ABS(r.for_pay) END) AS forPayRub,
      SUM((CASE WHEN r.is_return=1 THEN -1 ELSE 1 END) * ABS(r.seller_unit_price)) AS sellerGross,
      SUM((CASE WHEN r.is_return=1 THEN -1 ELSE 1 END) * ABS(r.seller_unit_price) *
          CASE WHEN ABS(r.finished_price)>0 THEN ABS(r.for_pay)/ABS(r.finished_price) ELSE 0 END) AS sellerForPay,
      SUM(CASE WHEN r.seller_unit_price>0 THEN 1 ELSE 0 END) AS pricedRows,
      COUNT(*) AS sourceRows
    FROM priced r
    GROUP BY r.vendor_code,r.nm_id,r.barcode
    ORDER BY SUM((CASE WHEN r.is_return=1 THEN -1 ELSE 1 END) * ABS(r.seller_unit_price)) DESC`)
    .bind(market, since, until).all();
  const totals = await env.DB.prepare(`SELECT COUNT(*) totalRows,
      SUM(CASE WHEN is_return=0 THEN 1 ELSE 0 END) sales,
      SUM(CASE WHEN is_return=1 THEN 1 ELSE 0 END) returns
    FROM wb_sales_live_rows WHERE market=? AND sale_date>=? AND sale_date<?`).bind(market,since,until).first();
  const state = await env.DB.prepare('SELECT * FROM wb_sales_live_state WHERE market=?').bind(market).first();
  const sales = Number(totals?.sales || 0), returns = Number(totals?.returns || 0), netQty = sales - returns;
  const lastSuccessAt = Number(state?.last_success_at || 0) || null;
  const products = (rows.results || []).map(x => {
    const qty=Number(x.qty||0), finishedPriceRub=Number(x.finishedPriceRub||0), priceWithDiscRub=Number(x.priceWithDiscRub||0), forPayRub=Number(x.forPayRub||0);
    const sellerGross=Number(x.sellerGross||0), sellerForPay=Number(x.sellerForPay||0), pricedRows=Number(x.pricedRows||0), sourceRows=Number(x.sourceRows||0);
    return {...x,qty,finishedPriceRub,priceWithDiscRub,forPayRub,sellerGross,sellerForPay,pricedRows,sourceRows,
      finishedPrice:sellerGross,priceWithDisc:sellerGross,forPay:sellerForPay,buyoutSum:sellerGross,
      priceLinked:sourceRows>0&&pricedRows===sourceRows};
  }).filter(x=>x.qty!==0);
  const sellerGross=products.reduce((a,x)=>a+Number(x.sellerGross||0),0);
  const sellerForPay=products.reduce((a,x)=>a+Number(x.sellerForPay||0),0);
  const pricedRows=products.reduce((a,x)=>a+Number(x.pricedRows||0),0);
  return {
    ok:true,available:!!lastSuccessAt,market,days,since,until,totalRows:Number(totals?.totalRows||0),sales,returns,netQty,
    buyoutCount:netQty,buyoutSum:sellerGross,forPay:sellerForPay,products,currency:'KZT',pricedRows,
    cached:true,lastSuccessAt,lastError:String(state?.last_error||''),
    nextSyncAt:Number(state?.last_attempt_at||0)+(state?.last_error?wbSalesRetryMs(state):WB_SALES_REFRESH_MS),
    stale:!lastSuccessAt||Date.now()-lastSuccessAt>WB_SALES_REFRESH_MS*2,
    source:'WB Statistics supplier/sales + Marketplace converted price'
  };
}

async function wbSalesLiveCached(request, env, ctx, url) {
  const market = normalizeMarket(url.searchParams.get('market'));
  if (!['WB','WB2'].includes(market)) return json({ok:false,error:'market must be WB or WB2'},400,request,env);
  const raw = Number(url.searchParams.get('days') || 1);
  const days = raw === -1 ? -1 : Math.max(1, Math.min(90, raw || 1));
  try {
    await ensureWbSalesCache(env.DB);
    if (url.searchParams.get('refresh') === '1') await syncWbSalesCache(env, market, { force: false });
    return json(await readWbSalesCache(env, market, days),200,request,env);
  } catch (e) {
    return json({ok:false,market,days,error:String(e?.message||e)},500,request,env);
  }
}


// WB_SALES_DIRECT_V2 — D1-independent operational realized sales with seller KZT prices.
async function wbSalesDirectEndpoint(request,env,url){
  const market=normalizeMarket(url.searchParams.get('market'));
  if(!['WB','WB2'].includes(market))return json({ok:false,error:'market must be WB or WB2'},400,request,env);
  const token=String((market==='WB2'?env.WB_TOKEN_2:env.WB_TOKEN)||'').trim();
  if(!token)return json({ok:false,error:'WB token is not configured'},400,request,env);
  const raw=Number(url.searchParams.get('days')||1),days=raw===-1?-1:Math.max(1,Math.min(90,raw||1));
  const {since,until}=wbSalesPeriodBounds(days);
  // v2 key intentionally invalidates the earlier cache that contained raw WB price fields.
  const cacheKey=new Request('https://wb-direct-cache.local/sales-v2?market='+encodeURIComponent(market)+'&days='+encodeURIComponent(days));
  const force=url.searchParams.get('refresh')==='1';
  try{
    if(!force){
      const cached=await caches.default.match(cacheKey);
      if(cached){const data=await cached.json();return json({...data,cached:true},200,request,env)}
    }
  }catch(_){}

  // 1) Actual realization events: supplier/sales. One row is one sold/returned unit.
  const dateFrom=new Date(since+3*60*60*1000).toISOString().slice(0,10);
  const apiUrl=WB_STATS_BASE+'/api/v1/supplier/sales?dateFrom='+encodeURIComponent(dateFrom)+'&flag=0';
  const r=await fetch(apiUrl,{headers:{Accept:'application/json',Authorization:token}});
  let data=null;try{data=await r.json()}catch{}
  if(!r.ok){
    const retry=r.headers.get('X-RateLimit-Retry')||r.headers.get('Retry-After')||'';
    return json({ok:false,available:false,market,days,status:r.status,retryAfter:retry||null,error:data?.detail||data?.message||data?.error||('WB sales HTTP '+r.status)},r.status,request,env);
  }
  const allSales=Array.isArray(data)?data:[];
  const periodSales=allSales.filter(x=>{const t=wbMoscowMs(x?.date||x?.lastChangeDate);return t>=since&&t<until});

  // 2) Seller-currency price: Marketplace order rid matches Statistics srid.
  // convertedFinalPrice is in minor seller-currency units, so /100 gives KZT here.
  const orderPriceByRid=new Map();
  const orderDateFrom=Math.floor(Math.max(0,since-30*86400000)/1000);
  let next=0,marketplacePages=0,marketplaceError='';
  try{
    for(let page=0;page<20;page++){
      const mr=await fetch('https://marketplace-api.wildberries.ru/api/v3/orders?limit=1000&next='+encodeURIComponent(next)+'&dateFrom='+encodeURIComponent(orderDateFrom),{headers:{Accept:'application/json',Authorization:token}});
      let md=null;try{md=await mr.json()}catch{}
      if(!mr.ok){marketplaceError=String(md?.message||md?.detail||('WB Marketplace orders HTTP '+mr.status));break}
      const batch=Array.isArray(md?.orders)?md.orders:[];
      marketplacePages++;
      for(const o of batch){
        const rid=String(o?.rid||'').trim();
        const minor=Number(o?.convertedFinalPrice??o?.finalPrice??o?.convertedPrice??o?.price??0)||0;
        if(rid&&minor>0)orderPriceByRid.set(rid,minor/100);
      }
      const newNext=Number(md?.next||0);
      if(!batch.length||!newNext||newNext===next)break;
      next=newNext;
    }
  }catch(e){marketplaceError=String(e?.message||e)}

  const map=new Map();
  let sales=0,returns=0,netQty=0,rawFinishedPriceSum=0,rawPriceWithDiscSum=0,rawForPaySum=0;
  let sellerGross=0,sellerForPay=0,pricedRows=0,sourceRows=0;
  for(const x of periodSales){
    const saleId=String(x?.saleID||x?.saleId||'').trim();
    const isReturn=saleId.toUpperCase().startsWith('R'),sign=isReturn?-1:1;
    if(isReturn)returns++;else sales++;
    netQty+=sign;sourceRows++;
    const finished=Math.abs(Number(x?.finishedPrice||0)||0),disc=Math.abs(Number(x?.priceWithDisc||0)||0),pay=Math.abs(Number(x?.forPay||0)||0);
    rawFinishedPriceSum+=sign*finished;rawPriceWithDiscSum+=sign*disc;rawForPaySum+=sign*pay;
    const srid=String(x?.srid||'').trim(),sellerPrice=Math.abs(Number(orderPriceByRid.get(srid)||0));
    const ratio=finished>0?pay/finished:0,sellerPayout=sellerPrice>0&&ratio>=0?sellerPrice*ratio:0;
    if(sellerPrice>0){pricedRows++;sellerGross+=sign*sellerPrice;sellerForPay+=sign*sellerPayout}
    const vendorCode=String(x?.supplierArticle||'').trim(),nmId=String(x?.nmId??''),barcode=String(x?.barcode||'').trim();
    const key=vendorCode||nmId||barcode||srid||'unknown';
    let item=map.get(key);
    if(!item){item={vendorCode,nmId,barcode,title:vendorCode||nmId||barcode,qty:0,buyoutSum:0,forPay:0,pricedRows:0,sourceRows:0};map.set(key,item)}
    item.qty+=sign;item.sourceRows++;
    if(sellerPrice>0){item.pricedRows++;item.buyoutSum+=sign*sellerPrice;item.forPay+=sign*sellerPayout}
  }
  const products=[...map.values()].map(x=>({...x,priceLinked:x.sourceRows>0&&x.pricedRows===x.sourceRows})).filter(x=>Number(x.qty)!==0).sort((a,b)=>Number(b.buyoutSum||0)-Number(a.buyoutSum||0));
  const priceComplete=sourceRows>0&&pricedRows===sourceRows;
  const result={ok:true,available:true,market,days,range:{since,until,timezone:'Asia/Almaty'},sales,returns,netQty,buyoutCount:netQty,
    buyoutSum:sellerGross,forPay:sellerForPay,products,currency:'KZT',pricedRows,sourceRows,priceComplete,
    rawFinishedPriceSum,rawPriceWithDiscSum,rawForPaySum,marketplacePages,marketplaceError,
    source:'WB Statistics supplier/sales + Marketplace converted price · direct',updatedAt:Date.now()};
  try{await caches.default.put(cacheKey,new Response(JSON.stringify(result),{headers:{'Content-Type':'application/json','Cache-Control':'public,max-age=300'}}))}catch(_){}
  return json(result,200,request,env);
}


async function wbSoldHistoryDebug(request,env,url){
  const market=normalizeMarket(url.searchParams.get('market'));
  if(!['WB','WB2'].includes(market))return json({ok:false,error:'market must be WB or WB2'},400,request,env);
  const token=String((market==='WB2'?env.WB_TOKEN_2:env.WB_TOKEN)||'').trim();
  if(!token)return json({ok:false,error:'WB token is not configured'},400,request,env);
  const headers={Accept:'application/json',Authorization:token};
  const dateFrom=Math.floor((Date.now()-30*86400000)/1000);
  const orders=[];let next=0;
  for(let page=0;page<5;page++){
    const r=await fetch('https://marketplace-api.wildberries.ru/api/v3/orders?limit=1000&next='+encodeURIComponent(next)+'&dateFrom='+encodeURIComponent(dateFrom),{headers});
    let d=null;try{d=await r.json()}catch{}
    if(!r.ok)return json({ok:false,step:'orders',status:r.status,error:d},r.status,request,env);
    const batch=Array.isArray(d?.orders)?d.orders:[];orders.push(...batch);
    const nn=Number(d?.next||0);if(!batch.length||!nn||nn===next)break;next=nn;
  }
  const statuses=new Map();
  const ids=orders.map(o=>Number(o?.id)).filter(Number.isFinite);
  for(let i=0;i<ids.length;i+=1000){
    const chunk=ids.slice(i,i+1000);
    const r=await fetch('https://marketplace-api.wildberries.ru/api/v3/orders/status',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({orders:chunk})});
    let d=null;try{d=await r.json()}catch{}
    if(!r.ok)return json({ok:false,step:'status',status:r.status,error:d},r.status,request,env);
    for(const x of (d?.orders||[]))statuses.set(Number(x.id),x);
  }
  const sold=orders.filter(o=>String(statuses.get(Number(o.id))?.wbStatus||'').toLowerCase()==='sold');
  const wanted=new Set(String(url.searchParams.get('nmIds')||'').split(',').map(x=>Number(x.trim())).filter(Number.isFinite));
  const candidates=(wanted.size?sold.filter(o=>wanted.has(Number(o?.nmId))):sold).slice().sort((a,b)=>Date.parse(String(b?.createdAt||''))-Date.parse(String(a?.createdAt||''))).slice(0,100);
  const sample=sold.slice(0,100),historyIds=sample.map(o=>Number(o.id));
  let historyStatus=0,historyData=null;
  if(historyIds.length){
    const hr=await fetch('https://marketplace-api.wildberries.ru/api/v3/orders/status/history',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({orders:historyIds})});
    historyStatus=hr.status;try{historyData=await hr.json()}catch{historyData=null}
  }
  const byId=new Map((Array.isArray(historyData?.orders)?historyData.orders:[]).map(x=>[Number(x.orderID??x.orderId),x]));
  const shape=o=>({id:o.id,rid:o.rid,article:o.article,nmId:o.nmId,createdAt:o.createdAt,price:(Number(o.convertedFinalPrice??o.finalPrice??o.convertedPrice??o.price??0)||0)/100,status:statuses.get(Number(o.id)),history:byId.get(Number(o.id))||null});
  return json({ok:true,market,orders:orders.length,sold:sold.length,historyStatus,historyCount:Array.isArray(historyData?.orders)?historyData.orders.length:0,
    candidates:candidates.map(shape),sample:sample.slice(0,20).map(shape),historyRaw:historyStatus===200?undefined:historyData},200,request,env);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/api/wb-sold-history-debug') return wbSoldHistoryDebug(request,env,url);
    if (request.method === 'GET' && url.pathname === '/api/wb-sales-direct') return wbSalesDirectEndpoint(request,env,url);
    if (request.method === 'GET' && url.pathname === '/api/wb-buyouts-live') return wbBuyoutsCachedEndpoint(request,env,url);
    if (request.method === 'GET' && url.pathname === '/api/wb-sales-live') return wbSalesLiveCached(request, env, ctx, url);
    if (request.method === 'GET' && url.searchParams.get('days') === '-1') {
      if (url.pathname === '/api/wb-finance-summary') return wbYesterdaySummary(request, env, url);
      if (url.pathname === '/api/wb-finance-products') return wbYesterdayProducts(request, env, url);
    }
    return base.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    const minute = new Date(Number(controller?.scheduledTime || Date.now())).getUTCMinutes();
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
    }
    if (typeof base.scheduled === 'function') return base.scheduled(controller, env, ctx);
  }
};
