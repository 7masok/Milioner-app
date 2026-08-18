from pathlib import Path
import re

p = Path('index.html')
s = p.read_text(encoding='utf-8')

old = "function purchaseDemandQty(p,days=PURCHASE_COVER_DAYS){if(!p||isBundleProduct(p))return 0;const n=Math.max(1,Number(days)||PURCHASE_COVER_DAYS),since=reportPeriodStart(n),until=reportPeriodEnd(n);return financialSales().filter(x=>Number(x.date)>=since&&Number(x.date)<until).reduce((sum,sale)=>{const qty=Math.max(0,Number(sale.qty)||0);if(String(sale.productId)===String(p.id))return sum+qty;const soldProduct=prod(sale.productId);if(!isBundleProduct(soldProduct))return sum;const part=bundleComponents(soldProduct).find(x=>String(x.productId)===String(p.id));return sum+(part?qty*part.qty:0)},0)}"
new = """function purchaseSaleQtyForProduct(p,sale){if(!p||!sale)return 0;const qty=Math.max(0,Number(sale.qty)||0);if(String(sale.productId)===String(p.id))return qty;const soldProduct=prod(sale.productId);if(!isBundleProduct(soldProduct))return 0;const part=bundleComponents(soldProduct).find(x=>String(x.productId)===String(p.id));return part?qty*part.qty:0}
function purchaseSalesVelocity(p,maxDays=PURCHASE_COVER_DAYS){if(!p||isBundleProduct(p))return {days:0,qty:0,daily:0,projected:0};const cap=Math.max(1,Number(maxDays)||PURCHASE_COVER_DAYS),rows=financialSales().map(sale=>({sale,qty:purchaseSaleQtyForProduct(p,sale),date:Number(sale.date)||0})).filter(x=>x.qty>0&&x.date>0);if(!rows.length)return {days:cap,qty:0,daily:0,projected:0};const first=Math.min(...rows.map(x=>x.date)),firstDay=new Date(first),today=new Date();firstDay.setHours(0,0,0,0);today.setHours(0,0,0,0);const ageDays=Math.max(1,Math.floor((today.getTime()-firstDay.getTime())/86400000)+1),days=Math.min(cap,ageDays),since=reportPeriodStart(days),until=reportPeriodEnd(days),qty=rows.filter(x=>x.date>=since&&x.date<until).reduce((sum,x)=>sum+x.qty,0),daily=qty/days;return {days,qty,daily,projected:daily*cap}}
function purchaseDemandQty(p,days=PURCHASE_COVER_DAYS){const n=Math.max(1,Number(days)||PURCHASE_COVER_DAYS),v=purchaseSalesVelocity(p,PURCHASE_COVER_DAYS);return v.daily*n}
function productAdaptiveSalesVelocity(p,maxDays=PURCHASE_COVER_DAYS){if(!p)return {days:0,qty:0,daily:0};const cap=Math.max(1,Number(maxDays)||PURCHASE_COVER_DAYS),rows=financialSales().filter(x=>String(x.productId)===String(p.id)&&Number(x.date)>0);if(!rows.length)return {days:cap,qty:0,daily:0};const first=Math.min(...rows.map(x=>Number(x.date)||Date.now())),firstDay=new Date(first),today=new Date();firstDay.setHours(0,0,0,0);today.setHours(0,0,0,0);const ageDays=Math.max(1,Math.floor((today.getTime()-firstDay.getTime())/86400000)+1),days=Math.min(cap,ageDays),since=reportPeriodStart(days),until=reportPeriodEnd(days),qty=rows.filter(x=>Number(x.date)>=since&&Number(x.date)<until).reduce((sum,x)=>sum+Math.max(0,Number(x.qty)||0),0);return {days,qty,daily:qty/days}}"""
if old not in s:
    raise SystemExit('purchaseDemandQty target not found')
s = s.replace(old, new, 1)

old = "function purchaseRecommendation(p){if(!p||isBundleProduct(p))return null;const demand=purchaseDemandQty(p),daily=demand/PURCHASE_COVER_DAYS,available=productAvailableStock(p),inbound=purchaseInboundQty(p.id),coverage=available+inbound,targetQty=Math.ceil(demand),days=daily>0?coverage/daily:Infinity;if(!(daily>0)||days>=PURCHASE_COVER_DAYS)return null;const qty=Math.max(0,targetQty-coverage),unitCost=purchaseLastUnitCost(p.id),estimatedCost=qty*unitCost;return qty>0?{productId:p.id,product:p,qty,demand,daily,available,inbound,days,unitCost,estimatedCost}:null}"
new = "function purchaseRecommendation(p){if(!p||isBundleProduct(p))return null;const velocity=purchaseSalesVelocity(p,PURCHASE_COVER_DAYS),daily=velocity.daily,demand=velocity.projected,available=productAvailableStock(p),inbound=purchaseInboundQty(p.id),coverage=available+inbound,targetQty=Math.ceil(demand),days=daily>0?coverage/daily:Infinity;if(!(daily>0)||days>=PURCHASE_COVER_DAYS)return null;const qty=Math.max(0,targetQty-coverage),unitCost=purchaseLastUnitCost(p.id),estimatedCost=qty*unitCost;return qty>0?{productId:p.id,product:p,qty,demand,daily,sampleDays:velocity.days,available,inbound,days,unitCost,estimatedCost}:null}"
if old not in s:
    raise SystemExit('purchaseRecommendation target not found')
s = s.replace(old, new, 1)

old = "Свободно ${x.available} · заказано/ждёт продажи ${x.inbound} · продажи ${x.daily.toFixed(1)}/день · запас ${x.days.toFixed(1)} дн.${estimate}"
new = "Свободно ${x.available} · заказано/ждёт продажи ${x.inbound} · продажи ${x.daily.toFixed(1)}/день за ${x.sampleDays||25} дн. · запас ${x.days.toFixed(1)} дн.${estimate}"
if old not in s:
    raise SystemExit('purchase plan text target not found')
s = s.replace(old, new, 1)

pattern = re.compile(r"function productCard\(p,profit=productAllTimeProfitStats\(p\),d=productAverageDailySales\(p,25\),stock=productAvailableStock\(p\)\)\{const kind=")
m = pattern.search(s)
if not m:
    raise SystemExit('productCard start target not found')
s = s[:m.start()] + "function productCard(p,profit=productAllTimeProfitStats(p),d=productAverageDailySales(p,25),stock=productAvailableStock(p)){const adaptive=productAdaptiveSalesVelocity(p,25);d=adaptive.daily;const kind=" + s[m.end():]

old = "Продажи/день за 25 дней: ${d.toFixed(1)} · Запас: ${d?(forSale/d).toFixed(1):'∞'} дн."
new = "Продажи/день за ${adaptive.days} дн.: ${d.toFixed(1)} · Запас: ${d?(forSale/d).toFixed(1):'∞'} дн."
if old not in s:
    raise SystemExit('product card label target not found')
s = s.replace(old, new, 1)

p.write_text(s, encoding='utf-8')
print('adaptive purchase velocity patch applied')
