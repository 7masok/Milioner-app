from pathlib import Path

fixed = Path('cloudflare/millioner-api/src/fixed.js')
s = fixed.read_text(encoding='utf-8')

old = """const WB_SALES_REFRESH_MS = 31 * 60 * 1000;
const WB_SALES_RETRY_MS = 70 * 1000;
"""
new = """const WB_SALES_REFRESH_MS = 31 * 60 * 1000;
const WB_SALES_RETRY_MS = 31 * 60 * 1000;
function wbSalesRetryMs(state) {
  const m = String(state?.last_error || '').match(/retry\\s+(\\d+)/i);
  return m ? Math.max(60, Number(m[1]) || 60) * 1000 : WB_SALES_RETRY_MS;
}
"""
if old not in s:
    raise SystemExit('WB sales constants marker missing')
s = s.replace(old, new, 1)

old = "const minGap = state?.last_error ? WB_SALES_RETRY_MS : WB_SALES_REFRESH_MS;"
new = "const minGap = state?.last_error ? wbSalesRetryMs(state) : WB_SALES_REFRESH_MS;"
if old not in s:
    raise SystemExit('WB sales minGap marker missing')
s = s.replace(old, new, 1)

old = """    if (!r.ok) {
      const err = String(data?.detail || data?.message || ('WB statistics HTTP ' + r.status));
      await env.DB.prepare('UPDATE wb_sales_live_state SET last_error=?,updated_at=? WHERE market=?').bind(err, Date.now(), market).run();
      return { ok: false, status: r.status, error: err };
    }
"""
new = """    if (!r.ok) {
      const baseErr = String(data?.detail || data?.message || ('WB statistics HTTP ' + r.status));
      const retryRaw = r.headers.get('X-RateLimit-Retry') || r.headers.get('Retry-After') || '';
      const retrySec = Math.max(0, Number(String(retryRaw).match(/\\d+/)?.[0] || 0));
      const err = baseErr + (retrySec ? ' · retry ' + retrySec : '');
      await env.DB.prepare('UPDATE wb_sales_live_state SET last_error=?,updated_at=? WHERE market=?').bind(err, Date.now(), market).run();
      return { ok: false, status: r.status, error: err, retryAfter: retrySec || null };
    }
"""
if old not in s:
    raise SystemExit('WB sales HTTP error marker missing')
s = s.replace(old, new, 1)

old = """  const totals = await env.DB.prepare(`SELECT COUNT(*) totalRows,
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
"""
new = """  const totals = await env.DB.prepare(`SELECT COUNT(*) totalRows,
      SUM(CASE WHEN is_return=0 THEN 1 ELSE 0 END) sales,
      SUM(CASE WHEN is_return=1 THEN 1 ELSE 0 END) returns,
      SUM(CASE WHEN is_return=1 THEN -finished_price ELSE finished_price END) finishedPrice,
      SUM(CASE WHEN is_return=1 THEN -price_with_disc ELSE price_with_disc END) priceWithDisc,
      SUM(CASE WHEN is_return=1 THEN -for_pay ELSE for_pay END) forPay
    FROM wb_sales_live_rows WHERE market=? AND sale_date>=? AND sale_date<?`).bind(market,since,until).first();
  const state = await env.DB.prepare('SELECT * FROM wb_sales_live_state WHERE market=?').bind(market).first();
  const sales = Number(totals?.sales || 0), returns = Number(totals?.returns || 0), netQty = sales - returns;
  const lastSuccessAt = Number(state?.last_success_at || 0) || null;
  const products = (rows.results || []).map(x => {
    const finishedPrice = Number(x.finishedPrice || 0), priceWithDisc = Number(x.priceWithDisc || 0), forPay = Number(x.forPay || 0);
    return {...x, qty:Number(x.qty||0), finishedPrice, priceWithDisc, forPay, buyoutSum:finishedPrice};
  }).filter(x=>x.qty!==0);
  return {
    ok: true, available: !!lastSuccessAt, market, days, since, until,
    totalRows: Number(totals?.totalRows || 0), sales, returns, netQty,
    buyoutCount: netQty,
    buyoutSum: Number(totals?.finishedPrice || 0),
    forPay: Number(totals?.forPay || 0),
    products,
    cached: true,lastSuccessAt,lastError:String(state?.last_error||''),
    nextSyncAt: Number(state?.last_attempt_at || 0) + (state?.last_error ? wbSalesRetryMs(state) : WB_SALES_REFRESH_MS),
    stale: !lastSuccessAt || Date.now()-lastSuccessAt>WB_SALES_REFRESH_MS*2,
    source: 'WB Statistics · supplier/sales'
  };
"""
if old not in s:
    raise SystemExit('WB sales totals marker missing')
s = s.replace(old, new, 1)

old = """  await ensureWbSalesCache(env.DB);
  const count = await env.DB.prepare('SELECT COUNT(*) n FROM wb_sales_live_rows WHERE market=?').bind(market).first();
  const state = await env.DB.prepare('SELECT * FROM wb_sales_live_state WHERE market=?').bind(market).first();
  return json(await readWbSalesCache(env, market, days),200,request,env);
"""
new = """  await ensureWbSalesCache(env.DB);
  if (url.searchParams.get('refresh') === '1') await syncWbSalesCache(env, market, { force: false });
  return json(await readWbSalesCache(env, market, days),200,request,env);
"""
if old not in s:
    raise SystemExit('WB sales cached endpoint marker missing')
s = s.replace(old, new, 1)

start = s.find("  async scheduled(controller, env, ctx) {\n    const refreshDue=async()=>{")
if start < 0:
    raise SystemExit('scheduled analytics block start missing')
end_marker = "\n  }\n};"
end = s.find(end_marker, start)
if end < 0:
    raise SystemExit('scheduled analytics block end missing')
replacement = """  async scheduled(controller, env, ctx) {
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
  }"""
s = s[:start] + replacement + s[end + len("\n  }"):]
fixed.write_text(s, encoding='utf-8')

html = Path('index.html')
h = html.read_text(encoding='utf-8')

old = "MILLIONER_API+'/api/wb-buyouts-live?market='+encodeURIComponent(market)+'&days='+encodeURIComponent(days)"
new = "MILLIONER_API+'/api/wb-sales-live?market='+encodeURIComponent(market)+'&days='+encodeURIComponent(days)"
if old not in h:
    raise SystemExit('WB overview endpoint marker missing')
h = h.replace(old, new)

old = "MILLIONER_API+'/api/wb-buyouts-live?market='+encodeURIComponent(market)+'&days='+encodeURIComponent(periodDays)"
new = "MILLIONER_API+'/api/wb-sales-live?market='+encodeURIComponent(market)+'&days='+encodeURIComponent(periodDays)"
if old in h:
    h = h.replace(old, new)

old = "const preliminaryPayout=Number(x.buyoutSum)||0,profit=preliminaryPayout-cost;"
new = "const preliminaryPayout=Number(x.forPay||x.buyoutSum)||0,profit=preliminaryPayout-cost;"
if old not in h:
    raise SystemExit('preliminary payout marker missing')
h = h.replace(old, new, 1)

h = h.replace('Количество — показатель «Выкупы» из аналитики WB.', 'Количество — фактические продажи WB минус возвраты из оперативного отчёта продаж.')
h = h.replace('Количество — показатель «Выкупы» из аналитики WB. Финансовые удержания WB за свежий период ещё могут измениться;', 'Количество — фактические продажи WB минус возвраты. Финансовые удержания WB за свежий период ещё могут измениться;')
h = h.replace('Выкупы WB за ${esc(periodText)} ещё синхронизируются.', 'Реализованные продажи WB за ${esc(periodText)} ещё синхронизируются.')
h = h.replace('За ${esc(periodText)} выкупов WB нет.', 'За ${esc(periodText)} реализованных продаж WB нет.')

old = "document.querySelectorAll('nav button').forEach(b=>b.onclick=()=>openView(b.dataset.view,true));"
new = "document.querySelectorAll('nav button').forEach(b=>b.onclick=()=>{openView(b.dataset.view,true);if(b.dataset.view==='settings'||b.dataset.view==='reports')loadSharedOrderCache({silent:true})});"
if old not in h:
    raise SystemExit('nav refresh marker missing')
h = h.replace(old, new, 1)

html.write_text(h, encoding='utf-8')
print('patched WB realized sales source, cache retry and fresh integration status')
