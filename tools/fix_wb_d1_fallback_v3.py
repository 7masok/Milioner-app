from pathlib import Path
import re

# --- Worker ---
p = Path('cloudflare/millioner-api/src/fixed.js')
s = p.read_text()

a = s.index('async function wbBuyoutsCachedEndpoint')
b = s.index('\n// WB_BUYOUTS_ANALYTICS_V1', a)
block = s[a:b]
needle = "return json({ok:false,market,days,error:String(e?.message||e)},500,request,env);"
if needle not in block:
    raise SystemExit('buyout endpoint error return not found')
block = block.replace(needle, 'return wbAnalyticsBuyouts(request,env,url);', 1)
s = s[:a] + block + s[b:]

# Direct Seller Analytics must survive D1 product_links failure.
a = s.index('async function wbAnalyticsBuyouts')
b = s.index('\n// WB_SALES_CACHE_V1', a)
block = s[a:b]
links = "  const links=await env.DB.prepare('SELECT sku,product_id AS productId FROM product_links WHERE market=?').bind(market).all();\n  const linkMap=new Map((links.results||[]).map(x=>[String(x.sku||'').trim(),String(x.productId||'')]));"
links_safe = """  let linkMap=new Map();
  try {
    const links=await env.DB.prepare('SELECT sku,product_id AS productId FROM product_links WHERE market=?').bind(market).all();
    linkMap=new Map((links.results||[]).map(x=>[String(x.sku||'').trim(),String(x.productId||'')]));
  } catch (_) {
    // D1 fallback: browser can match vendorCode/nmId against local warehouse state.
  }"""
if links not in block:
    raise SystemExit('direct analytics product_links block not found')
block = block.replace(links, links_safe, 1)
s = s[:a] + block + s[b:]
p.write_text(s)

# --- Frontend ---
p = Path('index.html')
h = p.read_text()

a = h.index('async function ensureWbLiveOverview')
b = h.index('\nfunction renderReports', a)
ensure = """async function ensureWbLiveOverview(market,days){
  const key=market+':'+days,old=wbLiveOverviewCache[key];
  if(old&&Date.now()-Number(old.at||0)<60000)return old.data;
  try{
    const data=await apiJson(MILLIONER_API+'/api/wb-sales-live?market='+encodeURIComponent(market)+'&days='+encodeURIComponent(days));
    if(!data?.ok)throw new Error(data?.error||'WB sales unavailable');
    wbLiveOverviewCache[key]={at:Date.now(),data};return data;
  }catch(primary){
    try{
      const fallback=await apiJson(MILLIONER_API+'/api/wb-buyouts-live?market='+encodeURIComponent(market)+'&days='+encodeURIComponent(days)+'&refresh=1');
      if(!fallback?.ok)throw new Error(fallback?.error||'WB analytics unavailable');
      const data={...fallback,available:true,analyticsOnly:true,source:'WB Seller Analytics · buyouts fallback'};
      wbLiveOverviewCache[key]={at:Date.now(),data};return data;
    }catch(e){
      wbLiveOverviewCache[key]={at:Date.now(),data:old?.data||null,error:String(e.message||primary.message||e)};
      return old?.data||null;
    }
  }
}"""
h = h[:a] + ensure + h[b:]

# Main marketplace report: unknown profit is shown as dash, not fake zero.
marker = "qty=Number(live.buyoutCount||0);channelRev=Number(live.buyoutSum||0);financeLabel=' · выкупы WB';"
if marker not in h:
    raise SystemExit('renderReports buyout assignment not found')
h = h.replace(marker, "qty=Number(live.buyoutCount||0);channelRev=Number(live.buyoutSum||0);if(live.analyticsOnly)channelProfit=null;financeLabel=' · выкупы WB';", 1)

# Detail sheet uses resilient loader.
a = h.index('async function openWbFinanceReport')
b = h.index('\nfunction openMarketplaceReport', a)
report = h[a:b]
pattern = r"apiJson\(MILLIONER_API\+'/api/wb-sales-live\?market='\+encodeURIComponent\(market\)\+'&days='\+encodeURIComponent\(periodDays\)\)"
report, n = re.subn(pattern, 'ensureWbLiveOverview(market,periodDays)', report, count=1)
if n != 1:
    raise SystemExit('openWbFinanceReport live request not found')

anchor = '    if(live.available===false&&!financeRows.length){'
if anchor not in report:
    raise SystemExit('WB report unavailable anchor not found')

fallback_sheet = r'''    if(live?.analyticsOnly){
      const analyticsRows=(live.products||[]).filter(x=>Number(x.qty||0)!==0),field=market==='WB2'?'wb2':'wb';
      const qty=Number(live.buyoutCount||0),gross=Number(live.buyoutSum||0);
      const body=analyticsRows.length?analyticsRows.map((x,i)=>{
        const keys=[x.vendorCode,String(x.nmId||''),x.barcode].map(v=>String(v||'').trim()).filter(Boolean);
        const p=(state.products||[]).find(z=>keys.includes(String(z?.[field]||'').trim()));
        const name=p?.name||x.title||x.vendorCode||('WB '+x.nmId);
        return `<div class="item" style="margin-top:8px"><div class="name">${i+1}. ${esc(name)}</div><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:10px"><div><div class="label">Реализовано</div><b>${Number(x.qty||0).toFixed(0)} шт.</b></div><div><div class="label">Прибыль / шт.</div><b>—</b></div><div class="right"><div class="label">Прибыль</div><b>—</b></div></div></div>`;
      }).join(''):`<div class="empty">За ${esc(periodText)} выкупов WB нет.</div>`;
      const head=`<div class="item"><div class="row"><div class="grow"><div class="label">Прибыль · уточняется</div><div class="num">—</div></div><div class="right"><div class="label">Реализовано</div><div class="num">${qty} шт.</div></div></div><div class="muted" style="margin-top:8px">Выкупы WB: ${fmt(gross)}. D1 временно недоступен, поэтому FIFO и итоговая прибыль не подставляются нулём.</div></div>`;
      showSheet(`<h3>Продажи ${esc(market)} · ${esc(periodText)}</h3>${head}${body}`);return;
    }
'''
report = report.replace(anchor, fallback_sheet + anchor, 1)
h = h[:a] + report + h[b:]
p.write_text(h)
