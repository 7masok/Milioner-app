(()=>{
let data=null,loading=false,loadedAt=0,message='',pollTimer=null;
let fboByOffer=new Map(),ozonReportActive=String(state?.settings?.reportMarket||'')==='Ozon';
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
const periodRows=rows=>filterMarketplaceOrdersByPeriod(rows.map(x=>({...x,creationDate:Date.parse(x.created_at||x.operation_date||'')||0})));
function rebuildFboMap(){
 const next=new Map();
 for(const account of data?.accounts||[])for(const row of account.stocks?.rows||[]){
  const offer=String(row.offer_id||'').trim();if(!offer)continue;
  const qty=(row.stocks||[]).filter(s=>String(s.type||'').toLowerCase()==='fbo').reduce((n,s)=>n+Math.max(0,Number(s.present)||0),0);
  next.set(offer,(next.get(offer)||0)+qty);
 }
 fboByOffer=next;
}
function productOzonOffers(p){return [...new Set([p?.ozon,...(Array.isArray(p?.ozonAliases)?p.ozonAliases:[])].map(x=>String(x||'').trim()).filter(Boolean))];}
function ozonFboQtyForProduct(p){return productOzonOffers(p).reduce((n,offer)=>n+(fboByOffer.get(offer)||0),0);}
function updateFboMetric(){const el=document.getElementById('productFboQty');if(el)el.textContent=[...fboByOffer.values()].reduce((a,x)=>a+x,0).toLocaleString('ru-RU')+' шт.';}
function orderHtml(a){
 const rows=periodRows(a.postings?.rows||[]).filter(p=>{const q=String(document.getElementById('orderSearch')?.value||'').toLowerCase();return !q||JSON.stringify([p.posting_number,...(p.products||[]).map(x=>[x.name,x.offer_id])]).toLowerCase().includes(q);});
 const statuses={awaiting_packaging:'Сборка Ozon',awaiting_deliver:'Ожидает доставки',delivering:'Доставка',delivered:'Доставлен',cancelled:'Отменён',arbitration:'Спор',client_arbitration:'Спор покупателя',driver_pickup:'У курьера'};
 return rows.length?rows.slice().reverse().map(p=>'<div class="item"><div><b>Заказ '+esc(p.posting_number)+'</b> · '+esc(statuses[p.status]||p.status)+'</div><div class="muted">'+new Date(p.creationDate).toLocaleString('ru-RU')+'</div>'+(p.products||[]).map(x=>'<div style="margin-top:8px">'+esc(x.name||x.offer_id)+'<div class="muted">'+esc(x.offer_id||x.sku)+' · '+Number(x.quantity||0)+' шт. · '+money(Number(x.price)*Number(x.quantity),x.currency_code||p.financial_data?.currency_code)+'</div></div>').join('')+'</div>').join(''):'<div class="empty">За выбранный период заказов нет.</div>';
}
function draw(){
 if(selectedOrderMarket!=='Ozon')return;
 const target=document.getElementById('kaspiOrderList');if(!target)return;
 const accounts=data?.accounts||[];let qty=0,count=0;const amounts={};
 for(const a of accounts)for(const p of periodRows(a.postings?.rows||[])){count++;if(p.status==='cancelled')continue;for(const x of p.products||[]){qty+=Number(x.quantity||0);const c=String(x.currency_code||p.financial_data?.currency_code||'').toUpperCase()||'—';amounts[c]=(amounts[c]||0)+Number(x.price||0)*Number(x.quantity||0);}}
 const amountText=Object.entries(amounts).map(([c,v])=>c==='—'?Number(v).toLocaleString('ru-RU'):money(v,c)).join(' + ')||'—';
 for(const id of ['koQty','koTotal']){const el=document.getElementById(id);if(el)el.textContent=qty+' шт.';}
 for(const id of ['koAmount','koMatched']){const el=document.getElementById(id);if(el)el.textContent=amountText;}
 const countEl=document.getElementById('orderCountBadge');if(countEl)countEl.textContent=count;
 const unmatched=document.getElementById('koUnmatchedCard');if(unmatched)unmatched.style.display='none';
 target.innerHTML='<div class="actions"><button class="btn dark">Заказы</button><button class="btn" onclick="ozonFboSync()" '+(data?.syncing?'disabled':'')+'>'+(data?.syncing?'Загружаю…':'Обновить Ozon')+'</button></div><div class="muted" style="margin:8px 0">ФБО · Последние 30 дней · Автообновление каждые 10 минут</div>'+
 (message?'<div class="empty">'+esc(message)+'</div>':'')+
 (!data?'<div class="empty">Загружаю Ozon…</div>':!data.configured?'<div class="empty">Добавьте API-ключ Ozon в настройках.</div>':!accounts.length?'<div class="empty">Первая загрузка Ozon выполняется…</div>':accounts.map(a=>{const section=a.postings;return '<h3>'+esc(a.label)+'</h3><div class="muted">'+(section?.updatedAt?'Обновлено '+new Date(section.updatedAt).toLocaleString('ru-RU'):'Данные ещё не загружены')+'</div>'+(a.errors?.postings?'<div class="empty">Не удалось обновить: '+esc(a.errors.postings)+(section?' · показаны последние сохранённые данные':'')+'</div>':'')+(section?orderHtml(a):'');}).join(''));
}
async function load(force=false){
 if(loading)return data;if(!force&&data&&Date.now()-loadedAt<60000)return data;
 loading=true;
 try{data=await apiJson(MILLIONER_API+'/api/ozon-fbo');loadedAt=Date.now();message='';rebuildFboMap();updateFboMetric();}
 catch(e){message='Не удалось загрузить Ozon: '+String(e.message||e);}
 finally{loading=false;draw();}
 if(data?.syncing||(data?.configured&&!data.accounts.length)){clearTimeout(pollTimer);pollTimer=setTimeout(()=>load(true),5000);}
 return data;
}
window.ozonFboSync=async()=>{
 try{const response=await fetch(MILLIONER_API+'/api/ozon-sync-now',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});if(!response.ok)throw new Error('HTTP '+response.status);if(data)data.syncing=true;draw();clearTimeout(pollTimer);pollTimer=setTimeout(()=>load(true),3000);}
 catch(e){message=String(e.message||e);draw();}
};
renderMarketplaceOrders=function(){baseRenderOrders();const el=document.getElementById('koUnmatchedCard');if(el)el.style.display=selectedOrderMarket==='Ozon'?'none':'';if(selectedOrderMarket==='Ozon'){draw();load();}};
applyMarketplaceTransitions=function(market,feed){if(String(market).startsWith('Ozon'))return {reservedCount:0,soldCount:0,cancelledCount:0};return baseTransition(market,feed);};
productCard=function(p,profit,d,stock){
 let html=baseProductCard(p,profit,d,stock),qty=ozonFboQtyForProduct(p);if(!qty)return html;
 const line='<div class="muted" style="color:#1c62bb">На FBO Ozon: '+qty+' шт.</div>';
 return html.replace('</div><div class="right" style="min-width:112px">',line+'</div><div class="right" style="min-width:112px">');
};
renderProducts=function(rebuildStats=false){
 baseRenderProducts(rebuildStats);updateFboMetric();
 if(!data||Date.now()-loadedAt>=60000)load().then(()=>{updateFboMetric();if(document.getElementById('products')?.classList.contains('active'))baseRenderProducts(false);});
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
 if(!model.rows.length){box.innerHTML='<div class="empty">За выбранный период финансовых операций Ozon нет.</div><div class="link-note">Сервер хранит финансовые данные Ozon за последние 30 дней.</div>';return;}
 const cards=g.map(x=>'<div class="item" style="margin-bottom:8px"><div class="row"><div class="grow"><b>'+esc(x.currency==='—'?'Валюта не указана':x.currency)+'</b><div class="muted">Начисления после операций Ozon, до себестоимости и расходов бизнеса</div></div><b>'+ (x.currency==='—'?Number(x.net).toLocaleString('ru-RU',{maximumFractionDigits:2}):money(x.net,x.currency))+'</b></div><div class="row" style="margin-top:8px"><span class="grow muted">Продажи</span><b>'+ (x.currency==='—'?Number(x.sales).toLocaleString('ru-RU',{maximumFractionDigits:2}):money(x.sales,x.currency))+'</b></div><div class="row" style="margin-top:6px"><span class="grow muted">Комиссия Ozon</span><b>'+ (x.currency==='—'?Number(x.commission).toLocaleString('ru-RU',{maximumFractionDigits:2}):money(x.commission,x.currency))+'</b></div><div class="row" style="margin-top:6px"><span class="grow muted">Доставка</span><b>'+ (x.currency==='—'?Number(x.delivery).toLocaleString('ru-RU',{maximumFractionDigits:2}):money(x.delivery,x.currency))+'</b></div><div class="row" style="margin-top:6px"><span class="grow muted">Услуги</span><b>'+ (x.currency==='—'?Number(x.services).toLocaleString('ru-RU',{maximumFractionDigits:2}):money(x.services,x.currency))+'</b></div></div>').join('');
 box.innerHTML=cards+'<button class="btn dark full" onclick="openOzonFinanceDetails()">Все операции Ozon</button><div class="link-note"><b>Это не чистая прибыль.</b> Здесь показаны финансовые начисления Ozon. Себестоимость товара, налоги и прочие расходы бизнеса не вычитаются. Данные Ozon сейчас хранятся за последние 30 дней.</div>';
}
window.openOzonFinanceDetails=async()=>{await load();const model=financeModel(reportPeriod);const rows=model.rows.slice().sort((a,b)=>Date.parse(b.operation_date||'')-Date.parse(a.operation_date||''));const body=rows.length?rows.map(r=>'<div class="item" style="margin-top:8px"><div class="row"><div class="grow"><b>'+esc(r.operation_type_name||'Операция Ozon')+'</b><div class="muted">'+new Date(r.operation_date).toLocaleDateString('ru-RU')+(r.posting?.posting_number?' · заказ '+esc(r.posting.posting_number):'')+(r._account?' · '+esc(r._account):'')+'</div></div><b>'+money(r.amount,r.currency_code||r.currency)+'</b></div></div>').join(''):'<div class="empty">Операций нет</div>';showSheet('<h3>Ozon FBO · финансовые операции</h3>'+body+'<div class="link-note">Суммы показаны в валюте, которую вернул Ozon. Это не расчёт чистой прибыли.</div>');};
window.setReportMarket=function(market){if(market==='Ozon'){ozonReportActive=true;state.settings.reportMarket='Ozon';try{save();}catch(_){}renderOzonReport();return;}ozonReportActive=false;return baseSetReportMarket?.(market);};
window.renderReports=function(){if(ozonReportActive||String(state.settings?.reportMarket||'')==='Ozon'){ozonReportActive=true;renderReportCustomRange();document.querySelectorAll('[data-report-period]').forEach(b=>b.classList.toggle('active',Number(b.dataset.reportPeriod)===reportPeriodPreset));renderOzonReport();return;}return baseRenderReports?.();};
function ensureReportTab(){const tabs=document.getElementById('reportMarketTabs');if(tabs&&!tabs.querySelector('[data-report-market="Ozon"]'))tabs.insertAdjacentHTML('beforeend','<button class="market-tab" data-report-market="Ozon" onclick="setReportMarket(\'Ozon\')">Ozon</button>');}
ensureReportTab();
load().then(()=>{updateFboMetric();if(document.getElementById('products')?.classList.contains('active'))baseRenderProducts(false);if(ozonReportActive&&document.getElementById('reports')?.classList.contains('active'))renderOzonReport();});
setInterval(()=>{if(document.getElementById('home')?.classList.contains('active')&&selectedOrderMarket==='Ozon')load(true);},60000);
})();
