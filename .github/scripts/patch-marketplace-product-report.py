from pathlib import Path

p=Path('index.html')
s=p.read_text(encoding='utf-8')

start=s.index('function financialSales(){')
end=s.index('function salesDays(',start)
new=r'''function reportPeriodStart(days){const n=Math.max(1,Number(days)||1),d=new Date();d.setHours(0,0,0,0);d.setDate(d.getDate()-(n-1));return d.getTime()}
function reportMarketplaceSales(){const saved=new Map();for(const s of(state.sales||[])){if(!s.externalKey)continue;saved.set(String(s.externalKey),s);if(s.channel==='Kaspi'&&String(s.externalKey).startsWith('Kaspi:'))saved.set(String(s.externalKey).slice(6),s)}const out=[];const feeds=[[state.kaspiOrderFeed||[],'Kaspi'],[state.wbOrderFeed||[],'WB'],[state.ozonOrderFeed||[],'Ozon']];for(const [feed,fallbackMarket] of feeds){for(const o of feed){const market=String(o.market||fallbackMarket),creationDate=Number(o.creationDate)||0;if(!creationDate||!isMarketplaceSaleOrder(market,o.status,o.state))continue;const legacy=String(o.orderId)+':'+String(o.entryId),key=market+':'+legacy,old=saved.get(key)||(market==='Kaspi'?saved.get(legacy):null),qty=Math.max(0,Number(o.qty)||Number(old?.qty)||0);if(!qty)continue;const apiFeeTotal=Math.max(0,Number(o.marketplaceFee)||0)+Math.max(0,Number(o.sellerDeliveryCost)||0),apiFee=qty?apiFeeTotal/qty:0;out.push({...old,id:old?.id||('report-'+key),productId:o.productId||old?.productId||null,qty,price:Number(old?.price)||Number(o.unitPrice)||0,cost:Number(old?.cost)||0,fee:apiFee>0?apiFee:(Number(old?.fee)||0),channel:market,date:creationDate,externalKey:key})}}return out}
function financialSales(){const local=(state.sales||[]).filter(s=>!['Kaspi','WB','WB2','Ozon'].includes(String(s.channel||'')));return [...local,...reportMarketplaceSales()]}
'''
s=s[:start]+new+s[end:]

old="function renderReports(){document.querySelectorAll('[data-report-period]').forEach(b=>b.classList.toggle('active',Number(b.dataset.reportPeriod)===reportPeriodPreset));let since=Date.now()-reportPeriod*86400000,ss=financialSales().filter(s=>s.date>=since)"
new="function renderReports(){document.querySelectorAll('[data-report-period]').forEach(b=>b.classList.toggle('active',Number(b.dataset.reportPeriod)===reportPeriodPreset));let since=reportPeriodStart(reportPeriod),ss=financialSales().filter(s=>Number(s.date)>=since)"
if old not in s: raise SystemExit('renderReports period marker missing')
s=s.replace(old,new,1)

old="function marketplaceProductStats(market,days=reportPeriod){const since=Date.now()-Math.max(1,Number(days)||1)*86400000,rows=financialSales().filter(s=>s.date>=since&&s.channel===market)"
new="function marketplaceProductStats(market,days=reportPeriod){const since=reportPeriodStart(days),rows=financialSales().filter(s=>Number(s.date)>=since&&s.channel===market)"
if old not in s: raise SystemExit('marketplace report period marker missing')
s=s.replace(old,new,1)

p.write_text(s,encoding='utf-8')
