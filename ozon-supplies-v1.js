(()=>{
'use strict';
let cache=null,current=null,linkContext=null,listView='active';
const detailCache=new Map();
const api=path=>apiJson(MILLIONER_API+path);
const transfers=()=>{state.settings=state.settings||{};return state.settings.ozonFboTransfers||(state.settings.ozonFboTransfers={});};
const text=v=>esc(String(v??''));
const storedTransfers=()=>state.settings?.ozonFboTransfers||{};
function productKeys(p){return [...new Set([p?.ozon,...(Array.isArray(p?.ozonAliases)?p.ozonAliases:[])].map(x=>String(x||'').trim()).filter(Boolean))];}
function transferKey(account,order,supply,bundle,sku){return [account,order,supply,bundle,sku].map(x=>String(x||'')).join('|');}
function stockRowFor(account,sku){
 const a=(cache?.accounts||[]).find(x=>String(x.account)===String(account));
 return (a?.stocks?.rows||[]).find(r=>(r.stocks||[]).some(s=>String(s.sku)===String(sku)));
}
function itemIdentifiers(account,item){
 const stock=stockRowFor(account,item.sku),offer=String(item.offer_id||stock?.offer_id||'').trim();
 return [...new Set([offer,String(item.sku||'').trim(),String(stock?.product_id||'').trim()].filter(Boolean))];
}
function matchProduct(account,item){
 const ids=itemIdentifiers(account,item);
 return (state.products||[]).find(p=>productKeys(p).some(k=>ids.includes(k)))||null;
}
function warehouseLabel(s){return s?.storage_warehouse?.name||s?.storage_warehouse?.address||('Склад #'+String(s?.storage_warehouse?.warehouse_id||'—'));}
function stateLabel(v){const key=String(v||'').toUpperCase();return ({IN_TRANSIT:'В пути',ACCEPTED_AT_SUPPLY_WAREHOUSE:'Принято в точке отгрузки',ACCEPTANCE_AT_STORAGE_WAREHOUSE:'На приёмке',REPORTS_CONFIRMATION_AWAITING:'Ожидает подтверждения приёмки',REPORT_REJECTED:'Приёмка на уточнении',COMPLETED:'Доставлено',CANCELLED:'Отменено',REJECTED_AT_SUPPLY_WAREHOUSE:'Отклонено',OVERDUE:'Просрочено',READY_TO_SUPPLY:'Готово к отправке'})[key]||key.replaceAll('_',' ')||'—';}
const ACTIVE_SUPPLY_STATES=new Set(['IN_TRANSIT','ACCEPTED_AT_SUPPLY_WAREHOUSE','ACCEPTANCE_AT_STORAGE_WAREHOUSE','REPORTS_CONFIRMATION_AWAITING','REPORT_REJECTED']);
const FINISHED_SUPPLY_STATES=new Set(['COMPLETED','CANCELLED','REJECTED_AT_SUPPLY_WAREHOUSE','OVERDUE']);
function supplyListSection(order){
 const parent=String(order?.state||'').toUpperCase(),children=(order?.supplies||[]).map(s=>String(s.state||'').toUpperCase());
 if(FINISHED_SUPPLY_STATES.has(parent))return 'history';
 if(children.length&&children.every(state=>FINISHED_SUPPLY_STATES.has(state)))return 'history';
 if(ACTIVE_SUPPLY_STATES.has(parent)||children.some(state=>ACTIVE_SUPPLY_STATES.has(state)))return 'active';
 return null;
}
function orderStateLabel(order){
 const parent=String(order.state||'').toUpperCase();
 if(supplyListSection(order)==='history'&&!FINISHED_SUPPLY_STATES.has(parent))return 'Завершено';
 return stateLabel(parent);
}
function accountingSummary(account,order){
 const saved=state.settings?.ozonFboTransfers||{},prefix=String(account)+'|'+String(order.order_id)+'|',records=Object.entries(saved).filter(([key,row])=>key.startsWith(prefix)&&row);
 const lines=allLines(order).filter(x=>Number(x.item.quantity)>0),keys=new Set(lines.map(x=>transferKey(account,order.order_id,x.s.supply_id,x.s.bundle_id,x.item.sku)));
 const compositionComplete=(order.supplies||[]).length>0&&(order.supplies||[]).every(s=>Array.isArray(s.items)&&s.items.length>0&&!s.bundle_error&&!s.bundle_pending);
 const qty=lines.reduce((n,x)=>n+Number(x.item.quantity),0),recordedQty=records.reduce((n,[,row])=>n+Math.max(0,Number(row.qty)||0),0);
 const complete=compositionComplete&&lines.length>0&&lines.every(x=>{
  const row=saved[transferKey(account,order.order_id,x.s.supply_id,x.s.bundle_id,x.item.sku)];return row&&Number(row.qty)===Number(x.item.quantity);
 })&&records.every(([key])=>keys.has(key));
 return {status:complete?'complete':records.length?(compositionComplete?'partial':'unknown'):'none',qty,recordedQty,compositionComplete};
}
function accountingHtml(account,order){
 const x=accountingSummary(account,order),label=x.status==='complete'?'Учтено':x.status==='partial'?'Частично учтено':x.status==='unknown'?'Учтено '+x.recordedQty+' шт.':'Не учтено',color=x.status==='complete'?'#218838':x.status==='partial'?'#a86400':'#777';
 const detail=x.status==='none'?'':x.status==='unknown'?' · состав уточняется':x.compositionComplete?' · '+x.recordedQty+' из '+x.qty+' шт.':' · '+x.recordedQty+' шт. · состав уточняется';
 return '<div style="margin-top:5px;color:'+color+'"><b>'+label+'</b>'+text(detail)+'</div>';
}
async function loadIndex(force=false){
 if(cache&&!force)return cache;
 cache=await api('/api/ozon-fbo');return cache;
}
function renderOrders(){
 const accounts=cache?.accounts||[],rows=[];
 for(const a of accounts)for(const o of a.supplies?.rows||[])rows.push({account:a.account,label:a.label||'Ozon',...o});
 rows.sort((a,b)=>Date.parse(b.created_date||b.created_at||0)-Date.parse(a.created_date||a.created_at||0));
 const classified=rows.map(o=>({order:o,section:supplyListSection(o)})),selected=classified.filter(x=>x.section===listView);
 const tabs=`<div class="row" style="gap:8px;margin:12px 0">${[['active','В пути'],['history','История']].map(([key,label])=>`<button type="button" class="btn${listView===key?' dark':''}" aria-pressed="${listView===key}" onclick="setOzonFboSupplyListView('${key}')">${label} · ${classified.filter(x=>x.section===key).length}</button>`).join('')}</div>`;
 const body=selected.length?selected.map(({order:o})=>{
  const details=detailCache.get(String(o.account)+'|'+String(o.order_id)),order=details?{...o,supplies:details.supplies}:o,n=(order.supplies||[]).length,total=(order.supplies||[]).reduce((sum,s)=>sum+Number(s.total_quantity||0),0);
  return `<div class="item" style="margin-top:8px"><div class="row"><div class="grow"><b>${text(o.order_number||('Заявка #'+o.order_id))}</b><div class="muted">${text(o.label)} · ${n} направлений${total?' · '+total+' шт.':''}<br>${text(orderStateLabel(o))}${o.created_date?' · '+new Date(o.created_date).toLocaleDateString('ru-RU'):''}</div>${accountingHtml(o.account,order)}</div><button class="btn" onclick="openOzonFboSupplyOrder('${encodeURIComponent(String(o.account))}','${encodeURIComponent(String(o.order_id))}')">Открыть</button></div></div>`;
 }).join(''):'<div class="empty">'+(listView==='active'?'Нет поставок в пути или на приёмке.':'История поставок пока пуста.')+'</div>';
 showSheet('<h3>Ozon FBO · поставки</h3>'+tabs+body);
}
window.setOzonFboSupplyListView=view=>{if(!['active','history'].includes(view))return;listView=view;renderOrders();};
window.showOzonFboSupplyList=()=>renderOrders();

window.openOzonFboSupplies=async()=>{
 listView='active';detailCache.clear();
 showSheet('<h3>Ozon FBO · поставки</h3><div class="empty">Загружаю заявки…</div>');
 try{await loadIndex(true);renderOrders();}catch(e){showSheet('<h3>Ozon FBO · поставки</h3><div class="empty">'+text(e.message||e)+'</div>');}
};
function allLines(order){const out=[];for(const s of order?.supplies||[])for(const item of s.items||[])out.push({s,item});return out;}
function orderSummary(order){const lines=allLines(order),qty=lines.reduce((n,x)=>n+Math.max(0,Number(x.item.quantity)||0),0),linked=lines.filter(x=>matchProduct(current.account,x.item)).length,recorded=lines.filter(x=>Number(storedTransfers()[transferKey(current.account,order.order_id,x.s.supply_id,x.s.bundle_id,x.item.sku)]?.qty)===Number(x.item.quantity)).length;return{lines,qty,linked,recorded};}
function renderOrder(){
 const order=current?.order;if(!order)return;
 const sum=orderSummary(order),supplies=order.supplies||[];
 const cards=supplies.map(s=>{
  const items=(s.items||[]).map(item=>{
   const p=matchProduct(current.account,item),key=transferKey(current.account,order.order_id,s.supply_id,s.bundle_id,item.sku),done=storedTransfers()[key],qty=Math.max(0,Number(item.quantity)||0);
   const action=done?`<b style="color:${Number(done.qty)===qty?'#218838':'#a86400'}">Учтено ${Math.max(0,Number(done.qty)||0)} из ${qty} шт.</b>`:p?`<button class="btn" onclick="accountOzonFboLine('${encodeURIComponent(key)}')">Учесть ${qty} шт.</button>`:`<button class="btn" onclick="linkOzonFboItem('${encodeURIComponent(String(s.supply_id||''))}','${encodeURIComponent(String(s.bundle_id||''))}','${encodeURIComponent(String(item.sku||''))}')">Привязать</button>`;
   const source=p&&!done?`<label class="muted" for="ozonFboSource-${encodeURIComponent(key)}">Откуда отправляем</label><select id="ozonFboSource-${encodeURIComponent(key)}" class="select" style="width:100%;margin-top:5px">${sourceOptions(p)}</select>`:'';
   return `<div style="padding:9px 0;border-top:1px solid #eee"><div class="row"><div class="grow"><b>${text(item.name||item.offer_id||('SKU '+item.sku))}</b><div class="muted">SKU ${text(item.sku)}${item.offer_id?' · арт. '+text(item.offer_id):''} · ${qty} шт.<br>${p?'Товар склада: '+text(p.name):'Нужно привязать к товару склада'}</div></div>${action}</div>${source}</div>`;
  }).join('')||'<div class="muted">Состав не получен'+(s.bundle_error?' · '+text(s.bundle_error):'')+'</div>';
  return `<div class="item" style="margin-top:9px"><b>${text(warehouseLabel(s))}</b><div class="muted">${s.is_crossdock?'Кросс-докинг · ':''}${text(stateLabel(s.state))} · поставка ${text(s.supply_id)}</div>${items}</div>`;
 }).join('');
 const remaining=sum.lines.filter(x=>!storedTransfers()[transferKey(current.account,order.order_id,x.s.supply_id,x.s.bundle_id,x.item.sku)]),remainingQty=remaining.reduce((n,x)=>n+Math.max(0,Number(x.item.quantity)||0),0);
 const bulk=remaining.length?`<label class="muted" for="ozonFboBulkSource">Источник для всей поставки</label><select id="ozonFboBulkSource" class="select" style="width:100%;margin-top:5px"><option value="auto">По наличию · сначала со склада</option><option value="at_warehouse">Только со склада</option><option value="sale">Только из продажи</option></select><button class="btn dark full" style="margin:10px 0" onclick="accountWholeOzonFboOrder()">${remaining.length===sum.lines.length?'Учесть отправку':'Учесть оставшееся'} · ${remainingQty} шт.</button>`:'';
 showSheet(`<button type="button" class="btn" style="margin-bottom:10px" onclick="showOzonFboSupplyList()">‹ К поставкам</button><h3>${text(order.order_number||('Заявка #'+order.order_id))}</h3>${accountingHtml(current.account,order)}<div class="muted">${supplies.length} направлений · ${sum.qty} шт. · привязано ${sum.linked}/${sum.lines.length} · учтено ${sum.recorded}/${sum.lines.length}</div>${bulk}${cards}`);
}
window.openOzonFboSupplyOrder=async(account,orderId)=>{
 account=decodeURIComponent(account);orderId=decodeURIComponent(orderId);showSheet('<h3>Ozon FBO</h3><div class="empty">Загружаю состав поставки…</div>');
 try{await loadIndex();const r=await api('/api/ozon-supply-order?account='+encodeURIComponent(account)+'&orderId='+encodeURIComponent(orderId));current={account,label:r.label,order:r.order};detailCache.set(String(account)+'|'+String(orderId),r.order);const a=(cache.accounts||[]).find(x=>String(x.account)===String(account)),index=(a?.supplies?.rows||[]).findIndex(x=>String(x.order_id)===String(orderId));if(index>=0)a.supplies.rows[index]=r.order;renderOrder();}catch(e){showSheet('<h3>Ozon FBO</h3><div class="empty">'+text(e.message||e)+'</div>');}
};
window.linkOzonFboItem=(supplyId,bundleId,sku)=>{
 supplyId=decodeURIComponent(supplyId);bundleId=decodeURIComponent(bundleId);sku=decodeURIComponent(sku);
 const row=allLines(current.order).find(x=>String(x.s.supply_id)===supplyId&&String(x.s.bundle_id)===bundleId&&String(x.item.sku)===sku);if(!row)return;
 linkContext={...row,account:current.account};renderLinkPicker('');
};
function productPickerHtml(q){
 q=String(q||'').toLowerCase();
 const products=(state.products||[]).filter(p=>(p.name||'').toLowerCase().includes(q)).slice(0,50);
 return products.map(p=>`<button class="btn full" style="margin-top:7px;text-align:left" onclick="chooseOzonFboProduct('${encodeURIComponent(String(p.id))}')">${text(p.name)} <span class="muted">· остаток ${Number(p.stock)||0}</span></button>`).join('')||'<div class="empty">Ничего не найдено</div>';
}
function renderLinkPicker(q){
 q=String(q||'');const item=linkContext.item;
 showSheet(`<h3>Привязать товар Ozon</h3><div class="muted">${text(item.name||'')} · SKU ${text(item.sku)}</div><input id="ozonSupplyProductSearch" class="input" style="margin-top:10px" placeholder="Найти товар склада" value="${text(q)}" oninput="filterOzonFboLinkPicker(this.value)"><div id="ozonSupplyProductList">${productPickerHtml(q)}</div>`);
 const input=document.getElementById('ozonSupplyProductSearch');if(input){input.focus();input.setSelectionRange(input.value.length,input.value.length);}
}
window.filterOzonFboLinkPicker=q=>{const list=document.getElementById('ozonSupplyProductList');if(list)list.innerHTML=productPickerHtml(q);};
window.renderOzonFboLinkPicker=q=>renderLinkPicker(q);
window.chooseOzonFboProduct=pid=>{
 pid=decodeURIComponent(pid);const p=prod(pid);if(!p||!linkContext)return;
 const ids=itemIdentifiers(linkContext.account,linkContext.item),preferred=String(linkContext.item.sku||'').trim()||ids[0]||'';
 attachMarketplaceSku(p,'Ozon',preferred,'');
 for(const alias of ids)if(alias&&alias!==preferred)attachMarketplaceSku(p,'Ozon',alias,'');
 try{save();}catch(_){}renderOrder();
};
function lineByKey(key){return allLines(current.order).find(x=>transferKey(current.account,current.order.order_id,x.s.supply_id,x.s.bundle_id,x.item.sku)===key);}
function saleStock(p){return Math.max(0,(Number(p?.stock)||0)-(typeof reserved==='function'?Math.max(0,Number(reserved(p))||0):0));}
function warehouseStock(p){return typeof purchaseAtWarehouseQty==='function'?purchaseAtWarehouseQty(p.id):0;}
function sourceOptions(p){return `<option value="auto">По наличию</option><option value="at_warehouse">На складе · ${warehouseStock(p)} шт.</option><option value="sale">В продаже · ${saleStock(p)} шт.</option>`;}
function stockPlan(p,qty,source='auto'){
 if(!Number.isInteger(qty)||qty<=0)throw Error('Количество отправки должно быть целым положительным числом.');
 if(!['auto','at_warehouse','sale'].includes(source))throw Error('Выберите источник отправки.');
 const wh=warehouseStock(p),free=saleStock(p),warehouseQty=source==='sale'?0:source==='at_warehouse'?qty:Math.min(qty,wh),saleQty=qty-warehouseQty;
 if(warehouseQty>wh||saleQty>free)throw Error('Недостаточно товара «'+p.name+'»: нужно '+qty+' шт. На складе: '+wh+' шт., в продаже без резерва: '+free+' шт.');
 if(warehouseQty&&typeof releaseWarehousePurchaseUnits!=='function')throw Error('Учёт партий ещё загружается. Обновите страницу и повторите.');
 if(saleQty&&typeof fifoConsume!=='function')throw Error('Учёт себестоимости ещё загружается. Обновите страницу и повторите.');
 const lots=[];let need=warehouseQty;
 for(const lot of (state.purchases||[]).filter(x=>String(x.productId)===String(p.id)&&purchaseWarehouseQty(x)>0).sort((a,b)=>(Number(a.warehouseReceivedAt||a.orderedAt||a.date||a.createdAt)||0)-(Number(b.warehouseReceivedAt||b.orderedAt||b.date||b.createdAt)||0))){
  if(!need)break;const take=Math.min(need,purchaseWarehouseQty(lot));lots.push({lot,qty:take,unitCost:purchaseDisplayUnitCost(lot)});need-=take;
 }
 if(need)throw Error('Не удалось найти полный состав складских партий. Обновите страницу.');
 return{p,qty,warehouseQty,saleQty,lots};
}
function consumeStockPlan(plan){
 const {p,warehouseQty,saleQty,lots}=plan,used=[];let totalCost=0;
 for(const part of lots){
  // Reuse the regular warehouse release/split, preserving paid totals and prior
  // writeoffs. The released units immediately leave for FBO in this same save.
  releaseWarehousePurchaseUnits(part.lot,part.qty,Date.now());
  const released=purchaseStatus(part.lot)==='received'?part.lot:state.purchases[0];
  released.remainingQty=Math.max(0,Number(released.remainingQty)-part.qty);
  totalCost+=part.qty*part.unitCost;
  used.push({purchaseId:String(released.id),warehousePurchaseId:String(part.lot.id),qty:part.qty,unitCost:part.unitCost});
 }
 if(warehouseQty)log('приход',p.id,warehouseQty,'со склада для отправки Ozon FBO');
 if(saleQty){const cost=fifoConsume(p.id,saleQty);totalCost+=Number(cost.totalCost)||0;used.push(...(cost.lots||[]));p.stock=(Number(p.stock)||0)-saleQty;}
 try{refreshProductAverageCost(p)}catch(_){}
 return{totalCost,lots:used,stockSource:warehouseQty&&saleQty?'mixed':warehouseQty?'at_warehouse':'sale'};
}
function recordTransfer(row,p,cost,qty){
 const key=transferKey(current.account,current.order.order_id,row.s.supply_id,row.s.bundle_id,row.item.sku);
 transfers()[key]={key,productId:p.id,sku:String(row.item.sku||''),qty,account:current.account,orderId:String(current.order.order_id),supplyId:String(row.s.supply_id||''),bundleId:String(row.s.bundle_id||''),warehouseId:String(row.s.storage_warehouse?.warehouse_id||''),warehouseName:warehouseLabel(row.s),crossdock:Boolean(row.s.is_crossdock),sentAt:Date.now(),unitCost:cost.unitCost,stockSource:cost.stockSource,status:'in_transit'};
}
function confirmPlans(plans){const qty=plans.reduce((n,p)=>n+p.qty,0),wh=plans.reduce((n,p)=>n+p.warehouseQty,0),sale=plans.reduce((n,p)=>n+p.saleQty,0);return confirm('Учесть отправку '+qty+' шт. на Ozon FBO?'+(wh?'\nСо склада: '+wh+' шт.':'')+(sale?'\nИз продажи: '+sale+' шт.':''));}
window.accountOzonFboLine=encoded=>{
 if(!requireWarehouseEditReady())return;
 const key=decodeURIComponent(encoded),row=lineByKey(key);if(!row||storedTransfers()[key])return;
 const p=matchProduct(current.account,row.item);if(!p)return alert('Сначала привяжите товар.');
 let plan;try{plan=stockPlan(p,Number(row.item.quantity),document.getElementById('ozonFboSource-'+encoded)?.value||'auto')}catch(e){return alert(e.message)}
 if(!confirmPlans([plan]))return;
 const cost=consumeStockPlan(plan),movement=log('FBO Ozon',p.id,-plan.qty,'в пути на Ozon FBO · '+warehouseLabel(row.s)+' · заявка '+String(current.order.order_number||current.order.order_id));
 movement.fifoLots=cost.lots;recordTransfer(row,p,{unitCost:cost.totalCost/plan.qty,stockSource:cost.stockSource},plan.qty);
 save();render();renderOrder();
};
window.accountWholeOzonFboOrder=()=>{
 if(!requireWarehouseEditReady())return;
 const rows=allLines(current.order).filter(x=>!storedTransfers()[transferKey(current.account,current.order.order_id,x.s.supply_id,x.s.bundle_id,x.item.sku)]);
 if(!rows.length)return alert('Эта поставка уже учтена.');
 const groups=new Map();
 for(const row of rows){const p=matchProduct(current.account,row.item);if(!p)return alert('Сначала привяжите все товары.');const q=Number(row.item.quantity);if(!Number.isInteger(q)||q<=0)return alert('Проверьте количество в составе поставки.');if(!groups.has(p.id))groups.set(p.id,{p,qty:0,rows:[]});const g=groups.get(p.id);g.qty+=q;g.rows.push(row);}
 const source=document.getElementById('ozonFboBulkSource')?.value||'auto';let plans;
 try{plans=[...groups.values()].map(g=>({...stockPlan(g.p,g.qty,source),rows:g.rows}))}catch(e){return alert(e.message)}
 if(!confirmPlans(plans))return;
 for(const plan of plans){
  const cost=consumeStockPlan(plan),movement=log('FBO Ozon',plan.p.id,-plan.qty,'в пути на Ozon FBO · '+plan.rows.length+' направлений · заявка '+String(current.order.order_number||current.order.order_id));movement.fifoLots=cost.lots;
  for(const row of plan.rows)recordTransfer(row,plan.p,{unitCost:cost.totalCost/plan.qty,stockSource:cost.stockSource},Number(row.item.quantity));
 }
 save();render();renderOrder();
};
function roundOzonMoneyDisplay(){
 if(String(state?.settings?.reportMarket||'')!=='Ozon')return;
 const root=document.getElementById('reports');if(!root)return;
 const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
 const changed=[];let node;
 while((node=walker.nextNode())){
  const before=node.nodeValue||'';
  const after=before.replace(/(-?\d[\d\s\u00A0\u202F]*)([,.])(\d{1,2})\s*(KZT|₸)/g,(_m,intPart,_sep,dec,currency)=>{
   const raw=Number(String(intPart).replace(/[\s\u00A0\u202F]/g,''))+Number(dec)/100*(String(intPart).trim().startsWith('-')?-1:1);
   return new Intl.NumberFormat('ru-RU',{maximumFractionDigits:0}).format(Math.round(raw))+' '+currency;
  });
  if(after!==before)changed.push([node,after]);
 }
 for(const [target,value] of changed)target.nodeValue=value;
}
const moneyObserver=new MutationObserver(()=>queueMicrotask(roundOzonMoneyDisplay));
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>{const root=document.getElementById('reports');if(root)moneyObserver.observe(root,{subtree:true,childList:true,characterData:true});roundOzonMoneyDisplay();},{once:true});
else{const root=document.getElementById('reports');if(root)moneyObserver.observe(root,{subtree:true,childList:true,characterData:true});roundOzonMoneyDisplay();}
})();
