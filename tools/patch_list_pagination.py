from pathlib import Path
import re

p=Path('index.html')
s=p.read_text(encoding='utf-8')

# Movement controls + pager target
for old,new in [
('id="moveType" class="select" onchange="renderMovement()"','id="moveType" class="select" onchange="movementFilterChanged()"'),
('id="moveQ" class="search" placeholder="Товар" oninput="renderMovement()"','id="moveQ" class="search" placeholder="Товар" oninput="movementFilterChanged()"'),
('<div id="movementList"></div></section>','<div id="movementList"></div><div id="movementPager"></div></section>'),
('<div id="kaspiOrderList" class="order-list"></div><div id="attention" hidden></div>','<div id="kaspiOrderList" class="order-list"></div><div id="orderPager"></div><div id="attention" hidden></div>')]:
    if s.count(old)!=1: raise SystemExit('HTML anchor mismatch: '+old[:40])
    s=s.replace(old,new,1)

movement=r'''let movementPage=1;
const MOVEMENT_PAGE_SIZE=15;
function movementFilterChanged(){movementPage=1;renderMovement()}
function setMovementPage(page){movementPage=Math.max(1,Number(page)||1);renderMovement();const section=document.getElementById('movement');if(section)window.scrollTo({top:Math.max(0,section.offsetTop-8),behavior:'smooth'})}
function renderMovement(){let t=document.getElementById('moveType')?.value||'all',q=(document.getElementById('moveQ')?.value||'').toLowerCase();let a=state.movements.filter(m=>(t==='all'||m.type===t)&&((prod(m.productId)?.name||'').toLowerCase().includes(q)));const list=document.getElementById('movementList'),pager=document.getElementById('movementPager');if(!list)return;if(!a.length){movementPage=1;list.innerHTML='<div class="empty">Нет операций</div>';if(pager)pager.innerHTML='';return}const totalPages=Math.max(1,Math.ceil(a.length/MOVEMENT_PAGE_SIZE));movementPage=Math.min(Math.max(1,movementPage),totalPages);const rows=a.slice((movementPage-1)*MOVEMENT_PAGE_SIZE,movementPage*MOVEMENT_PAGE_SIZE);list.innerHTML='<table><tr><th>Дата</th><th>Операция</th><th>Товар</th><th>Кол.</th></tr>'+rows.map(m=>`<tr><td>${new Date(m.date).toLocaleDateString('ru-RU')}</td><td>${esc(m.type)}</td><td>${esc(productNameById(m.productId,'—'))}</td><td>${m.qty}</td></tr>`).join('')+'</table>';if(pager)pager.innerHTML=totalPages>1?`<div class="item" style="padding:10px;margin-top:8px"><div class="row" style="justify-content:space-between"><button class="btn" ${movementPage<=1?'disabled':''} onclick="setMovementPage(${movementPage-1})">← Назад</button><div class="muted" style="text-align:center">Страница ${movementPage} из ${totalPages}<br>${a.length} операций</div><button class="btn" ${movementPage>=totalPages?'disabled':''} onclick="setMovementPage(${movementPage+1})">Вперёд →</button></div></div>`:''}
let purchasePage=1;'''
pat=r'function renderMovement\(\)\{.*?\}\nlet purchasePage=1;'
if len(re.findall(pat,s,flags=re.S))!=1: raise SystemExit('renderMovement anchor mismatch')
s=re.sub(pat,movement,s,count=1,flags=re.S)

order_helpers=r'''let orderPage=1;
const ORDER_PAGE_SIZE=15;
function setOrderPage(page){orderPage=Math.max(1,Number(page)||1);renderMarketplaceOrders();const list=document.getElementById('kaspiOrderList');if(list)window.scrollTo({top:Math.max(0,list.offsetTop-16),behavior:'smooth'})}
function renderOrderPager(totalItems){const box=document.getElementById('orderPager');if(!box)return;const totalPages=Math.max(1,Math.ceil((Number(totalItems)||0)/ORDER_PAGE_SIZE));if(totalPages<=1){box.innerHTML='';return}box.innerHTML=`<div class="item" style="padding:10px;margin-top:8px"><div class="row" style="justify-content:space-between"><button class="btn" ${orderPage<=1?'disabled':''} onclick="setOrderPage(${orderPage-1})">← Назад</button><div class="muted" style="text-align:center">Страница ${orderPage} из ${totalPages}<br>${totalItems} заказов</div><button class="btn" ${orderPage>=totalPages?'disabled':''} onclick="setOrderPage(${orderPage+1})">Вперёд →</button></div></div>`}
function renderMarketplaceOrders(){'''
if s.count('function renderMarketplaceOrders(){')!=1: raise SystemExit('renderMarketplaceOrders anchor mismatch')
s=s.replace('function renderMarketplaceOrders(){',order_helpers,1)
anchor="function renderMarketplaceOrders(){const list=document.getElementById('kaspiOrderList');"
if anchor not in s: raise SystemExit('order list start anchor missing')
s=s.replace(anchor,"function renderMarketplaceOrders(){renderOrderPager(0);const list=document.getElementById('kaspiOrderList');",1)
if 'visibleOrders.slice(0,100)' not in s: raise SystemExit('order slice anchor missing')
s=s.replace('visibleOrders.slice(0,100)','pageOrders',1)
needle="if(!visibleOrders.length){list.innerHTML='<div class=\"empty\">Все заказы привязаны. Нажмите «Не привязано» ещё раз, чтобы показать все заказы.</div>';return}list.innerHTML=pageOrders.map"
if needle not in s: raise SystemExit('visible order anchor missing')
repl="if(!visibleOrders.length){list.innerHTML='<div class=\"empty\">Все заказы привязаны. Нажмите «Не привязано» ещё раз, чтобы показать все заказы.</div>';return}const totalPages=Math.max(1,Math.ceil(visibleOrders.length/ORDER_PAGE_SIZE));orderPage=Math.min(Math.max(1,orderPage),totalPages);const pageOrders=visibleOrders.slice((orderPage-1)*ORDER_PAGE_SIZE,orderPage*ORDER_PAGE_SIZE);list.innerHTML=pageOrders.map"
s=s.replace(needle,repl,1)
end="}).join('')}\nfunction renderKaspiOrders(){renderMarketplaceOrders()}"
if end not in s: raise SystemExit('order function end anchor missing')
s=s.replace(end,"}).join('');renderOrderPager(visibleOrders.length)}\nfunction renderKaspiOrders(){renderMarketplaceOrders()}",1)

replacements={
"function setOrderPeriod(mode){if(!['today','yesterday','week','month','custom'].includes(mode))return;":"function setOrderPeriod(mode){if(!['today','yesterday','week','month','custom'].includes(mode))return;orderPage=1;",
"function setOrderCustomDate(which,value){if(!value)return;":"function setOrderCustomDate(which,value){if(!value)return;orderPage=1;",
"function selectOrderMarket(market){selectedOrderMarket=market;":"function selectOrderMarket(market){orderPage=1;selectedOrderMarket=market;",
"function selectWbAccount(account){selectedWbAccount=account;":"function selectWbAccount(account){orderPage=1;selectedWbAccount=account;",
"function toggleUnmatchedOrderFilter(){unmatchedOrderFilter=!unmatchedOrderFilter;":"function toggleUnmatchedOrderFilter(){orderPage=1;unmatchedOrderFilter=!unmatchedOrderFilter;"
}
for old,new in replacements.items():
    if old not in s: raise SystemExit('missing reset anchor: '+old[:35])
    s=s.replace(old,new,1)

p.write_text(s,encoding='utf-8')
print('Order and movement pagination patch applied')
