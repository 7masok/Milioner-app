from pathlib import Path
import re

root = Path(__file__).resolve().parents[1]
path = root / 'index.html'
html = path.read_text(encoding='utf-8')

pattern = re.compile(r"function renderProducts\(\)\{.*?\}\nfunction productCard\(p,profit=productAllTimeProfitStats\(p\)\)\{.*?\}\nlet movementPage=1;", re.S)
if not pattern.search(html):
    raise SystemExit('renderProducts/productCard marker not found')

replacement = r'''function buildProductRenderStats(){
  const products=state.products||[],sales=financialSales(),profitStats=new Map(),daily25=new Map(),stockMap=new Map(),since=reportPeriodStart(25),until=reportPeriodEnd(25);
  for(const p of products){profitStats.set(String(p.id),{qty:0,revenue:0,cost:0,fees:0,ads:0,profit:0,unitProfit:0});stockMap.set(String(p.id),productDisplayStock(p))}
  for(const s of sales){const key=String(s.productId||''),x=profitStats.get(key);if(!x)continue;const qty=Math.max(0,Number(s.qty)||0),price=Math.max(0,Number(s.price)||0),cost=Math.max(0,Number(s.cost)||0),fee=Math.max(0,Number(s.fee)||0);x.qty+=qty;x.revenue+=qty*price;x.cost+=qty*cost;x.fees+=qty*fee;const ts=Number(s.date)||0;if(ts>=since&&ts<until)daily25.set(key,(daily25.get(key)||0)+qty)}
  const ads=kaspiAdsBreakdown('all');
  for(const [key,x] of profitStats){x.ads=Math.max(0,Number(ads.byProduct.get(key))||0);x.profit=x.revenue-x.cost-x.fees-x.ads;x.unitProfit=x.qty?x.profit/x.qty:0;daily25.set(key,(daily25.get(key)||0)/25)}
  return {profitStats,daily25,stockMap}
}
function renderProducts(){const stats=buildProductRenderStats(),profitStats=stats.profitStats,daily25=stats.daily25,stockMap=stats.stockMap,stockQty=document.getElementById('productStockQty'),stockCost=document.getElementById('productStockCost'),stockProfit=document.getElementById('productStockProfit');if(stockQty)stockQty.textContent=stockTotal().toLocaleString('ru-RU')+' шт.';if(stockCost)stockCost.textContent=fmt(warehouseInventoryCost());if(stockProfit)stockProfit.textContent=fmt(warehouseProjectedProfit(profitStats));const sortEl=document.getElementById('sort'),sort=normalizeProductSort(state.settings.productSort);if(sortEl&&sortEl.value!==sort)sortEl.value=sort;let q=(document.getElementById('q')?.value||'').toLowerCase(),f=document.getElementById('filter')?.value||'all';let a=state.products.filter(p=>[p.name,p.kaspi,p.wb,p.wb2,p.ozon].join(' ').toLowerCase().includes(q));a=a.filter(p=>{const stock=stockMap.get(String(p.id))||0;return f==='all'||f==='low'&&stock<=p.min&&stock>0||f==='zero'&&stock<=0||f==='buy'&&!!purchaseRecommendation(p)});a.sort((x,y)=>{const xk=String(x.id),yk=String(y.id),xs=stockMap.get(xk)||0,ys=stockMap.get(yk)||0,xd=daily25.get(xk)||0,yd=daily25.get(yk)||0;return sort==='name'?x.name.localeCompare(y.name):sort==='stock'?ys-xs:sort==='sales'?yd-xd:sort==='profit'?(profitStats.get(yk)?.unitProfit||0)-(profitStats.get(xk)?.unitProfit||0):(xd?xs/xd:Infinity)-(yd?ys/yd:Infinity)});const list=document.getElementById('productList'),pager=document.getElementById('productPager');if(!list)return;if(!a.length){productPage=1;list.innerHTML='<div class="empty">Товаров не найдено</div>';if(pager)pager.innerHTML='';return}const totalPages=Math.max(1,Math.ceil(a.length/PRODUCT_PAGE_SIZE));productPage=Math.min(Math.max(1,productPage),totalPages);const pageProducts=a.slice((productPage-1)*PRODUCT_PAGE_SIZE,productPage*PRODUCT_PAGE_SIZE);list.innerHTML=pageProducts.map(p=>productCard(p,profitStats.get(String(p.id)),daily25.get(String(p.id))||0,stockMap.get(String(p.id))||0)).join('');if(pager)pager.innerHTML=totalPages>1?`<div class="item" style="padding:10px;margin-top:8px"><div class="row" style="justify-content:space-between"><button class="btn" ${productPage<=1?'disabled':''} onclick="setProductPage(${productPage-1})">← Назад</button><div class="muted" style="text-align:center">Страница ${productPage} из ${totalPages}<br>${a.length} товаров</div><button class="btn" ${productPage>=totalPages?'disabled':''} onclick="setProductPage(${productPage+1})">Вперёд →</button></div></div>`:''}
function productCard(p,profit=productAllTimeProfitStats(p),d=productAverageDailySales(p,25),stock=productDisplayStock(p)){const kind=isBundleProduct(p)?'Набор · ':'';return `<div class="item row" onclick="openProduct('${p.id}')">${p.photo?`<img class="thumb" src="${p.photo}" loading="lazy" decoding="async">`:'<div class="thumb">Фото</div>'}<div class="grow"><div class="name">${esc(p.name)}</div><div class="muted">${kind}${esc(p.category||'Без категории')}</div><div class="muted">Продажи/день за 25 дней: ${d.toFixed(1)} · Запас: ${d?(stock/d).toFixed(1):'∞'} дн.</div><div class="muted">Средняя прибыль/шт. за всё время: ${fmt(profit.unitProfit)}</div></div><div class="right"><b>${stock}</b><div class="muted">${isBundleProduct(p)?'набор.':'шт.'}</div></div></div>`}
let movementPage=1;'''

html = pattern.sub(replacement, html, count=1)
required = ['function buildProductRenderStats()', "const ads=kaspiAdsBreakdown('all');", 'loading="lazy" decoding="async"']
missing = [x for x in required if x not in html]
if missing:
    raise SystemExit('Missing optimization markers: '+', '.join(missing))
path.write_text(html, encoding='utf-8')
print('Optimized products rendering')
