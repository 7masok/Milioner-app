from pathlib import Path

p=Path('index.html')
s=p.read_text(encoding='utf-8')

old_css=".purchase-metrics{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px}.purchase-metrics .card{padding:12px}.purchase-metrics .num{font-size:18px}.purchase-card{cursor:pointer}"
new_css=".purchase-metrics{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px}.purchase-metrics .card{padding:12px}.purchase-metrics .num{font-size:18px}.purchase-filter-card{width:100%;appearance:none;text-align:left;color:inherit;font:inherit;cursor:pointer}.purchase-filter-card.active{border-color:#111;box-shadow:0 0 0 1px #111 inset;background:#f1f2f3}.purchase-filter-reset{display:none;margin-top:-4px;margin-bottom:12px}.purchase-filter-reset.show{display:block}.purchase-card{cursor:pointer}"
if s.count(old_css)!=1: raise SystemExit(f'CSS anchor count={s.count(old_css)}')
s=s.replace(old_css,new_css,1)

old_html='<section id="purchases" class="view"><h2>Закупки</h2><div class="purchase-metrics"><div class="card"><div class="label">К доставщику</div><div class="num" id="pToForwarder">0 шт.</div></div><div class="card"><div class="label">Едет ко мне</div><div class="num" id="pToMe">0 шт.</div></div><div class="card"><div class="label">В пути, вложено</div><div class="num" id="pInTransitValue">0 ₸</div></div><div class="card"><div class="label">Получено за 30 дней</div><div class="num" id="pReceived30">0 шт.</div></div></div><button class="btn dark full" onclick="openModal(\'purchase\')">+ Новая закупка</button>'
new_html='<section id="purchases" class="view"><h2>Закупки</h2><div class="purchase-metrics"><button id="purchaseFilterToForwarder" type="button" class="card purchase-filter-card" onclick="setPurchaseStatusFilter(\'to_forwarder\')"><div class="label">К доставщику</div><div class="num" id="pToForwarder">0 шт.</div></button><button id="purchaseFilterToMe" type="button" class="card purchase-filter-card" onclick="setPurchaseStatusFilter(\'to_me\')"><div class="label">Едет ко мне</div><div class="num" id="pToMe">0 шт.</div></button><div class="card"><div class="label">В пути, вложено</div><div class="num" id="pInTransitValue">0 ₸</div></div><div class="card"><div class="label">Получено за 30 дней</div><div class="num" id="pReceived30">0 шт.</div></div></div><button id="purchaseFilterReset" type="button" class="btn full purchase-filter-reset" onclick="setPurchaseStatusFilter(\'all\')">Показать все поставки</button><button class="btn dark full" onclick="openModal(\'purchase\')">+ Новая закупка</button>'
if s.count(old_html)!=1: raise SystemExit(f'HTML anchor count={s.count(old_html)}')
s=s.replace(old_html,new_html,1)

old_helpers="let purchasePage=1;\nconst PURCHASE_PAGE_SIZE=15;\nfunction purchaseSearchChanged(){purchasePage=1;renderPurchases()}\nfunction setPurchasePage(page){purchasePage=Math.max(1,Number(page)||1);renderPurchases();const section=document.getElementById('purchases');if(section)window.scrollTo({top:Math.max(0,section.offsetTop-8),behavior:'smooth'})}"
new_helpers="let purchasePage=1;\nlet purchaseStatusFilter='all';\nconst PURCHASE_PAGE_SIZE=15;\nfunction purchaseSearchChanged(){purchasePage=1;renderPurchases()}\nfunction setPurchaseStatusFilter(status){const next=['to_forwarder','to_me'].includes(String(status))?String(status):'all';purchaseStatusFilter=next==='all'?'all':(purchaseStatusFilter===next?'all':next);purchasePage=1;renderPurchases()}\nfunction setPurchasePage(page){purchasePage=Math.max(1,Number(page)||1);renderPurchases();const section=document.getElementById('purchases');if(section)window.scrollTo({top:Math.max(0,section.offsetTop-8),behavior:'smooth'})}"
if s.count(old_helpers)!=1: raise SystemExit(f'helper anchor count={s.count(old_helpers)}')
s=s.replace(old_helpers,new_helpers,1)

old_line="  const allGroups=purchaseShipmentGroups(),q=normalizeName(document.getElementById('purchaseSearch')?.value||''),groups=q?allGroups.filter(g=>normalizeName([g.batch,g.key].filter(Boolean).join(' ')).includes(q)):allGroups,toForwarder=allGroups.filter(g=>g.status==='to_forwarder'),toMe=allGroups.filter(g=>g.status==='to_me'),received=allGroups.filter(g=>g.status==='received'),sumQty=a=>a.reduce((n,g)=>n+purchaseShipmentTotals(g).qty,0),inTransit=[...toForwarder,...toMe],inTransitValue=inTransit.reduce((n,g)=>{const t=purchaseShipmentTotals(g);return n+t.buy+t.delivery},0),since=reportPeriodStart(30),received30=received.filter(g=>Number(g.receivedAt)>=since);"
new_line="  const allGroups=purchaseShipmentGroups(),q=normalizeName(document.getElementById('purchaseSearch')?.value||''),searched=q?allGroups.filter(g=>normalizeName([g.batch,g.key].filter(Boolean).join(' ')).includes(q)):allGroups,groups=purchaseStatusFilter==='all'?searched:searched.filter(g=>g.status===purchaseStatusFilter),toForwarder=allGroups.filter(g=>g.status==='to_forwarder'),toMe=allGroups.filter(g=>g.status==='to_me'),received=allGroups.filter(g=>g.status==='received'),sumQty=a=>a.reduce((n,g)=>n+purchaseShipmentTotals(g).qty,0),inTransit=[...toForwarder,...toMe],inTransitValue=inTransit.reduce((n,g)=>{const t=purchaseShipmentTotals(g);return n+t.buy+t.delivery},0),since=reportPeriodStart(30),received30=received.filter(g=>Number(g.receivedAt)>=since);"
if s.count(old_line)!=1: raise SystemExit(f'render line anchor count={s.count(old_line)}')
s=s.replace(old_line,new_line,1)

old_metrics="  set('pToForwarder',sumQty(toForwarder).toLocaleString('ru-RU')+' шт.');set('pToMe',sumQty(toMe).toLocaleString('ru-RU')+' шт.');set('pInTransitValue',fmt(inTransitValue));set('pReceived30',sumQty(received30).toLocaleString('ru-RU')+' шт.');\n  const list=document.getElementById('purchaseList');if(!list)return;"
new_metrics="  set('pToForwarder',sumQty(toForwarder).toLocaleString('ru-RU')+' шт.');set('pToMe',sumQty(toMe).toLocaleString('ru-RU')+' шт.');set('pInTransitValue',fmt(inTransitValue));set('pReceived30',sumQty(received30).toLocaleString('ru-RU')+' шт.');\n  const fw=document.getElementById('purchaseFilterToForwarder'),tm=document.getElementById('purchaseFilterToMe'),reset=document.getElementById('purchaseFilterReset');if(fw)fw.classList.toggle('active',purchaseStatusFilter==='to_forwarder');if(tm)tm.classList.toggle('active',purchaseStatusFilter==='to_me');if(reset)reset.classList.toggle('show',purchaseStatusFilter!=='all');\n  const list=document.getElementById('purchaseList');if(!list)return;"
if s.count(old_metrics)!=1: raise SystemExit(f'metrics anchor count={s.count(old_metrics)}')
s=s.replace(old_metrics,new_metrics,1)

old_empty="  if(!groups.length){purchasePage=1;list.innerHTML='<div class=\"empty\">Поставки по этому трек-коду не найдены</div>';return}"
new_empty="  if(!groups.length){purchasePage=1;const msg=purchaseStatusFilter==='to_forwarder'?'Поставок «К доставщику» не найдено':purchaseStatusFilter==='to_me'?'Поставок «Едет ко мне» не найдено':'Поставки по этому трек-коду не найдены';list.innerHTML='<div class=\"empty\">'+msg+'</div>';return}"
if s.count(old_empty)!=1: raise SystemExit(f'empty anchor count={s.count(old_empty)}')
s=s.replace(old_empty,new_empty,1)

p.write_text(s,encoding='utf-8')
print('Purchase status filters patch applied')
