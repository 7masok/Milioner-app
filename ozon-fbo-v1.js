(()=>{
let data=null,loading=false,loadedAt=0,message='',pollTimer=null;
let fboByKey=new Map(),fboTotal=0,ozonReportActive=String(state?.settings?.reportMarket||'')==='Ozon';
const baseRenderOrders=renderMarketplaceOrders;
const baseTransition=applyMarketplaceTransitions;
const baseProductCard=productCard;
const baseRenderProducts=renderProducts;
const baseSetReportMarket=window.setReportMarket;
const baseRenderReports=window.renderReports;
const money=(value,currency)=>{
 const code=String(currency||'').toUpperCase();
 if(/^[A-Z]{3}$/.test(code))return new Intl.NumberFormat('ru-RU',{style:'currency',currency:code,maximumFractionDigits:2}).format(Number(value)||0);
 return Number(value||0).toLocaleString('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2});
};
function rebuildFboMap(){
 const next=new Map();let total=0;
 for(const account of data?.accounts||[])for(const row of account.stocks?.rows||[]){
  const qty=(row.stocks||[]).filter(s=>String(s.type||'').toLowerCase()==='fbo').reduce((n,s)=>n+Math.max(0,Number(s.present)||0),0);
  total+=qty;
  const keys=[row.offer_id,row.product_id,...(row.stocks||[]).map(s=>s.sku)].map(x=>String(x||'').trim()).filter(Boolean);
  for(const key of new Set(keys))next.set(key,(next.get(key)||0)+qty);
 }
 fboByKey=next;fboTotal=total;
}
function productOzonKeys(p){return [...new Set([p?.ozon,...(Array.isArray(p?.ozonAliases)?p.ozonAliases:[])].map(x=>String(x||'').trim()).filter(Boolean))];};
function ozonFboQtyForProduct(p){return productOzonKeys(p).reduce((n,key)=>n+(fboByKey.get(key)||0),0);}
window.ozonFboQtyForProduct=ozonFboQtyForProduct;
window.ozonFboDataReady=()=>Boolean(data);
function updateFboMetric(){const el=document.getElementById('productFboQty');if(el)el.textContent=data?fboTotal.toLocaleString('ru-RU')+' шт.':'—';}
function populateOzonOrderFeed(){
 if(!data?.accounts)return;
 const feed=Array.isArray(state.ozonOrderFeed)?state.ozonOrderFeed:(state.ozonOrderFeed=[]);
 const ozonKeys=new Map();
 for(const account of data.accounts){
  for(const posting of account.postings?.rows||[]){
   const postingNumber=String(posting.posting_number||'').trim();
   if(!postingNumber)continue;
   for(let lineIdx=0;lineIdx<(posting.products||[]).length;lineIdx++){
    const product=posting.products[lineIdx];
    const offerIdPreferred=String(product.offer_id||'').trim();
    const sku=offerIdPreferred||String(product.sku||'').trim();
    const creationDate=Date.parse(posting.created_at||posting.in_process_at||'')||0;
    const deliveredDate=Date.parse(posting.delivered_date||'')||0;
    const entryId=postingNumber+'_'+sku+'_'+lineIdx;
    const code=postingNumber;
    const orderId=postingNumber;
    const productName=String(product.name||product.offer_id||'').trim();
    const qty=Math.max(0,Number(product.quantity)||0);
    const unitPrice=Number(product.price)||0;
    const totalPrice=unitPrice*qty;
    const status=String(posting.status||'').toLowerCase()||'new';
    const line={
     market:'Ozon',
     orderId,
     code,
     entryId,
     sku,
     productName,
     qty,
     unitPrice,
     totalPrice,
     creationDate,
     deliveredDate,
     status,
     productId:null
    };
    const key=entryId;
    ozonKeys.set(key,line);
   }
  }
 }
 for(let i=feed.length-1;i>=0;i--){const lineKey=feed[i].entryId;if(!ozonKeys.has(lineKey)){feed.splice(i,1);}}
 for(const [key,newLine] of ozonKeys){const existing=feed.find(x=>x.entryId===key);if(existing){Object.assign(existing,newLine);}else{feed.push(newLine);}}
}
function resolveOzonProductIds(){
 if(!data?.accounts)return;
 const ozonStockMap=new Map();
 for(const account of data.accounts){
  for(const stock of account.stocks?.rows||[]){
   const offerIdStr=String(stock.offer_id||'').trim();
   const productIdStr=String(stock.product_id||'').trim();
   const skus=((stock.stocks||[]).map(s=>String(s.sku||'').trim()).filter(Boolean));
   const keys=[offerIdStr,productIdStr,...skus];
   for(const k of keys.filter(Boolean)){ozonStockMap.set(k,[offerIdStr,productIdStr]);}
  }
 }
 for(const line of state.ozonOrderFeed||[]){
  if(line.productId)continue;
  const sku=String(line.sku||'').trim();
  const ozonAllocations=ozonStockMap.get(sku)||[];
  let matched=null;
  for(const p of state.products||[]){
   const keys=productOzonKeys(p);
   if(keys.length===0)continue;
   const offerIdMatch=ozonAllocations[0]&&keys.includes(ozonAllocations[0]);
   const skuMatch=keys.includes(sku);
   if(offerIdMatch||skuMatch){
    matched=p.id;
    break;
   }
  }
  if(matched){line.productId=matched;}
 }
}
function updateOzonHeaderIndicator(){
 const syncEl=document.querySelector('.sync');
 if(!syncEl)return;
 const dot=document.getElementById('dotOzonTop');
 if(!dot)return;
 const statusEl=document.getElementById('ozonTopStatus');
 if(!statusEl)return;
 let status='',text='';
 if(!data||loading){
  status='warn';
  text='подключение...';
 }else if(!data.configured){
  status='off';
  text='не подключён';
 }else if(message){
  status='bad';
  text='ошибка';
 }else if(data.syncing){
  status='warn';
  text='синхронизация...';
 }else if(data.configured&&(data.accounts||[]).length>0){
  status='';
  text='работает';
 }else{
  status='warn';
  text='ожидает данные';
 }
 dot.className='dot '+status;
 statusEl.textContent=text;
}
function ensureOzonHeaderIndicator(){
 const syncEl=document.querySelector('.sync');
 if(!syncEl)return;
 if(document.getElementById('dotOzonTop')){updateOzonHeaderIndicator();return;}
 syncEl.insertAdjacentHTML('beforeend',' · <span id="dotOzonTop" class="dot warn"></span>Ozon: <span id="ozonTopStatus">подключение...</span>');
 updateOzonHeaderIndicator();
}
async function load(force=false){
 if(loading)return data;if(!force&&data&&Date.now()-loadedAt<60000)return data;
 loading=true;
 updateOzonHeaderIndicator();
 try{
  data=await apiJson(MILLIONER_API+'/api/ozon-fbo');
  loadedAt=Date.now();
  message='';
  rebuildFboMap();
  populateOzonOrderFeed();
  resolveOzonProductIds();
  updateFboMetric();
  if(document.getElementById('products')?.classList.contains('active')){if(typeof invalidateProductRenderStats==='function')invalidateProductRenderStats();baseRenderProducts(false);}
 }
 catch(e){
  message='Не удалось загрузить Ozon: '+String(e.message||e);
 }
 finally{
  loading=false;
  updateOzonHeaderIndicator();
 }
 if(data?.syncing||(data?.configured&&!data.accounts.length)){
  clearTimeout(pollTimer);
  pollTimer=setTimeout(()=>load(true),5000);
 }
 return data;
}
window.ozonFboPaintStatus=updateOzonHeaderIndicator;
window.ozonFboRefreshStatus=async()=>{await load();updateOzonHeaderIndicator();return data;};
window.ozonFboSync=async()=>{
 try{
  const response=await fetch(MILLIONER_API+'/api/ozon-sync-now',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  if(!response.ok)throw new Error('HTTP '+response.status);
  if(data)data.syncing=true;
  updateOzonHeaderIndicator();
  clearTimeout(pollTimer);
  pollTimer=setTimeout(()=>load(true),3000);
 }
 catch(e){
  message=String(e.message||e);
  updateOzonHeaderIndicator();
 }
};
renderMarketplaceOrders=function(){
 if(selectedOrderMarket!=='Ozon'){
  return baseRenderOrders();
 }
 const target=document.getElementById('kaspiOrderList');
 if(!target)return;
 if(data&&(data.accounts||[]).length>0){
  populateOzonOrderFeed();
  resolveOzonProductIds();
  return baseRenderOrders();
 }
 target.innerHTML='<div class="empty">Загружаю Ozon...</div>';
 load().then(()=>{
  if(selectedOrderMarket==='Ozon'){
   if(message){
    target.innerHTML='<div class="empty">'+esc(message)+'</div>';
   }else{
    populateOzonOrderFeed();
    resolveOzonProductIds();
    baseRenderOrders();
   }
  }
 });
};
applyMarketplaceTransitions=function(market,feed){if(String(market).startsWith('Ozon'))return {reservedCount:0,soldCount:0,cancelledCount:0};return baseTransition(market,feed);};
productCard=function(...args){
 const p=args[0],inventory=args[5]||null;let html=baseProductCard(...args),keys=productOzonKeys(p);if(!keys.length)return html;
 const qty=data?Math.max(0,Number(inventory?.fbo??ozonFboQtyForProduct(p))||0):null,line='<span style="color:#1c62bb;font-weight:700">FBO Ozon: '+(qty===null?'—':qty+' шт.')+'</span>';
 return html.replace('<div class="product-stock-secondary">','<div class="product-stock-secondary">'+line);
};
renderProducts=function(rebuildStats=false){
 baseRenderProducts(rebuildStats);updateFboMetric();
 if((!data||Date.now()-loadedAt>=60000)&&!loading)load().catch(error=>console.warn('Ozon product refresh',error));
};
function reportBounds(days){const raw=Number(days);if(raw===0)return reportCustomBounds();const d=new Date();d.setHours(0,0,0,0);const today=d.getTime();if(raw===-1)return{start:today-86400000,end:today};const n=Math.max(1,raw||1);return{start:today-(n-1)*86400000,end:today+86400000};}
function financeModel(days){
 const {start,end}=reportBounds(days),rows=[];
 for(const a of data?.accounts||[])for(const r of a.finance?.rows||[]){const t=Date.parse(r.operation_date||'');if(t>=start&&t<end)rows.push({...r,_account:a.label||a.account||'Ozon'});}
 const groups=new Map();
 for(const r of rows){const c=String(r.currency_code||r.currency||'').toUpperCase()||'—';let g=groups.get(c);if(!g){g={currency:c,sales:0,commission:0,delivery:0,services:0,other:0,net:0,rows:[]};groups.set(c,g);}const a=Number(r.amount)||0,name=String(r.operation_type_name||'').toLowerCase();g.net+=a;g.rows.push(r);if(Number(r.accruals_for_sale)||name==='продажа')g.sales+=Number(r.accruals_for_sale)||a;else if(Number(r.sale_commission)||name.includes('комисс'))g.commission+=Number(r.sale_commission)||a;else if(name.includes('достав')||name.includes('логист'))g.delivery+=a;else if(name.includes('услуг')||name.includes('хран')||name.includes('приём')||name.includes('эквайр'))g.services+=a;else g.other+=a;}
 return{rows,groups:[...groups.values()]};
}
function multiMoney(groups,key){return groups.length?groups.map(g=>g.currency==='—'?Number(g[key]||0).toLocaleString('ru-RU',{maximumFractionDigits:2}):money(g[key],g.currency)).join(' + '):'—';}

function replenishmentRows(){
 const rows=[];
 for(const account of data?.accounts||[]){
  const analytics=account.analytics||{},updatedAt=Number(analytics.updatedAt||0),stale=Boolean(analytics.stale),error=String(analytics.lastError||'');
  for(const row of analytics.replenishment?.rows||[])rows.push({...row,_account:account.label||account.account||'Ozon',_updatedAt:updatedAt,_stale:stale,_error:error});
 }
 return rows;
}
function replenishmentUrgency(row){
 if(row?.exact&&Number(row?.sendQty)>0)return 0;
 if(Number(row?.shortageNow)>0)return 1;
 return 2;
}
function replenishmentGroups(rows){
 const groups=new Map();
 for(const row of rows){
  const key=[row?._account||'',row?.sku||'',row?.offerId||'',row?.name||''].join('|');
  if(!groups.has(key))groups.set(key,{key,name:row?.name||row?.offerId||row?.sku||'Товар',account:row?._account||'Ozon',rows:[]});
  groups.get(key).rows.push(row);
 }
 const result=[...groups.values()].map(group=>{
  group.rows.sort((a,b)=>replenishmentUrgency(a)-replenishmentUrgency(b)
   +(Number(a?.sendAt||Number.MAX_SAFE_INTEGER)-Number(b?.sendAt||Number.MAX_SAFE_INTEGER))
   +(Number(a?.daysWithIncoming??999999)-Number(b?.daysWithIncoming??999999))
   ||String(a?.clusterName||'').localeCompare(String(b?.clusterName||''),'ru'));
  group.totalSend=group.rows.reduce((sum,row)=>sum+(row?.exact?Math.max(0,Number(row?.sendQty)||0):0),0);
  group.needCount=group.rows.filter(row=>replenishmentUrgency(row)<2).length;
  group.shortage=group.rows.reduce((sum,row)=>sum+(!row?.exact?Math.max(0,Number(row?.shortageNow)||0):0),0);
  group.earliestSend=Math.min(...group.rows.map(row=>Number(row?.sendAt)||Number.MAX_SAFE_INTEGER));
  group.urgency=Math.min(...group.rows.map(replenishmentUrgency));
  return group;
 });
 return result.sort((a,b)=>a.urgency-b.urgency+(a.earliestSend-b.earliestSend)+(b.totalSend-a.totalSend)||a.name.localeCompare(b.name,'ru'));
}
function shortDays(value){
 const n=Number(value);if(!Number.isFinite(n))return '—';
 if(n>=999)return '999+';
 return n.toLocaleString('ru-RU',{maximumFractionDigits:1});
}
function dateLabel(value){
 const n=Number(value);if(!Number.isFinite(n)||n<=0)return '—';
 const d=new Date(n),today=new Date();today.setHours(0,0,0,0);const tomorrow=today.getTime()+86400000;
 if(d.getTime()>=today.getTime()&&d.getTime()<tomorrow)return 'сегодня';
 return d.toLocaleDateString('ru-RU',{day:'2-digit',month:'2-digit'});
}
function renderReplenishmentCluster(row,index){
 const incoming=Math.max(0,Number(row?.incomingKnown)||0);
 const extra=index>=2?' ozon-cluster-extra':'';
 const action=row?.exact
  ? '<b>'+(Math.max(0,Number(row?.sendQty)||0))+' шт.</b><small>'+dateLabel(row?.sendAt)+'</small>'
  : Number(row?.shortageNow)>0
    ? '<b>≈ '+Math.max(0,Number(row.shortageNow)||0)+' шт.</b><small>дефицит</small>'
    : '<b>0 шт.</b><small>не нужно</small>';
 return '<div class="ozon-cluster-row'+extra+'"><div class="grow"><b>'+esc(row?.clusterName||('Кластер '+(row?.clusterId||'')))+'</b>'+
  '<div class="muted">ост '+Math.max(0,Number(row?.available)||0)+' · '+shortDays(row?.daysLeft)+' дн. · в пути '+incoming+'</div></div>'+
  '<div class="ozon-cluster-action">'+action+'</div></div>';
}
window.toggleOzonReplenishmentGroup=function(button){
 const group=button?.closest?.('.ozon-product-group');if(!group)return;
 const expanded=group.classList.toggle('expanded'),more=Number(button?.dataset?.more)||0;
 button.textContent=expanded?'Свернуть':'Ещё '+more+' '+(more===1?'кластер':more<5?'кластера':'кластеров');
};
function renderReplenishmentBlock(){
 const rows=replenishmentRows(),groups=replenishmentGroups(rows);
 const analytics=(data?.accounts||[]).map(a=>a.analytics).filter(Boolean);
 const updated=Math.max(0,...analytics.map(a=>Number(a.updatedAt||0)));
 const stale=analytics.some(a=>a.stale),errors=analytics.map(a=>String(a.lastError||'')).filter(Boolean);
 if(!rows.length){
  const note=errors.length?'Кластерная аналитика пока недоступна · '+esc(errors[0]):'Кластерная аналитика Ozon ещё не загружена.';
  return '<div class="item ozon-replenishment"><div class="row"><b>Пополнение FBO · 14 дней</b></div><div class="muted" style="margin-top:6px">'+note+'</div></div>';
 }
 const cards=groups.map(group=>{
  const more=Math.max(0,group.rows.length-2);
  const nearest=Number.isFinite(group.earliestSend)&&group.earliestSend<Number.MAX_SAFE_INTEGER?dateLabel(group.earliestSend):'';
  const summary=group.totalSend>0
   ? group.rows.length+' кл. · отправить '+group.totalSend+' шт.'+(nearest?' · '+nearest:'')
   : group.shortage>0
    ? group.rows.length+' кл. · дефицит ≈ '+group.shortage+' шт.'
    : group.rows.length+' кл. · запас достаточный';
  return '<div class="ozon-product-group"><div class="ozon-product-head"><div class="grow"><b>'+esc(group.name)+'</b><div class="muted">'+esc(summary)+'</div></div></div>'+
   '<div class="ozon-cluster-list">'+group.rows.map(renderReplenishmentCluster).join('')+'</div>'+
   (more?'<button class="ozon-cluster-more" data-more="'+more+'" onclick="toggleOzonReplenishmentGroup(this)">Ещё '+more+' '+(more===1?'кластер':more<5?'кластера':'кластеров')+'</button>':'')+
   '</div>';
 }).join('');
 const status=groups.length+' товаров · '+rows.length+' кластеров'+(updated?' · '+new Date(updated).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'}):'')+(stale?' · сохранённые':'');
 return '<div class="item ozon-replenishment"><div class="row"><div class="grow"><b>Пополнение FBO · 14 дней</b><div class="muted">'+esc(status)+'</div></div></div>'+
  cards+'<div class="muted ozon-replenishment-foot">Учитываем остаток и уже известный товар в пути.</div></div>';
}
async function renderOzonReport(){
 ozonReportActive=true;state.settings.reportMarket='Ozon';
 document.querySelectorAll('[data-report-market]').forEach(b=>b.classList.toggle('active',b.dataset.reportMarket==='Ozon'));
 const title=document.getElementById('reportMarketTitle');if(title)title.textContent='Ozon FBO';
 const feesLabel=document.getElementById('rFeesLabel');if(feesLabel)feesLabel.textContent='Расходы Ozon';
 const adsLabel=document.getElementById('rAdsLabel');if(adsLabel)adsLabel.textContent='Реклама';
 const box=document.getElementById('mpReport');if(box)box.innerHTML='<div class="empty">Загружаю финансы Ozon…</div>';
 await load();const model=financeModel(reportPeriod),g=model.groups;
 const set=(id,v)=>{const e=document.getElementById(id);if(e)e.textContent=v;};
 set('rRevenue',multiMoney(g,'sales'));set('rCost','—');set('rFees',multiMoney(g,'commission'));set('rAds','—');set('rProfit','не считается');
 if(!box)return;
 const replenishment=renderReplenishmentBlock();
 if(!model.rows.length){box.innerHTML=replenishment+'<div class="empty">За выбранный период финансовых операций Ozon нет.</div><div class="link-note">Сервер хранит финансовые данные Ozon за последние 30 дней.</div>';return;}
 const cards=g.map(x=>'<div class="item" style="margin-bottom:8px"><div class="row"><div class="grow"><b>'+esc(x.currency==='—'?'Валюта не указана':x.currency)+'</b><div class="muted">Начисления после операций Ozon, до себестоимости и расходов бизнеса</div></div><b>'+ (x.currency==='—'?Number(x.net).toLocaleString('ru-RU',{maximumFractionDigits:2}):money(x.net,x.currency))+'</b></div><div class="row" style="margin-top:8px"><span class="grow muted">Продажи</span><b>'+ (x.currency==='—'?Number(x.sales).toLocaleString('ru-RU',{maximumFractionDigits:2}):money(x.sales,x.currency))+'</b></div><div class="row" style="margin-top:6px"><span class="grow muted">Комиссия Ozon</span><b>'+ (x.currency==='—'?Number(x.commission).toLocaleString('ru-RU',{maximumFractionDigits:2}):money(x.commission,x.currency))+'</b></div><div class="row" style="margin-top:6px"><span class="grow muted">Доставка</span><b>'+ (x.currency==='—'?Number(x.delivery).toLocaleString('ru-RU',{maximumFractionDigits:2}):money(x.delivery,x.currency))+'</b></div><div class="row" style="margin-top:6px"><span class="grow muted">Услуги</span><b>'+ (x.currency==='—'?Number(x.services).toLocaleString('ru-RU',{maximumFractionDigits:2}):money(x.services,x.currency))+'</b></div></div>').join('');
 box.innerHTML=replenishment+cards+'<button class="btn dark full" onclick="openOzonFinanceDetails()">Все операции Ozon</button><div class="link-note"><b>Это не чистая прибыль.</b> Здесь показаны финансовые начисления Ozon. Себестоимость товара, налоги и прочие расходы бизнеса не вычитаются. Данные Ozon сейчас хранятся за последние 30 дней.</div>';
}
window.openOzonFinanceDetails=async()=>{await load();const model=financeModel(reportPeriod);const rows=model.rows.slice().sort((a,b)=>Date.parse(b.operation_date||'')-Date.parse(a.operation_date||''));const body=rows.length?rows.map(r=>'<div class="item" style="margin-top:8px"><div class="row"><div class="grow"><b>'+esc(r.operation_type_name||'Операция Ozon')+'</b><div class="muted">'+new Date(r.operation_date).toLocaleDateString('ru-RU')+(r.posting?.posting_number?' · заказ '+esc(r.posting.posting_number):'')+(r._account?' · '+esc(r._account):'')+'</div></div><b>'+money(r.amount,r.currency_code||r.currency)+'</b></div></div>').join(''):'<div class="empty">Операций нет</div>';showSheet('<h3>Ozon FBO · финансовые операции</h3>'+body+'<div class="link-note">Суммы показаны в валюте, которую вернул Ozon. Это не расчёт чистой прибыли.</div>');};
window.setReportMarket=function(market){ozonReportActive=market==='Ozon';return baseSetReportMarket?.(market);};
window.renderReports=function(){if(ozonReportActive)return renderOzonReport();return baseRenderReports?.();};
function ensureReportTab(){const tabs=document.getElementById('reportMarketTabs');if(tabs&&!tabs.querySelector('[data-report-market="Ozon"]'))tabs.insertAdjacentHTML('beforeend','<button class="market-tab" data-report-market="Ozon" onclick="setReportMarket(\'Ozon\')">Ozon</button>');}
ensureReportTab();
ensureOzonHeaderIndicator();
setInterval(()=>{if(document.getElementById('home')?.classList.contains('active')&&selectedOrderMarket==='Ozon')load(true);},60000);
})();