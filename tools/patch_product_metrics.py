from pathlib import Path
import re

p=Path('index.html')
s=p.read_text(encoding='utf-8')

anchor="function productDisplayCost(p){if(!isBundleProduct(p))return Number(p?.cost)||0;return bundleComponents(p).reduce((sum,part)=>sum+(Number(prod(part.productId)?.cost)||0)*part.qty,0)}"
if s.count(anchor)!=1:
    raise SystemExit('productDisplayCost anchor mismatch')
helpers=anchor+"\n"+r'''function productLifetimeAverageCost(p){if(!p)return 0;if(isBundleProduct(p))return bundleComponents(p).reduce((sum,part)=>sum+productLifetimeAverageCost(prod(part.productId))*part.qty,0);let qty=0,value=0;for(const x of(state.purchases||[])){if(x.productId!==p.id||purchaseStatus(x)!=='received')continue;const q=Math.max(0,Number(x.qty)||0);if(!q)continue;let unit=Number(x.landedUnitCost);if(!Number.isFinite(unit)||unit<0)unit=(Math.max(0,Number(x.unitCost)||0)+Math.max(0,Number(x.delivery)||0)/q);qty+=q;value+=q*unit}return qty>0?value/qty:Math.max(0,Number(p.cost)||0)}
function productAverageDailySales(p,days='all'){if(!p)return 0;const rows=financialSales().filter(x=>x.productId===p.id&&Number(x.date)>0);if(!rows.length)return 0;if(days==='all'){const first=Math.min(...rows.map(x=>Number(x.date)||Date.now())),start=new Date(first),today=new Date();start.setHours(0,0,0,0);today.setHours(0,0,0,0);const span=Math.max(1,Math.floor((today.getTime()-start.getTime())/86400000)+1),qty=rows.reduce((a,x)=>a+(Number(x.qty)||0),0);return qty/span}const n=Math.max(1,Number(days)||1),since=reportPeriodStart(n),until=reportPeriodEnd(n),qty=rows.filter(x=>Number(x.date)>=since&&Number(x.date)<until).reduce((a,x)=>a+(Number(x.qty)||0),0);return qty/n}'''
s=s.replace(anchor,helpers,1)

old_card="function productCard(p){let d=salesDays(p),profit=profitForProduct(p),stock=productDisplayStock(p),cost=productDisplayCost(p),kind=isBundleProduct(p)?'Набор · ':'';"
new_card="function productCard(p){let d=salesDays(p),profit=profitForProduct(p),stock=productDisplayStock(p),cost=productLifetimeAverageCost(p),kind=isBundleProduct(p)?'Набор · ':'';"
if s.count(old_card)!=1:
    raise SystemExit('productCard anchor mismatch')
s=s.replace(old_card,new_card,1)

old_open="function openProduct(pid,market='',days=30){let p=prod(pid);if(!p)return;const displayStock=productDisplayStock(p),displayCost=productDisplayCost(p),bundleBlock="
new_open="function openProduct(pid,market='',days=30){let p=prod(pid);if(!p)return;const displayStock=productDisplayStock(p),displayCost=productLifetimeAverageCost(p),daily7=productAverageDailySales(p,7),dailyAll=productAverageDailySales(p,'all'),bundleBlock="
if s.count(old_open)!=1:
    raise SystemExit('openProduct start anchor mismatch')
s=s.replace(old_open,new_open,1)

old_delivery="profitLabel=market?`Прибыль ${esc(market)} за ${periodText}`:'Прибыль за '+periodText,deliveryDays=market==='Kaspi'?periodDays:30,deliveryText=deliveryDays===-1?'вчера':deliveryDays===1?'сегодня':deliveryDays+' дней',kaspiDelivery=productKaspiDelivery(p,deliveryDays),deliveryLabel=`Расход на доставку Kaspi за ${deliveryText}`,adRow="
new_delivery="profitLabel=market?`Прибыль ${esc(market)} за ${periodText}`:'Прибыль за '+periodText,adRow="
if s.count(old_delivery)!=1:
    raise SystemExit('Kaspi delivery calculation anchor mismatch')
s=s.replace(old_delivery,new_delivery,1)

old_html='<div style="margin-top:12px"><div class="muted">Себестоимость 1 шт.</div><b>${fmt(displayCost)}</b></div><div style="margin-top:8px"><div class="muted">${deliveryLabel}</div><b>${fmt(kaspiDelivery)}</b></div>${adRow}'
new_html='<div style="margin-top:12px"><div class="muted">Средняя себестоимость ${isBundleProduct(p)?\'1 набора\':\'1 шт.\'} · все поставки</div><b>${fmt(displayCost)}</b></div><div style="margin-top:8px"><div class="muted">Среднесуточные продажи · 7 дней</div><b>${daily7.toFixed(1)} ${isBundleProduct(p)?\'набор.\':\'шт.\'}/день</b></div><div style="margin-top:8px"><div class="muted">Среднесуточные продажи · всё время</div><b>${dailyAll.toFixed(1)} ${isBundleProduct(p)?\'набор.\':\'шт.\'}/день</b></div>${adRow}'
if s.count(old_html)!=1:
    raise SystemExit('product detail metric HTML anchor mismatch')
s=s.replace(old_html,new_html,1)

p.write_text(s,encoding='utf-8')
print('Product metrics patch applied')
