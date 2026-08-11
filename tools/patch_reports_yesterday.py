from pathlib import Path

p = Path('index.html')
s = p.read_text(encoding='utf-8')  # Always read the full current main file before patching.

old = '<section id="reports" class="view"><h2>Отчёты</h2><div id="reportPeriod" class="period"><button class="chip" data-report-period="1" onclick="setReportPeriod(1)">Сегодня</button><button class="chip" data-report-period="7" onclick="setReportPeriod(7)">7 дней</button>'
new = '<section id="reports" class="view"><h2>Отчёты</h2><div id="reportPeriod" class="period"><button class="chip" data-report-period="1" onclick="setReportPeriod(1)">Сегодня</button><button class="chip" data-report-period="-1" onclick="setReportPeriod(-1)">Вчера</button><button class="chip" data-report-period="7" onclick="setReportPeriod(7)">7 дней</button>'
if old not in s:
    raise SystemExit('Reports period buttons anchor not found')
s = s.replace(old, new, 1)

old = "let reportPeriodPreset=[0,1,7,30].includes(Number(state.settings.reportPeriodPreset))?Number(state.settings.reportPeriodPreset):1;let reportPeriod=reportPeriodPreset===0?Math.max(1,Number(state.settings.reportPeriod)||14):reportPeriodPreset;"
new = "let reportPeriodPreset=[-1,0,1,7,30].includes(Number(state.settings.reportPeriodPreset))?Number(state.settings.reportPeriodPreset):1;let reportPeriod=reportPeriodPreset===0?Math.max(1,Number(state.settings.reportPeriod)||14):reportPeriodPreset;"
if old not in s:
    raise SystemExit('Report period state anchor not found')
s = s.replace(old, new, 1)

lines = s.splitlines()

def replace_line(prefix, new_line):
    global lines
    hits = [i for i, line in enumerate(lines) if line.startswith(prefix)]
    if len(hits) != 1:
        raise SystemExit(f'Expected one {prefix!r}, got {len(hits)}')
    lines[hits[0]] = new_line

replace_line(
    'function reportPeriodStart(days){',
    "function reportPeriodStart(days){const raw=Number(days),d=new Date();d.setHours(0,0,0,0);if(raw===-1){d.setDate(d.getDate()-1);return d.getTime()}const n=Math.max(1,raw||1);d.setDate(d.getDate()-(n-1));return d.getTime()}"
)
replace_line(
    'function reportPeriodEnd(){',
    "function reportPeriodEnd(days=1){const d=new Date();d.setHours(0,0,0,0);if(Number(days)===-1)return d.getTime();d.setDate(d.getDate()+1);return d.getTime()}"
)

# Exact advertising date range: yesterday ends at today's 00:00, not tomorrow.
hits = [i for i, line in enumerate(lines) if line.startswith('function kaspiAdsBreakdown(days=reportPeriod){')]
if len(hits) != 1:
    raise SystemExit('Kaspi ads breakdown anchor not found')
i = hits[0]
if 'end=reportPeriodEnd(),' not in lines[i]:
    raise SystemExit('Kaspi ads report end anchor not found')
lines[i] = lines[i].replace('end=reportPeriodEnd(),', 'end=reportPeriodEnd(days),', 1)

replace_line(
    'function renderReports(){',
    "function renderReports(){document.querySelectorAll('[data-report-period]').forEach(b=>b.classList.toggle('active',Number(b.dataset.reportPeriod)===reportPeriodPreset));const since=reportPeriodStart(reportPeriod),until=reportPeriodEnd(reportPeriod);let ss=financialSales().filter(s=>Number(s.date)>=since&&Number(s.date)<until),rev=ss.reduce((a,s)=>a+(Number(s.qty)||0)*(Number(s.price)||0),0),cost=ss.reduce((a,s)=>a+(Number(s.qty)||0)*(Number(s.cost)||0),0),fees=ss.reduce((a,s)=>a+(Number(s.qty)||0)*(Number(s.fee)||0),0),ads=kaspiAdsBreakdown(reportPeriod).total;document.getElementById('rRevenue').textContent=fmt(rev);document.getElementById('rCost').textContent=fmt(cost);document.getElementById('rFees').textContent=fmt(fees);document.getElementById('rAds').textContent=fmt(ads);document.getElementById('rProfit').textContent=fmt(rev-cost-fees-ads);renderKaspiAdsStatus(reportPeriod);let names=['Kaspi','WB','WB2','Ozon','Ручная'];document.getElementById('mpReport').innerHTML=names.map(n=>{let a=ss.filter(s=>s.channel===n),channelRev=a.reduce((x,s)=>x+(Number(s.qty)||0)*(Number(s.price)||0),0),channelProfit=a.reduce((x,s)=>x+(Number(s.qty)||0)*((Number(s.price)||0)-(Number(s.cost)||0)-(Number(s.fee)||0)),0)-(n==='Kaspi'?ads:0);return `<div class=\"item row\" role=\"button\" tabindex=\"0\" style=\"cursor:pointer\" onclick=\"openMarketplaceReport('${n}',${reportPeriod})\"><div class=\"grow\"><b>${n}</b><div class=\"muted\">${a.reduce((x,s)=>x+(Number(s.qty)||0),0)} шт. · прибыль ${fmt(channelProfit)}</div></div><b>${fmt(channelRev)}</b></div>`}).join('')}"
)
replace_line(
    'function marketplaceProductStats(market,days=reportPeriod){',
    "function marketplaceProductStats(market,days=reportPeriod){const since=reportPeriodStart(days),until=reportPeriodEnd(days),rows=financialSales().filter(s=>Number(s.date)>=since&&Number(s.date)<until&&s.channel===market),map=new Map();for(const sale of rows){const p=prod(sale.productId),key=sale.productId||'unknown',qty=Number(sale.qty)||0,revenue=qty*(Number(sale.price)||0),cost=qty*(Number(sale.cost)||0),fees=qty*(Number(sale.fee)||0);let x=map.get(key);if(!x){x={productId:sale.productId,name:p?.name||'Неизвестный товар',qty:0,revenue:0,cost:0,fees:0,ads:0,profit:0};map.set(key,x)}x.qty+=qty;x.revenue+=revenue;x.cost+=cost;x.fees+=fees;x.profit+=revenue-cost-fees}if(market==='Kaspi'){const ads=kaspiAdsBreakdown(days);for(const [productId,amount] of ads.byProduct){let x=map.get(productId),p=prod(productId);if(!x){x={productId,name:p?.name||'Реклама Kaspi',qty:0,revenue:0,cost:0,fees:0,ads:0,profit:0};map.set(productId,x)}x.ads+=amount;x.profit-=amount}if(ads.unmatched>0){map.set('__kaspi_ads_unmatched__',{productId:null,name:'Реклама Kaspi без привязки',qty:0,revenue:0,cost:0,fees:0,ads:ads.unmatched,profit:-ads.unmatched})}}return [...map.values()].sort((a,b)=>b.profit-a.profit)}"
)
replace_line(
    'function openMarketplaceReport(market,days=reportPeriod){',
    "function openMarketplaceReport(market,days=reportPeriod){const raw=Number(days);marketplaceReportContext={market,days:raw===-1?-1:Math.max(1,raw||1)};renderMarketplaceReportSheet()}"
)
replace_line(
    'function setMarketplaceReportPeriod(days){',
    "function setMarketplaceReportPeriod(days){if(!marketplaceReportContext)return;let d=Number(days);if(d===0){const x=prompt('Количество дней для своего периода',String(marketplaceReportContext.days>0?marketplaceReportContext.days:14));if(x===null)return;d=Math.max(1,Number(x)||1)}else if(d!==-1)d=Math.max(1,d||1);marketplaceReportContext.days=d;renderMarketplaceReportSheet()}"
)
replace_line(
    'function renderMarketplaceReportSheet(){',
    "function renderMarketplaceReportSheet(){const market=marketplaceReportContext?.market,raw=Number(marketplaceReportContext?.days),days=raw===-1?-1:Math.max(1,raw||1);if(!market)return;const rows=marketplaceProductStats(market,days),qty=rows.reduce((a,x)=>a+x.qty,0),profit=rows.reduce((a,x)=>a+x.profit,0);const periodButtons=`<div class=\"period\" style=\"margin-top:0\"><button class=\"chip ${days===1?'active':''}\" onclick=\"setMarketplaceReportPeriod(1)\">Сегодня</button><button class=\"chip ${days===-1?'active':''}\" onclick=\"setMarketplaceReportPeriod(-1)\">Вчера</button><button class=\"chip ${days===7?'active':''}\" onclick=\"setMarketplaceReportPeriod(7)\">7 дней</button><button class=\"chip ${days===30?'active':''}\" onclick=\"setMarketplaceReportPeriod(30)\">30 дней</button><button class=\"chip ${![-1,1,7,30].includes(days)?'active':''}\" onclick=\"setMarketplaceReportPeriod(0)\">Свой период</button></div>`;const head=`<div class=\"item\"><div class=\"row\"><div class=\"grow\"><div class=\"label\">Продано</div><div class=\"num\">${qty} шт.</div></div><div class=\"right\"><div class=\"label\">Общая прибыль</div><div class=\"num\">${fmt(profit)}</div></div></div></div>`;const body=rows.length?rows.map((x,i)=>{const unit=x.qty?x.profit/x.qty:0;return `<div class=\"item\" style=\"margin-top:8px;${x.productId?'cursor:pointer':''}\" ${x.productId?`onclick=\"openProduct('${x.productId}','${market}',${days})\"`:''}><div class=\"name\">${i+1}. ${esc(x.name)}</div><div style=\"display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:10px\"><div><div class=\"label\">Продано</div><b>${x.qty} шт.</b></div><div><div class=\"label\">Прибыль / шт.</div><b>${fmt(unit)}</b></div><div class=\"right\"><div class=\"label\">Общая прибыль</div><b>${fmt(x.profit)}</b></div></div></div>`}).join(''):'<div class=\"empty\">За выбранный период продаж нет</div>';showSheet(`<h3>Продажи ${esc(market)}</h3>${periodButtons}${head}${body}`)}"
)
replace_line(
    'function productKaspiDelivery(p,days=30){',
    "function productKaspiDelivery(p,days=30){const since=reportPeriodStart(days),until=reportPeriodEnd(days);return (state.kaspiOrderFeed||[]).filter(o=>o.productId===p.id&&Number(o.creationDate)>=since&&Number(o.creationDate)<until&&isMarketplaceSaleOrder('Kaspi',o.status,o.state)).reduce((a,o)=>a+Math.max(0,Number(o.sellerDeliveryCost)||0),0)}"
)
replace_line(
    'function openProduct(pid,market=\'\',days=30){',
    "function openProduct(pid,market='',days=30){let p=prod(pid);if(!p)return;const raw=Number(days),periodDays=raw===-1?-1:Math.max(1,raw||30),since=reportPeriodStart(periodDays),until=reportPeriodEnd(periodDays),periodText=periodDays===-1?'вчера':periodDays===1?'сегодня':periodDays+' дней',baseProfit=market?financialSales().filter(x=>x.productId===p.id&&x.channel===market&&Number(x.date)>=since&&Number(x.date)<until).reduce((a,x)=>a+(Number(x.qty)||0)*((Number(x.price)||0)-(Number(x.cost)||0)-(Number(x.fee)||0)),0):profitForProduct(p,periodDays),adCost=market==='Kaspi'?kaspiAdsForProduct(p.id,periodDays):0,profit=market==='Kaspi'?baseProfit-adCost:baseProfit,profitLabel=market?`Прибыль ${esc(market)} за ${periodText}`:'Прибыль за '+periodText,deliveryDays=market==='Kaspi'?periodDays:30,deliveryText=deliveryDays===-1?'вчера':deliveryDays===1?'сегодня':deliveryDays+' дней',kaspiDelivery=productKaspiDelivery(p,deliveryDays),deliveryLabel=`Расход на доставку Kaspi за ${deliveryText}`,adRow=market==='Kaspi'?`<div style=\"margin-top:8px\"><div class=\"muted\">Расход на рекламу Kaspi за ${periodText}</div><b>${fmt(adCost)}</b></div>`:'';let s=`<h3>${esc(p.name)}</h3><div class=\"item\"><b>Остаток товара</b><div style=\"margin-top:10px\"><div class=\"label\">Всего на складе</div><div class=\"num\">${p.stock} шт.</div></div><div style=\"margin-top:12px\"><div class=\"muted\">Себестоимость 1 шт.</div><b>${fmt(p.cost)}</b></div><div style=\"margin-top:8px\"><div class=\"muted\">${deliveryLabel}</div><b>${fmt(kaspiDelivery)}</b></div>${adRow}<div style=\"margin-top:8px\"><div class=\"muted\">${profitLabel}</div><b>${fmt(profit)}</b></div></div><div class=\"item\" style=\"margin-top:8px\"><b>Артикулы маркетплейсов</b><div style=\"margin-top:9px;line-height:1.8\"><div><span class=\"muted\">Kaspi:</span> ${esc(p.kaspi||'—')}</div><div><span class=\"muted\">WB 1:</span> ${esc(p.wb||'—')}</div><div><span class=\"muted\">WB 2:</span> ${esc(p.wb2||'—')}</div><div><span class=\"muted\">Ozon:</span> ${esc(p.ozon||'—')}</div></div></div><button class=\"btn dark full\" onclick=\"closeModal();openModal('edit','${pid}')\">Редактировать товар</button><button class=\"btn full\" onclick=\"closeModal();openModal('writeoff','${pid}')\">Списать</button><button class=\"btn full\" onclick=\"closeModal();openModal('inventory','${pid}')\">Инвентаризация</button>`;showSheet(s)}"
)

out = '\n'.join(lines) + ('\n' if s.endswith('\n') else '')
if 'data-report-period="-1"' not in out or "raw===-1?-1" not in out:
    raise SystemExit('Yesterday markers missing after patch')
p.write_text(out, encoding='utf-8')
print('Reports Yesterday period added with exact start/end bounds.')
