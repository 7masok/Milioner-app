(function(){
'use strict';
if(!window.WB3_ONLY)return;
const UI_KEY='inferno_orders_v1';
let preference={};try{preference=JSON.parse(localStorage.getItem(UI_KEY)||'{}');}catch{}
let model=['all','FBS','FBO'].includes(preference.model)?preference.model:'all';
let historySync=[],orderError='',loading=null;
function remember(){localStorage.setItem(UI_KEY,JSON.stringify({model,period:orderPeriodMode}));}
function forceStore(){selectedOrderMarket='WB';selectedWbAccount='WB';state.settings.selectedOrderMarket='WB';state.settings.selectedWbAccount='WB';}
const oldBounds=orderPeriodBounds;
orderPeriodBounds=function(){return orderPeriodMode==='all'?{start:0,end:Infinity}:oldBounds();};
orderFeedAfterTimestamp=function(){return 0;};
const oldPeriod=setOrderPeriod;
setOrderPeriod=function(mode){if(mode==='all'){orderPeriodMode='all';orderPage=1;renderOrderPeriodControls();renderMarketplaceOrders();}else oldPeriod(mode);remember();};
window.infernoOrderModel=function(value){model=['FBS','FBO'].includes(value)?value:'all';orderPage=1;remember();renderMarketplaceOrders();};
const oldStart=startAppRuntime;
startAppRuntime=function(){oldStart();forceStore();orderPeriodMode=['today','yesterday','week','month','custom','all'].includes(preference.period)?preference.period:'all';renderOrderPeriodControls();renderMarketplaceOrders();};
function controls(){
 const period=document.getElementById('orderPeriod');
 if(period&&!period.querySelector('[data-order-period="all"]')){const b=document.createElement('button');b.type='button';b.className='order-period-btn';b.dataset.orderPeriod='all';b.textContent='За всё время';b.onclick=()=>setOrderPeriod('all');period.append(b);}
 const home=document.getElementById('home');
 for(const tabs of home?.querySelectorAll('.market-tabs')||[])if(tabs.id!=='infernoModels')tabs.hidden=true;
 if(home&&!document.getElementById('infernoModels')){
  const tabs=document.createElement('div');tabs.className='market-tabs';tabs.id='infernoModels';
  tabs.innerHTML=['all','FBS','FBO'].map(value=>`<button type="button" class="market-tab" data-inferno-model="${value}" onclick="infernoOrderModel('${value}')">${value==='all'?'Все':value}</button>`).join('');
  home.querySelector('.order-search-row')?.after(tabs);
  const status=document.createElement('div');status.id='infernoOrderStatus';status.className='muted';status.style.cssText='font-size:12px;margin:6px 0';tabs.after(status);
 }
 document.querySelectorAll('[data-inferno-model]').forEach(b=>b.classList.toggle('active',b.dataset.infernoModel===model));
 const status=document.getElementById('infernoOrderStatus');if(status){const errors=historySync.filter(x=>x.error).map(x=>(x.source==='feed'?'Лента':'История')+': '+x.error+(x.nextAt?' · '+new Date(x.nextAt).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Almaty'}):''));status.textContent=orderError||errors.join(' · ');status.hidden=!status.textContent;}
}
function cancelled(row){return ['cancel','return','returnDefective'].includes(row.orderStatus)||marketplaceLifecycleStage('WB',row.status,row.state)==='cancelled';}
function statusLabel(row){const labels={created:'Заказан',buyout:'Выкуплен',cancel:'Отменён',return:'Возврат',returnDefective:'Брак'};if(cancelled(row))return ['cancel','return','returnDefective'].includes(row.orderStatus)?labels[row.orderStatus]:'Отменён';if(row.orderStatus&&row.orderStatus!=='created')return labels[row.orderStatus]||row.orderStatus;const wb=String(row.state||'').toLowerCase(),seller=String(row.status||'').toLowerCase();if(wb==='sold')return 'Выкуплен';if(['sorted','accepted_by_carrier','sent_to_carrier','ready_for_pickup'].includes(wb))return 'В доставке';if(seller==='confirm')return 'На сборке';if(seller==='complete')return 'Собран';return row.fulfillment==='FBO'?'Заказан':'Новый';}
function amount(row){return row.priceKnown&&row.currency==='KZT'?fmt(row.totalPrice):row.priceKnown&&row.currency?new Intl.NumberFormat('ru-RU',{style:'currency',currency:row.currency}).format(row.totalPrice):'';}
renderMarketplaceOrders=function(){
 forceStore();controls();renderOrderPeriodControls();renderOrderPager(0);
 const list=document.getElementById('kaspiOrderList');if(!list)return;
 if(!homeOrdersSettled){list.innerHTML='<div class="empty">Загружаю заказы…</div>';return;}
 const period=filterMarketplaceOrdersByPeriod(groupMarketplaceOrders(state.wbOrderFeed||[])).filter(g=>model==='all'||g.lines.some(row=>row.fulfillment===model));
 const rows=period.filter(g=>!unmatchedOrderFilter||g.lines.some(row=>!row.productId));
 const visible=filterMarketplaceOrdersBySearch(rows),lines=period.flatMap(g=>g.lines),active=lines.filter(row=>!cancelled(row));
 const qty=active.reduce((n,row)=>n+(Number(row.qty)||0),0),money=active.filter(row=>row.priceKnown&&row.currency==='KZT').reduce((n,row)=>n+(Number(row.totalPrice)||0),0),missing=active.some(row=>!row.priceKnown||row.currency!=='KZT');
 for(const id of ['koQty','koTotal']){const el=document.getElementById(id);if(el)el.textContent=qty.toLocaleString('ru-RU')+' шт.';}
 for(const id of ['koAmount','koMatched']){const el=document.getElementById(id);if(el)el.textContent=active.length&&!active.some(row=>row.priceKnown&&row.currency==='KZT')?'Нет суммы в ₸':fmt(money)+(missing?' + …':'');}
 const badge=document.getElementById('orderCountBadge');if(badge)badge.textContent=visible.length;
 const unmatched=new Set(lines.filter(row=>!row.productId).map(row=>row.sku||row.nmId||row.entryId));
 const n=document.getElementById('koUnmatched');if(n)n.textContent=unmatched.size;
 const banner=document.getElementById('koUnmatchedCard');if(banner){banner.hidden=!unmatched.size;banner.classList.toggle('active',Boolean(unmatchedOrderFilter));}
 if(!visible.length){list.innerHTML='<div class="empty">'+(orderError&&!(state.wbOrderFeed||[]).length?esc(orderError):orderSearchText?'Ничего не найдено':unmatchedOrderFilter?'Все товары привязаны':period.length?'Нет заказов по фильтру':'За этот период заказов нет')+'</div>';return;}
 orderPage=Math.min(Math.max(1,orderPage),Math.ceil(visible.length/ORDER_PAGE_SIZE));
 list.innerHTML=visible.slice((orderPage-1)*ORDER_PAGE_SIZE,orderPage*ORDER_PAGE_SIZE).map(g=>{
  const row=g.lines[0],date=new Date(g.creationDate).toLocaleString('ru-RU',{timeZone:'Asia/Almaty',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
  const items=g.lines.map(o=>{const p=prod(o.productId),photo=p?.photo;return `<div class="order-line" style="margin-top:8px">${/^https:\/\//i.test(photo||'')?`<img class="wb3-product-photo" src="${esc(photo)}" alt="" loading="lazy" referrerpolicy="no-referrer">`:''}<div class="grow"><b>${esc(p?.name||o.productName||'WB '+o.nmId)}</b><div class="order-sku">${esc(o.sku||'WB '+o.nmId)}</div>${p?`<button type="button" class="badge ok link-btn" onclick="openProduct('${esc(p.id)}')">Товар</button>`:o.sku?`<button type="button" class="badge bad link-btn" onclick="openWbLink('${encodeURIComponent(String(o.orderId)+':'+String(o.entryId))}')">Привязать</button>`:''}</div><div class="right"><b>${Number(o.qty)||1} шт.</b><div class="muted">${esc(amount(o))}</div></div></div>`;}).join('');
  return `<div class="item order-card-compact"><div class="order-head"><div class="grow"><div class="name order-title"><span class="order-market-mark wb">${esc(row.fulfillment||'WB')}</span><span style="overflow-wrap:anywhere">№ ${esc(g.code||g.orderId)}</span></div></div><div class="order-header-right"><div class="order-date">${date}</div><span class="badge ${cancelled(row)?'bad':row.orderStatus==='buyout'?'ok':'warn'}">${esc(statusLabel(row))}</span></div></div>${items}</div>`;
 }).join('');renderOrderPager(visible.length);
};
loadSharedOrderCache=function(){
 if(loading)return loading;
 loading=(async()=>{try{
  let cursor='',all=[],status=[];const seen=new Set();
  do{const data=await apiJson(MILLIONER_API+'/api/orders?limit=1000&after=0'+(cursor?'&cursor='+encodeURIComponent(cursor):''));all.push(...(data.orders||[]));status=data.sync||[];cursor=data.nextCursor||'';if(cursor&&seen.has(cursor))throw new Error('Повтор страницы заказов');seen.add(cursor);}while(cursor);
  state.wbOrderFeed=normalizeServerFeed(all,'WB');state.kaspiOrderFeed=[];state.ozonOrderFeed=[];historySync=status;orderError='';homeOrdersSettled=true;saveLocalOnly();render();writeHomeCache();
  return {wb:all.length};
 }catch(error){orderError='Не удалось загрузить заказы: '+String(error.message||error);homeOrdersSettled=true;renderMarketplaceOrders();return {error};}
 finally{loading=null;}})();
 apiJson(MILLIONER_API+'/api/market-status').then(data=>{state.settings.serverMarketStatus=Object.fromEntries((data.markets||[]).map(x=>[x.market,x]));renderIntegrationStatus();window.refreshCompactMarketStatus?.();}).catch(()=>{});
 return loading;
};
syncNow=async function(){const b=document.getElementById('syncNowButton');if(b?.disabled)return;if(b){b.disabled=true;b.textContent='…';}try{cloudStatus('обновляю заказы…','warn');const response=await fetch(MILLIONER_API+'/api/wb3/sync',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}),data=await response.json();if(!response.ok||!data.ok)throw new Error(data.error||'Ошибка обновления');await loadSharedOrderCache();await window.refreshWb3Stock?.();cloudStatus('подключён','ok');}catch(error){orderError=String(error.message||error);renderMarketplaceOrders();cloudStatus('ошибка обновления','warn');}finally{if(b){b.disabled=false;b.innerHTML='<span class="sync-now-icon" aria-hidden="true">↻</span>';}}};
const css=document.createElement('style');css.textContent='header{border-top:3px solid #c34717}header .title{color:#a8320d}.login-card h1{color:#b33c12}#home>.market-tabs[hidden]{display:none!important}.order-period{flex-wrap:wrap}.order-title{font-size:12px!important}.order-line .grow{min-width:0;overflow-wrap:anywhere}.order-line .right{flex:none}.order-summary{display:none!important}';document.head.append(css);
controls();
})();
