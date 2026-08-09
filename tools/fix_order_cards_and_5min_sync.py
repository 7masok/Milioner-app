from pathlib import Path
import re

root = Path(__file__).resolve().parents[1]
html_path = root / 'index.html'
api_path = root / 'cloudflare/millioner-api/src/index.js'
wrangler_path = root / 'cloudflare/millioner-api/wrangler.jsonc'

html = html_path.read_text(encoding='utf-8')
api = api_path.read_text(encoding='utf-8')
wrangler = wrangler_path.read_text(encoding='utf-8')

# The UI stores line-level marketplace rows, but an order must be rendered once.
# Keep all real product lines inside one card and suppress a stale __pending__
# placeholder as soon as at least one real line for that order exists.
new_render = r'''function isPendingMarketplaceLine(o){return String(o?.entryId||'')==='__pending__'||(!(Number(o?.qty)>0)&&!String(o?.sku||'').trim()&&/состав загружается/i.test(String(o?.productName||'')))}
function marketplaceOrderKey(o){return String(o?.orderId||o?.code||'').trim()||String(o?.code||'').trim()}
function groupMarketplaceOrders(feed){const groups=new Map();for(const row of(feed||[])){const key=marketplaceOrderKey(row);if(!key)continue;let g=groups.get(key);if(!g){g={key,orderId:row.orderId,code:row.code,creationDate:Number(row.creationDate)||0,status:row.status,state:row.state,lines:[]};groups.set(key,g)}if((Number(row.creationDate)||0)>=g.creationDate){g.creationDate=Number(row.creationDate)||g.creationDate;g.status=row.status||g.status;g.state=row.state||g.state;g.code=row.code||g.code}g.lines.push(row)}for(const g of groups.values()){const real=g.lines.filter(x=>!isPendingMarketplaceLine(x));if(real.length)g.lines=real}return [...groups.values()].sort((a,b)=>(Number(b.creationDate)||0)-(Number(a.creationDate)||0))}
function renderMarketplaceOrders(){const list=document.getElementById('kaspiOrderList');if(!list)return;const market=selectedOrderMarket;const feed=market==='Kaspi'?state.kaspiOrderFeed:market==='WB'?state.wbOrderFeed:state.ozonOrderFeed;const orders=groupMarketplaceOrders(feed);const total=orders.length,matched=orders.filter(g=>g.lines.length&&g.lines.every(x=>x.productId||isPendingMarketplaceLine(x))).length,unmatched=total-matched;const eTotal=document.getElementById('koTotal'),eMatched=document.getElementById('koMatched'),eUnmatched=document.getElementById('koUnmatched');if(eTotal)eTotal.textContent=total;if(eMatched)eMatched.textContent=matched;if(eUnmatched)eUnmatched.textContent=unmatched;if(!orders.length){if(market==='Kaspi')list.innerHTML='<div class="empty">Нажмите ↻ сверху, чтобы загрузить заказы Kaspi</div>';else if(market==='WB')list.innerHTML='<div class="empty">Заказы WB ещё не загружены.<button class="btn dark full" onclick="syncWbNow()">Получить заказы WB</button></div>';else list.innerHTML='<div class="empty">Ozon пока не подключён. После подключения здесь будут его заказы.</div>';return}list.innerHTML=orders.slice(0,100).map(g=>{const statusUpper=String(g.status||'').toUpperCase();const statusClass=['CANCELLED','CANCELLING','CANCEL'].includes(statusUpper)?'bad':['COMPLETED','COMPLETE'].includes(statusUpper)?'ok':'warn';const lines=g.lines.map(o=>{const pending=isPendingMarketplaceLine(o),p=o.productId?prod(o.productId):null,totalPrice=Number(o.totalPrice||0),feedKey=encodeURIComponent(String(o.orderId)+':'+String(o.entryId));const linkControl=p?`<button type="button" class="badge ok link-btn" onclick="openProduct('${p.id}')">Привязано</button>`:pending?'':`<button type="button" class="badge bad link-btn" onclick="${market==='Kaspi'?`openKaspiLink('${feedKey}')`:market==='WB'?`openWbLink('${feedKey}')`:`openMarketplaceLink('${market}','${esc(o.sku||'')}','${esc(o.code||o.orderId||'')}','${feedKey}')`}">Нужно привязать</button>`;return `<div class="order-line" style="margin-top:9px"><div class="grow"><b>${esc(p?.name||o.productName||(pending?'Состав загружается':'Товар не привязан'))}</b><div class="order-sku">${market} артикул: ${esc(o.sku||'—')}</div>${linkControl?`<div class="order-meta">${linkControl}</div>`:''}</div><div class="right"><b>${pending?'—':((o.qty||0)+' шт.')}</b>${totalPrice?`<div class="muted">${fmt(totalPrice)}</div>`:''}</div></div>`}).join('');return `<div class="item"><div class="order-head"><div class="grow"><div class="name">Заказ ${esc(g.code||g.orderId||'—')}</div><div class="muted">${g.creationDate?new Date(g.creationDate).toLocaleString('ru-RU'):'Дата неизвестна'}</div></div><span class="badge ${statusClass}">${esc(marketplaceStatusLabel(market,g.status,g.state))}</span></div>${lines}<div class="order-meta"><span class="badge">${esc(marketplaceStateLabel(market,g.state))}</span></div></div>`}).join('')}'''

render_pattern = re.compile(r"function renderMarketplaceOrders\(\)\{.*?\}\nfunction renderKaspiOrders", re.S)
if not render_pattern.search(html):
    raise SystemExit('renderMarketplaceOrders marker not found')
html = render_pattern.sub(new_render + '\nfunction renderKaspiOrders', html, count=1)

old_merge_pattern = re.compile(r"function mergeOrderFeeds\(local,remote\)\{.*?\}\nfunction applyMarketplaceTransitions", re.S)
if not old_merge_pattern.search(html):
    raise SystemExit('mergeOrderFeeds marker not found')
new_merge = r'''function mergeOrderFeeds(local,remote){const map=new Map();for(const o of(local||[]))map.set(String(o.orderId)+':'+String(o.entryId),o);for(const o of(remote||[])){const key=String(o.orderId)+':'+String(o.entryId),prev=map.get(key)||{};map.set(key,{...prev,...o,productId:o.productId||prev.productId||null})}const rows=[...map.values()];const realOrders=new Set(rows.filter(o=>!isPendingMarketplaceLine(o)).map(marketplaceOrderKey));return rows.filter(o=>!isPendingMarketplaceLine(o)||!realOrders.has(marketplaceOrderKey(o))).sort((a,b)=>(Number(b.creationDate)||0)-(Number(a.creationDate)||0)).slice(0,500)}'''
html = old_merge_pattern.sub(new_merge + '\nfunction applyMarketplaceTransitions', html, count=1)

# Browser refresh follows the same five-minute cadence; it only reads D1.
html = html.replace("setInterval(()=>loadSharedOrderCache({silent:true}),180000);", "setInterval(()=>loadSharedOrderCache({silent:true}),300000);")
html = html.replace("const count=(state.kaspiOrderFeed||[]).length,s=marketServerStatus('Kaspi');", "const count=groupMarketplaceOrders(state.kaspiOrderFeed||[]).length,s=marketServerStatus('Kaspi');")
html = html.replace("Строк заказов: '+count", "Заказов: '+count")
html = html.replace("Показана последняя доступная копия: '+count+' строк.", "Показана последняя доступная копия: '+count+' заказов.")
html = html.replace("Показана последняя серверная копия. Строк: '+count", "Показана последняя серверная копия. Заказов: '+count")

# Cron and Kaspi status cadence become five minutes. WB keeps its separate
# 10-minute seller-wide API gate to avoid unnecessary/rate-limited calls.
if "const KASPI_SCHEDULE_MS = 10 * 60 * 1000;" not in api:
    raise SystemExit('KASPI_SCHEDULE_MS marker not found')
api = api.replace("const KASPI_SCHEDULE_MS = 10 * 60 * 1000;", "const KASPI_SCHEDULE_MS = 5 * 60 * 1000;", 1)
if '"crons": ["*/10 * * * *"]' not in wrangler:
    raise SystemExit('10-minute cron marker not found')
wrangler = wrangler.replace('"crons": ["*/10 * * * *"]', '"crons": ["*/5 * * * *"]', 1)

# Guard against partial/unsafe transformations.
required = [
    'function groupMarketplaceOrders(feed)',
    "String(o?.entryId||'')==='__pending__'",
    'realOrders=new Set',
    'setInterval(()=>loadSharedOrderCache({silent:true}),300000)',
]
missing = [x for x in required if x not in html]
if missing:
    raise SystemExit('Missing generated markers: ' + ', '.join(missing))
if 'const KASPI_SCHEDULE_MS = 5 * 60 * 1000;' not in api or '"crons": ["*/5 * * * *"]' not in wrangler:
    raise SystemExit('Five-minute server sync was not applied')

html_path.write_text(html, encoding='utf-8')
api_path.write_text(api, encoding='utf-8')
wrangler_path.write_text(wrangler, encoding='utf-8')
print('Applied grouped marketplace cards and 5-minute Kaspi sync')
