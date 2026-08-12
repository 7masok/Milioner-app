from pathlib import Path

fixed = Path('cloudflare/millioner-api/src/fixed.js')
s = fixed.read_text(encoding='utf-8')

if 'WB_SALES_CACHE_V1' not in s:
    marker = 'export default {'
    if marker not in s:
        raise SystemExit('fixed export marker missing')
    block = r'''
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
  const shouldRefresh = !state?.last_success_at || Date.now()-Number(state.last_success_at)>WB_SALES_REFRESH_MS;
  if (Number(count?.n||0) === 0 && shouldRefresh) await syncWbSalesCache(env, market, {force:false});
  else if (shouldRefresh && ctx?.waitUntil) ctx.waitUntil(syncWbSalesCache(env, market, {force:false}));
  return json(await readWbSalesCache(env, market, days),200,request,env);
}

'''
    s = s.replace(marker, block + marker, 1)

old_export = """export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.searchParams.get('days') === '-1') {
      if (url.pathname === '/api/wb-finance-summary') return wbYesterdaySummary(request, env, url);
      if (url.pathname === '/api/wb-finance-products') return wbYesterdayProducts(request, env, url);
    }
    return base.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    if (typeof base.scheduled === 'function') return base.scheduled(controller, env, ctx);
  }
};"""
new_export = """export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/api/wb-sales-live') return wbSalesLiveCached(request, env, ctx, url);
    if (request.method === 'GET' && url.searchParams.get('days') === '-1') {
      if (url.pathname === '/api/wb-finance-summary') return wbYesterdaySummary(request, env, url);
      if (url.pathname === '/api/wb-finance-products') return wbYesterdayProducts(request, env, url);
    }
    return base.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    if (typeof base.scheduled === 'function') base.scheduled(controller, env, ctx);
    if (ctx?.waitUntil) ctx.waitUntil((async()=>{
      for (const market of ['WB','WB2']) await syncWbSalesCache(env, market, {force:false});
    })());
  }
};"""
if old_export not in s:
    raise SystemExit('fixed export block changed unexpectedly')
s = s.replace(old_export, new_export, 1)
fixed.write_text(s, encoding='utf-8')

h = Path('index.html')
t = h.read_text(encoding='utf-8')
start = t.find('function renderReports(){')
end = t.find('function marketplaceProductStats', start)
if start < 0 or end < 0:
    raise SystemExit('renderReports marker missing')
new_reports = r'''const wbLiveOverviewCache={};
async function ensureWbLiveOverview(market,days){
  const key=market+':'+days,old=wbLiveOverviewCache[key];
  if(old&&Date.now()-Number(old.at||0)<60000)return old.data;
  try{const data=await apiJson(MILLIONER_API+'/api/wb-sales-live?market='+encodeURIComponent(market)+'&days='+encodeURIComponent(days));wbLiveOverviewCache[key]={at:Date.now(),data};return data}catch(e){wbLiveOverviewCache[key]={at:Date.now(),data:old?.data||null,error:String(e.message||e)};return old?.data||null}
}
function renderReports(refreshWb=true){
  document.querySelectorAll('[data-report-period]').forEach(b=>b.classList.toggle('active',Number(b.dataset.reportPeriod)===reportPeriodPreset));
  const since=reportPeriodStart(reportPeriod),until=reportPeriodEnd(reportPeriod);
  let ss=financialSales().filter(s=>Number(s.date)>=since&&Number(s.date)<until),rev=ss.reduce((a,s)=>a+(Number(s.qty)||0)*(Number(s.price)||0),0),cost=ss.reduce((a,s)=>a+(Number(s.qty)||0)*(Number(s.cost)||0),0),fees=ss.reduce((a,s)=>a+(Number(s.qty)||0)*(Number(s.fee)||0),0),ads=kaspiAdsBreakdown(reportPeriod).total;
  document.getElementById('rRevenue').textContent=fmt(rev);document.getElementById('rCost').textContent=fmt(cost);document.getElementById('rFees').textContent=fmt(fees);document.getElementById('rAds').textContent=fmt(ads);document.getElementById('rProfit').textContent=fmt(rev-cost-fees-ads);renderKaspiAdsStatus(reportPeriod);
  let names=['Kaspi','WB','WB2','Ozon','Ручная'];
  document.getElementById('mpReport').innerHTML=names.map(n=>{
    let a=ss.filter(s=>s.channel===n),qty=a.reduce((x,s)=>x+(Number(s.qty)||0),0),channelRev=a.reduce((x,s)=>x+(Number(s.qty)||0)*(Number(s.price)||0),0),channelProfit=a.reduce((x,s)=>x+(Number(s.qty)||0)*((Number(s.price)||0)-(Number(s.cost)||0)-(Number(s.fee)||0)),0)-(n==='Kaspi'?ads:0),finance=null,financeLabel='';
    if(n==='WB'||n==='WB2'){
      const live=wbLiveOverviewCache[n+':'+reportPeriod]?.data||null;
      if(live){qty=Number(live.netQty||0);const lr=(live.products||[]).reduce((x,p)=>x+(Number(p.finishedPrice)||0),0);if(lr)channelRev=lr;}
      finance=wbFinanceCached(n,reportPeriod);
      if(finance){channelRev=Number(finance.retailAmount)||channelRev;channelProfit=(Number(finance.netBeforeCost)||0)-wbLocalCost(n,reportPeriod);financeLabel=' · факт WB'}
      else{ensureWbFinanceSummary(n,reportPeriod);financeLabel=live?' · выкупы WB':' · выкупы загружаются'}
    }
    return `<div class="item row" role="button" tabindex="0" style="cursor:pointer" onclick="openMarketplaceReport('${n}',${reportPeriod})"><div class="grow"><b>${n}</b><div class="muted">${qty} шт. · прибыль ${fmt(channelProfit)}${financeLabel}</div></div><b>${fmt(channelRev)}</b></div>`
  }).join('');
  if(refreshWb){const p=reportPeriod;Promise.all(['WB','WB2'].map(m=>ensureWbLiveOverview(m,p))).then(()=>{if(reportPeriod===p&&document.querySelector('#reports.view.active'))renderReports(false)})}
}
'''
t = t[:start] + new_reports + t[end:]
h.write_text(t, encoding='utf-8')
print('patched WB cached sales + reports overview')
