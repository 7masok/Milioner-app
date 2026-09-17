(()=>{
'use strict';
let cache=null,current=null,linkContext=null;
const api=path=>apiJson(MILLIONER_API+path);
const transfers=()=>{state.settings=state.settings||{};return state.settings.ozonFboTransfers||(state.settings.ozonFboTransfers={});};
const text=v=>esc(String(v??''));
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
function stateLabel(v){return String(v||'—').replaceAll('_',' ');}
async function loadIndex(force=false){
 if(cache&&!force)return cache;
 cache=await api('/api/ozon-fbo');return cache;
}
function ensureButton(){
 const tabs=document.getElementById('reportMarketTabs');if(!tabs)return;
 let b=document.getElementById('ozonFboSuppliesBtn');
 if(!b){b=document.createElement('button');b.id='ozonFboSuppliesBtn';b.type='button';b.className='btn';b.textContent='Поставки FBO';b.onclick=()=>window.openOzonFboSupplies();tabs.parentNode.insertBefore(b,tabs.nextSibling);b.style.margin='8px 0 12px';}
 b.style.display=String(state?.settings?.reportMarket||'')==='Ozon'?'':'none';
}
function renderOrders(){
 const accounts=cache?.accounts||[],rows=[];
 for(const a of accounts)for(const o of a.supplies?.rows||[])rows.push({account:a.account,label:a.label||'Ozon',...o});
 rows.sort((a,b)=>Date.parse(b.created_date||b.created_at||0)-Date.parse(a.created_date||a.created_at||0));
 const body=rows.length?rows.map(o=>{
  const n=(o.supplies||[]).length,total=(o.supplies||[]).reduce((sum,s)=>sum+Number(s.total_quantity||0),0);
  return `<div class="item" style="margin-top:8px"><div class="row"><div class="grow"><b>${text(o.order_number||('Заявка #'+o.order_id))}</b><div class="muted">${text(o.label)} · ${n} направлений${total?' · '+total+' шт.':''}<br>${text(stateLabel(o.state))}${o.created_date?' · '+new Date(o.created_date).toLocaleDateString('ru-RU'):''}</div></div><button class="btn" onclick="openOzonFboSupplyOrder('${encodeURIComponent(String(o.account))}','${encodeURIComponent(String(o.order_id))}')">Открыть</button></div></div>`;
 }).join(''):'<div class="empty">Ozon пока не вернул заявок FBO.</div>';
 showSheet('<h3>Ozon FBO · поставки</h3><div class="muted">Заявки загружаются из Ozon автоматически. Открой заявку, привяжи товар один раз и затем учти отправку.</div>'+body);
}
window.openOzonFboSupplies=async()=>{
 showSheet('<h3>Ozon FBO · поставки</h3><div class="empty">Загружаю заявки…</div>');
 try{await loadIndex(true);renderOrders();}catch(e){showSheet('<h3>Ozon FBO · поставки</h3><div class="empty">'+text(e.message||e)+'</div>');}
};
function allLines(order){const out=[];for(const s of order?.supplies||[])for(const item of s.items||[])out.push({s,item});return out;}
function orderSummary(order){const lines=allLines(order),qty=lines.reduce((n,x)=>n+Math.max(0,Number(x.item.quantity)||0),0),linked=lines.filter(x=>matchProduct(current.account,x.item)).length,recorded=lines.filter(x=>transfers()[transferKey(current.account,order.order_id,x.s.supply_id,x.s.bundle_id,x.item.sku)]).length;return{lines,qty,linked,recorded};}
function renderOrder(){
 const order=current?.order;if(!order)return;
 const sum=orderSummary(order),supplies=order.supplies||[];
 const cards=supplies.map(s=>{
  const items=(s.items||[]).map(item=>{
   const p=matchProduct(current.account,item),key=transferKey(current.account,order.order_id,s.supply_id,s.bundle_id,item.sku),done=transfers()[key],qty=Math.max(0,Number(item.quantity)||0);
   const action=done?'<b style="color:#218838">Учтено</b>':p?`<button class="btn" onclick="accountOzonFboLine('${encodeURIComponent(key)}')">Учесть ${qty} шт.</button>`:`<button class="btn" onclick="linkOzonFboItem('${encodeURIComponent(String(s.supply_id||''))}','${encodeURIComponent(String(s.bundle_id||''))}','${encodeURIComponent(String(item.sku||''))}')">Привязать</button>`;
   return `<div style="padding:9px 0;border-top:1px solid #eee"><div class="row"><div class="grow"><b>${text(item.name||item.offer_id||('SKU '+item.sku))}</b><div class="muted">SKU ${text(item.sku)}${item.offer_id?' · арт. '+text(item.offer_id):''} · ${qty} шт.<br>${p?'Товар склада: '+text(p.name):'Нужно привязать к товару склада'}</div></div>${action}</div></div>`;
  }).join('')||'<div class="muted">Состав не получен'+(s.bundle_error?' · '+text(s.bundle_error):'')+'</div>';
  return `<div class="item" style="margin-top:9px"><b>${text(warehouseLabel(s))}</b><div class="muted">${s.is_crossdock?'Кросс-докинг · ':''}${text(stateLabel(s.state))} · поставка ${text(s.supply_id)}</div>${items}</div>`;
 }).join('');
 const bulk=sum.lines.length?`<button class="btn dark full" style="margin:10px 0" onclick="accountWholeOzonFboOrder()">Учесть отправку всей поставки · ${sum.qty} шт.</button>`:'';
 showSheet(`<h3>${text(order.order_number||('Заявка #'+order.order_id))}</h3><div class="muted">${supplies.length} направлений · ${sum.qty} шт. · привязано ${sum.linked}/${sum.lines.length} · учтено ${sum.recorded}/${sum.lines.length}</div>${bulk}${cards}`);
}
window.openOzonFboSupplyOrder=async(account,orderId)=>{
 account=decodeURIComponent(account);orderId=decodeURIComponent(orderId);showSheet('<h3>Ozon FBO</h3><div class="empty">Загружаю 18 направлений и состав…</div>');
 try{await loadIndex();const r=await api('/api/ozon-supply-order?account='+encodeURIComponent(account)+'&orderId='+encodeURIComponent(orderId));current={account,label:r.label,order:r.order};renderOrder();}catch(e){showSheet('<h3>Ozon FBO</h3><div class="empty">'+text(e.message||e)+'</div>');}
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
 const ids=itemIdentifiers(linkContext.account,linkContext.item),preferred=String(linkContext.item.offer_id||ids[0]||linkContext.item.sku||'');
 attachMarketplaceSku(p,'Ozon',preferred,'');
 for(const alias of ids)if(alias&&alias!==preferred)attachMarketplaceSku(p,'Ozon',alias,'');
 try{save();}catch(_){}renderOrder();
};
function available(p){try{return typeof productAvailableStock==='function'?Number(productAvailableStock(p))||0:Number(p.stock)||0}catch{return Number(p.stock)||0}}
function lineByKey(key){return allLines(current.order).find(x=>transferKey(current.account,current.order.order_id,x.s.supply_id,x.s.bundle_id,x.item.sku)===key);}
window.accountOzonFboLine=encoded=>{
 const key=decodeURIComponent(encoded),row=lineByKey(key);if(!row||transfers()[key])return;const p=matchProduct(current.account,row.item),qty=Math.max(0,Number(row.item.quantity)||0);if(!p)return alert('Сначала привяжите товар.');if(available(p)<qty)return alert('На свободном локальном остатке недостаточно товара: нужно '+qty+' шт., доступно '+available(p)+' шт.');
 if(!confirm('Перевести '+qty+' шт. «'+p.name+'» из локального склада в «В пути Ozon FBO»?'))return;
 const cost=typeof fifoConsume==='function'?fifoConsume(p.id,qty):{totalCost:qty*(Number(p.cost)||0)};p.stock=Math.max(0,(Number(p.stock)||0)-qty);try{refreshProductAverageCost(p)}catch(_){}
 transfers()[key]={key,productId:p.id,sku:String(row.item.sku||''),qty,account:current.account,orderId:String(current.order.order_id),supplyId:String(row.s.supply_id||''),bundleId:String(row.s.bundle_id||''),warehouseId:String(row.s.storage_warehouse?.warehouse_id||''),warehouseName:warehouseLabel(row.s),crossdock:Boolean(row.s.is_crossdock),sentAt:Date.now(),unitCost:qty?Number(cost?.totalCost||0)/qty:0,status:'in_transit'};
 log('FBO Ozon',p.id,-qty,'в пути на Ozon FBO · '+warehouseLabel(row.s)+' · заявка '+String(current.order.order_number||current.order.order_id));save();render();renderOrder();
};
window.accountWholeOzonFboOrder=()=>{
 const rows=allLines(current.order).filter(x=>!transfers()[transferKey(current.account,current.order.order_id,x.s.supply_id,x.s.bundle_id,x.item.sku)]);if(!rows.length)return alert('Эта поставка уже учтена.');
 const unmatched=rows.filter(x=>!matchProduct(current.account,x.item));if(unmatched.length)return alert('Сначала привяжите непривязанные товары: '+unmatched.length+' строк.');
 const groups=new Map();for(const x of rows){const p=matchProduct(current.account,x.item),q=Math.max(0,Number(x.item.quantity)||0);if(!groups.has(p.id))groups.set(p.id,{p,qty:0,rows:[]});const g=groups.get(p.id);g.qty+=q;g.rows.push(x);}
 for(const g of groups.values())if(available(g.p)<g.qty)return alert('Недостаточно свободного остатка «'+g.p.name+'»: нужно '+g.qty+', доступно '+available(g.p)+'.');
 const total=[...groups.values()].reduce((n,g)=>n+g.qty,0);if(!confirm('Учесть отправку '+total+' шт. на '+new Set(rows.map(x=>String(x.s.supply_id))).size+' направлений Ozon FBO? Локальный остаток уменьшится на это количество.'))return;
 for(const g of groups.values()){
  const cost=typeof fifoConsume==='function'?fifoConsume(g.p.id,g.qty):{totalCost:g.qty*(Number(g.p.cost)||0)},unit=g.qty?Number(cost?.totalCost||0)/g.qty:0;g.p.stock=Math.max(0,(Number(g.p.stock)||0)-g.qty);try{refreshProductAverageCost(g.p)}catch(_){}
  for(const x of g.rows){const q=Math.max(0,Number(x.item.quantity)||0),key=transferKey(current.account,current.order.order_id,x.s.supply_id,x.s.bundle_id,x.item.sku);transfers()[key]={key,productId:g.p.id,sku:String(x.item.sku||''),qty:q,account:current.account,orderId:String(current.order.order_id),supplyId:String(x.s.supply_id||''),bundleId:String(x.s.bundle_id||''),warehouseId:String(x.s.storage_warehouse?.warehouse_id||''),warehouseName:warehouseLabel(x.s),crossdock:Boolean(x.s.is_crossdock),sentAt:Date.now(),unitCost:unit,status:'in_transit'};}
  log('FBO Ozon',g.p.id,-g.qty,'в пути на Ozon FBO · '+g.rows.length+' направлений · заявка '+String(current.order.order_number||current.order.order_id));
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
ensureButton();setInterval(ensureButton,1000);
})();
