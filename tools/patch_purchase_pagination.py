from pathlib import Path
import re

p = Path('index.html')
s = p.read_text(encoding='utf-8')

old_input = 'id="purchaseSearch" autocomplete="off" placeholder="Поиск поставки по трек-коду" oninput="renderPurchases()"'
new_input = 'id="purchaseSearch" autocomplete="off" placeholder="Поиск поставки по трек-коду" oninput="purchaseSearchChanged()"'
if s.count(old_input) != 1:
    raise SystemExit(f'purchase search anchor count={s.count(old_input)}')
s = s.replace(old_input, new_input, 1)

anchor = 'function purchaseShipmentGroups(){'
insert = """let purchasePage=1;
const PURCHASE_PAGE_SIZE=15;
function purchaseSearchChanged(){purchasePage=1;renderPurchases()}
function setPurchasePage(page){purchasePage=Math.max(1,Number(page)||1);renderPurchases();const section=document.getElementById('purchases');if(section)window.scrollTo({top:Math.max(0,section.offsetTop-8),behavior:'smooth'})}
function purchaseShipmentGroups(){"""
if s.count(anchor) != 1:
    raise SystemExit(f'purchase groups anchor count={s.count(anchor)}')
s = s.replace(anchor, insert, 1)

new_render = r'''function renderPurchases(){
  const allGroups=purchaseShipmentGroups(),q=normalizeName(document.getElementById('purchaseSearch')?.value||''),groups=q?allGroups.filter(g=>normalizeName([g.batch,g.key].filter(Boolean).join(' ')).includes(q)):allGroups,toForwarder=allGroups.filter(g=>g.status==='to_forwarder'),toMe=allGroups.filter(g=>g.status==='to_me'),received=allGroups.filter(g=>g.status==='received'),sumQty=a=>a.reduce((n,g)=>n+purchaseShipmentTotals(g).qty,0),inTransit=[...toForwarder,...toMe],inTransitValue=inTransit.reduce((n,g)=>{const t=purchaseShipmentTotals(g);return n+t.buy+t.delivery},0),since=reportPeriodStart(30),received30=received.filter(g=>Number(g.receivedAt)>=since);
  const set=(id,v)=>{const e=document.getElementById(id);if(e)e.textContent=v};
  set('pToForwarder',sumQty(toForwarder).toLocaleString('ru-RU')+' шт.');set('pToMe',sumQty(toMe).toLocaleString('ru-RU')+' шт.');set('pInTransitValue',fmt(inTransitValue));set('pReceived30',sumQty(received30).toLocaleString('ru-RU')+' шт.');
  const list=document.getElementById('purchaseList');if(!list)return;
  if(!allGroups.length){list.innerHTML='<div class="empty">Закупок пока нет</div>';return}
  if(!groups.length){purchasePage=1;list.innerHTML='<div class="empty">Поставки по этому трек-коду не найдены</div>';return}
  const totalPages=Math.max(1,Math.ceil(groups.length/PURCHASE_PAGE_SIZE));
  purchasePage=Math.min(Math.max(1,purchasePage),totalPages);
  const pageGroups=groups.slice((purchasePage-1)*PURCHASE_PAGE_SIZE,purchasePage*PURCHASE_PAGE_SIZE);
  const cards=pageGroups.map(g=>{const t=purchaseShipmentTotals(g),status=g.status,label=status==='to_forwarder'?'К доставщику':status==='to_me'?'Едет ко мне':'Получено',badge=status==='to_me'?'purple':status==='received'?'':'',date=status==='received'?g.receivedAt:status==='to_me'?g.forwarderReceivedAt:g.orderedAt,dateLabel=status==='received'?'Получено':status==='to_me'?'У доставщика с':'Заказано',lines=g.rows.map(x=>{const qty=Number(x.qty)||0,buy=Number(x.buyTotal)||((Number(x.unitCost)||0)*qty),unitBuy=qty?buy/qty:0;return `<div class="purchase-line"><div class="grow"><b>${esc(productNameById(x.productId,'—'))}</b><div class="muted">${qty} шт. · закуп ${fmt(unitBuy)}/шт.</div></div>${status==='received'?`<div class="right"><div class="muted">себестоимость</div><b>${fmt(x.landedUnitCost)}/шт.</b></div>`:''}</div>`}).join(''),key=encodeURIComponent(g.key);return `<div class="item purchase-card ${status==='to_me'?'to-me':status==='received'?'received':'to-forwarder'}" role="button" tabindex="0" onclick="openPurchaseShipment('${key}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openPurchaseShipment('${key}')}"><div class="order-head"><div class="grow"><div class="name">${esc(g.batch||'Поставка')}</div><div class="muted">${dateLabel}: ${date?new Date(date).toLocaleDateString('ru-RU'):'—'} · ${g.rows.length} поз. · ${t.qty} шт.</div></div><span class="badge ${badge}">${label}</span></div><div class="muted" style="margin-top:7px">Закупка: ${fmt(t.buy)} · доставка: ${fmt(t.delivery)} · всего: ${fmt(t.buy+t.delivery)}</div><div class="purchase-lines">${lines}</div></div>`}).join('');
  const pager=totalPages>1?`<div class="item" style="padding:10px"><div class="row" style="justify-content:space-between"><button class="btn" ${purchasePage<=1?'disabled':''} onclick="setPurchasePage(${purchasePage-1})">← Назад</button><div class="muted" style="text-align:center">Страница ${purchasePage} из ${totalPages}<br>${groups.length} поставок</div><button class="btn" ${purchasePage>=totalPages?'disabled':''} onclick="setPurchasePage(${purchasePage+1})">Вперёд →</button></div></div>`:'';
  list.innerHTML=cards+pager;
}'''

pattern = r'function renderPurchases\(\)\{.*?\}\nlet xlsxLoadPromise=null;'
m = re.search(pattern, s, flags=re.S)
if not m:
    raise SystemExit('renderPurchases block not found')
s = s[:m.start()] + new_render + '\nlet xlsxLoadPromise=null;' + s[m.end():]

p.write_text(s, encoding='utf-8')
print('Purchase pagination patch applied')
