from pathlib import Path
import re

root=Path(__file__).resolve().parents[1]
api_path=root/'cloudflare/millioner-api/src/index.js'
html_path=root/'index.html'
api=api_path.read_text(encoding='utf-8')
html=html_path.read_text(encoding='utf-8')

# ---- Server: richer WB finance summary + per-product finance aggregation ----
summary_pat=re.compile(r"      if \(url\.pathname === '/api/wb-finance-summary'.*?\n      \}\n\n",re.S)
if not summary_pat.search(api):
    raise SystemExit('WB finance summary route not found')
new_summary=r'''      if (url.pathname === '/api/wb-finance-summary' && request.method === 'GET') {
        const market=normalizeMarket(url.searchParams.get('market'));
        if(!['WB','WB2'].includes(market)) return json({ok:false,error:'market must be WB or WB2'},400,cors);
        const days=Math.max(1,Math.min(3660,Number(url.searchParams.get('days')||30)));
        const since=Date.now()-days*86400000;
        const f=await env.DB.prepare(`SELECT SUM(retail_amount) retailAmount,SUM(for_pay) forPay,SUM(acquiring_fee) acquiring,SUM(delivery_service) delivery,SUM(paid_storage) storage,SUM(paid_acceptance) acceptance,SUM(deduction) deduction,SUM(penalty) penalty,SUM(additional_payment) additionalPayment,SUM(rebill_logistic_cost) rebill FROM wb_finance_rows WHERE market=? AND rr_date>=?`).bind(market,since).first();
        const day=new Date(since).toISOString().slice(0,10);
        const a=await env.DB.prepare(`SELECT SUM(amount) allAds,SUM(CASE WHEN lower(payment_type) LIKE '%счет%' OR lower(payment_type) LIKE '%account%' THEN amount ELSE 0 END) accountAds FROM wb_ad_costs WHERE market=? AND day>=?`).bind(market,day).first();
        const n=x=>Number(x||0);
        const wbCharges=n(f?.acquiring)+n(f?.delivery)+n(f?.storage)+n(f?.acceptance)+n(f?.deduction)+n(f?.penalty)+n(f?.rebill);
        const accountAdvertising=n(a?.accountAds);
        const netBeforeCost=n(f?.forPay)-wbCharges+n(f?.additionalPayment)-accountAdvertising;
        return json({ok:true,market,days,retailAmount:n(f?.retailAmount),forPay:n(f?.forPay),acquiring:n(f?.acquiring),delivery:n(f?.delivery),storage:n(f?.storage),acceptance:n(f?.acceptance),deduction:n(f?.deduction),penalty:n(f?.penalty),additionalPayment:n(f?.additionalPayment),rebill:n(f?.rebill),advertising:n(a?.allAds),accountAdvertising,wbCharges,netBeforeCost},200,cors);
      }

      if (url.pathname === '/api/wb-finance-products' && request.method === 'GET') {
        const market=normalizeMarket(url.searchParams.get('market'));
        if(!['WB','WB2'].includes(market)) return json({ok:false,error:'market must be WB or WB2'},400,cors);
        const days=Math.max(1,Math.min(3660,Number(url.searchParams.get('days')||30)));
        const since=Date.now()-days*86400000;
        const rows=await env.DB.prepare(`
          SELECT f.vendor_code AS vendorCode,f.nm_id AS nmId,MAX(f.title) AS title,l.product_id AS productId,
                 SUM(f.qty) AS qty,SUM(f.retail_amount) AS retailAmount,SUM(f.for_pay) AS forPay,
                 SUM(f.acquiring_fee) AS acquiring,SUM(f.delivery_service) AS delivery,
                 SUM(f.paid_storage) AS storage,SUM(f.paid_acceptance) AS acceptance,
                 SUM(f.deduction) AS deduction,SUM(f.penalty) AS penalty,
                 SUM(f.additional_payment) AS additionalPayment,SUM(f.rebill_logistic_cost) AS rebill
          FROM wb_finance_rows f
          LEFT JOIN product_links l ON l.market=f.market AND l.sku=f.vendor_code
          WHERE f.market=? AND f.rr_date>=?
          GROUP BY f.vendor_code,f.nm_id,l.product_id
          ORDER BY SUM(f.for_pay) DESC`).bind(market,since).all();
        const n=x=>Number(x||0);
        const products=(rows.results||[]).map(x=>{const wbCharges=n(x.acquiring)+n(x.delivery)+n(x.storage)+n(x.acceptance)+n(x.deduction)+n(x.penalty)+n(x.rebill);return {...x,qty:n(x.qty),retailAmount:n(x.retailAmount),forPay:n(x.forPay),acquiring:n(x.acquiring),delivery:n(x.delivery),storage:n(x.storage),acceptance:n(x.acceptance),deduction:n(x.deduction),penalty:n(x.penalty),additionalPayment:n(x.additionalPayment),rebill:n(x.rebill),wbCharges,netBeforeCost:n(x.forPay)-wbCharges+n(x.additionalPayment)}});
        const day=new Date(since).toISOString().slice(0,10);
        const ad=await env.DB.prepare(`SELECT SUM(amount) allAds,SUM(CASE WHEN lower(payment_type) LIKE '%счет%' OR lower(payment_type) LIKE '%account%' THEN amount ELSE 0 END) accountAds FROM wb_ad_costs WHERE market=? AND day>=?`).bind(market,day).first();
        return json({ok:true,market,days,products,advertising:n(ad?.allAds),accountAdvertising:n(ad?.accountAds)},200,cors);
      }

'''
api=summary_pat.sub(new_summary,api,count=1)

# Promotion cost rows sometimes have null updTime. Use the requested range end only as a fallback,
# but keep the real date where WB supplies it. This avoids dropping valid rows.
api=api.replace("const ts=String(x.updTime||''),day=(ts?ts.slice(0,10):toDay)","const ts=String(x.updTime||''),day=(ts?ts.slice(0,10):toDay)")

# ---- Browser: cache live WB summaries and use them for report cards ----
anchor="function renderReports(){"
if anchor not in html:
    raise SystemExit('renderReports anchor not found')
helpers=r'''const wbFinanceReportCache=new Map();
const wbFinanceReportLoading=new Set();
function wbFinanceReportKey(market,days){return market+':'+String(days)}
function wbFinanceCached(market,days){return wbFinanceReportCache.get(wbFinanceReportKey(market,days))||null}
async function ensureWbFinanceSummary(market,days){if(!['WB','WB2'].includes(market))return null;const key=wbFinanceReportKey(market,days);if(wbFinanceReportCache.has(key))return wbFinanceReportCache.get(key);if(wbFinanceReportLoading.has(key))return null;wbFinanceReportLoading.add(key);try{const data=await apiJson(MILLIONER_API+'/api/wb-finance-summary?market='+encodeURIComponent(market)+'&days='+encodeURIComponent(days));wbFinanceReportCache.set(key,data);const active=document.getElementById('reports')?.classList.contains('active');if(active)renderReports();return data}catch(e){console.warn('WB finance summary',market,e);return null}finally{wbFinanceReportLoading.delete(key)}}
function wbLocalCost(market,days){const since=reportPeriodStart(days),until=reportPeriodEnd(days);return financialSales().filter(s=>s.channel===market&&Number(s.date)>=since&&Number(s.date)<until).reduce((a,s)=>a+(Number(s.qty)||0)*(Number(s.cost)||0),0)}
'''
if 'function wbFinanceReportKey(' not in html:
    html=html.replace(anchor,helpers+anchor,1)

render_pat=re.compile(r"function renderReports\(\)\{.*?\nfunction marketplaceProductStats",re.S)
if not render_pat.search(html):
    raise SystemExit('renderReports block not found')
new_render=r'''function renderReports(){document.querySelectorAll('[data-report-period]').forEach(b=>b.classList.toggle('active',Number(b.dataset.reportPeriod)===reportPeriodPreset));const since=reportPeriodStart(reportPeriod),until=reportPeriodEnd(reportPeriod);let ss=financialSales().filter(s=>Number(s.date)>=since&&Number(s.date)<until),rev=ss.reduce((a,s)=>a+(Number(s.qty)||0)*(Number(s.price)||0),0),cost=ss.reduce((a,s)=>a+(Number(s.qty)||0)*(Number(s.cost)||0),0),fees=ss.reduce((a,s)=>a+(Number(s.qty)||0)*(Number(s.fee)||0),0),ads=kaspiAdsBreakdown(reportPeriod).total;document.getElementById('rRevenue').textContent=fmt(rev);document.getElementById('rCost').textContent=fmt(cost);document.getElementById('rFees').textContent=fmt(fees);document.getElementById('rAds').textContent=fmt(ads);document.getElementById('rProfit').textContent=fmt(rev-cost-fees-ads);renderKaspiAdsStatus(reportPeriod);let names=['Kaspi','WB','WB2','Ozon','Ручная'];document.getElementById('mpReport').innerHTML=names.map(n=>{let a=ss.filter(s=>s.channel===n),channelRev=a.reduce((x,s)=>x+(Number(s.qty)||0)*(Number(s.price)||0),0),channelProfit=a.reduce((x,s)=>x+(Number(s.qty)||0)*((Number(s.price)||0)-(Number(s.cost)||0)-(Number(s.fee)||0)),0)-(n==='Kaspi'?ads:0),finance=null,financeLabel='';if(n==='WB'||n==='WB2'){finance=wbFinanceCached(n,reportPeriod);if(finance){channelRev=Number(finance.retailAmount)||channelRev;channelProfit=(Number(finance.netBeforeCost)||0)-wbLocalCost(n,reportPeriod);financeLabel=' · факт WB'}else{ensureWbFinanceSummary(n,reportPeriod);financeLabel=' · финансы загружаются'}}return `<div class="item row" role="button" tabindex="0" style="cursor:pointer" onclick="openMarketplaceReport('${n}',${reportPeriod})"><div class="grow"><b>${n}</b><div class="muted">${a.reduce((x,s)=>x+(Number(s.qty)||0),0)} шт. · прибыль ${fmt(channelProfit)}${financeLabel}</div></div><b>${fmt(channelRev)}</b></div>`}).join('')}
function marketplaceProductStats'''
html=render_pat.sub(new_render,html,count=1)

# ---- WB detailed marketplace report using finance rows + local FIFO costs ----
open_pat=re.compile(r"function openMarketplaceReport\(market,days=reportPeriod\)\{.*?\}\nfunction setMarketplaceReportPeriod",re.S)
if not open_pat.search(html):
    raise SystemExit('openMarketplaceReport block not found')
new_open=r'''async function openWbFinanceReport(market,days){const raw=Number(days),periodDays=raw===-1?-1:Math.max(1,raw||30);showSheet(`<h3>Продажи ${esc(market)}</h3><div class="empty">Загружаю фактический финансовый отчёт WB…</div>`);try{const data=await apiJson(MILLIONER_API+'/api/wb-finance-products?market='+encodeURIComponent(market)+'&days='+encodeURIComponent(periodDays));const since=reportPeriodStart(periodDays),until=reportPeriodEnd(periodDays),sales=financialSales().filter(s=>s.channel===market&&Number(s.date)>=since&&Number(s.date)<until);const costByProduct=new Map();for(const s of sales)costByProduct.set(String(s.productId),(costByProduct.get(String(s.productId))||0)+(Number(s.qty)||0)*(Number(s.cost)||0));let matchedNet=0,matchedCost=0,unallocatedNet=0;const rows=(data.products||[]).map(x=>{const pid=x.productId?String(x.productId):'',cost=pid?(costByProduct.get(pid)||0):0,net=Number(x.netBeforeCost)||0;if(pid){matchedNet+=net;matchedCost+=cost}else unallocatedNet+=net;return {...x,cost,profit:net-cost}});const accountAds=Math.max(0,Number(data.accountAdvertising)||0),totalProfit=matchedNet+unallocatedNet-matchedCost-accountAds,periodText=periodDays===-1?'вчера':periodDays===1?'сегодня':periodDays+' дней';const head=`<div class="item"><div class="row"><div class="grow"><div class="label">Чистая прибыль · факт WB</div><div class="num">${fmt(totalProfit)}</div></div><div class="right"><div class="label">Реклама со счёта</div><div class="num">${fmt(accountAds)}</div></div></div><div class="muted" style="margin-top:8px">WB выплаты и удержания взяты из финансового отчёта. Себестоимость — FIFO из склада. Общие строки WB без артикула учитываются в общей прибыли.</div></div>`;const body=rows.length?rows.sort((a,b)=>b.profit-a.profit).map((x,i)=>{const p=x.productId?prod(String(x.productId)):null,name=p?.name||x.title||x.vendorCode||('WB '+x.nmId),unit=Number(x.qty)?x.profit/Math.abs(Number(x.qty)):0;return `<div class="item" style="margin-top:8px;${p?'cursor:pointer':''}" ${p?`onclick="openProduct('${p.id}','${market}',${periodDays})"`:''}><div class="name">${i+1}. ${esc(name)}</div><div class="muted">Артикул WB: ${esc(x.vendorCode||'—')}${p?'':' · не привязан к товару склада'}</div><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:10px"><div><div class="label">Кол-во в отчёте</div><b>${Number(x.qty||0).toFixed(0)} шт.</b></div><div><div class="label">Прибыль / шт.</div><b>${fmt(unit)}</b></div><div class="right"><div class="label">Чистая прибыль</div><b>${fmt(x.profit)}</b></div></div><div class="muted" style="margin-top:8px">К перечислению: ${fmt(x.forPay)} · расходы WB: ${fmt(x.wbCharges)} · себестоимость FIFO: ${fmt(x.cost)}</div></div>`}).join(''):'<div class="empty">Финансовых строк WB за '+esc(periodText)+' нет</div>';showSheet(`<h3>Продажи ${esc(market)} · ${esc(periodText)}</h3>${head}${body}`)}catch(e){showSheet(`<h3>Продажи ${esc(market)}</h3><div class="empty">Не удалось загрузить финансовый отчёт: ${esc(String(e.message||e))}</div>`)} }
function openMarketplaceReport(market,days=reportPeriod){const raw=Number(days);if(market==='WB'||market==='WB2'){openWbFinanceReport(market,raw===-1?-1:Math.max(1,raw||1));return}marketplaceReportContext={market,days:raw===-1?-1:Math.max(1,raw||1)};renderMarketplaceReportSheet()}
function setMarketplaceReportPeriod'''
html=open_pat.sub(new_open,html,count=1)

# syntax/marker guards
required_api=["'/api/wb-finance-products'",'netBeforeCost','accountAdvertising']
required_html=['function openWbFinanceReport','function ensureWbFinanceSummary','факт WB']
missing=[x for x in required_api if x not in api]+[x for x in required_html if x not in html]
if missing:
    raise SystemExit('Missing markers: '+', '.join(missing))

api_path.write_text(api,encoding='utf-8')
html_path.write_text(html,encoding='utf-8')
print('WB true profit patch applied')
