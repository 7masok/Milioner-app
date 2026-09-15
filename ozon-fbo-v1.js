(()=>{
let data=null,loading=false,loadedAt=0,tab='orders',message='',pollTimer=null;
const baseRender=renderMarketplaceOrders;
const money=(value,currency='RUB')=>new Intl.NumberFormat('ru-RU',{style:'currency',currency,maximumFractionDigits:2}).format(Number(value)||0);
const periodRows=rows=>filterMarketplaceOrdersByPeriod(rows.map(x=>({...x,creationDate:Date.parse(x.created_at||x.operation_date||'')||0})));
const names=()=>{const map=new Map();for(const a of data?.accounts||[])for(const p of a.postings?.rows||[])for(const x of p.products||[])map.set(String(x.sku),x.name);return map;};
function orderHtml(a){
 const rows=periodRows(a.postings?.rows||[]).filter(p=>{const q=String(document.getElementById('orderSearch')?.value||'').toLowerCase();return !q||JSON.stringify([p.posting_number,...(p.products||[]).map(x=>[x.name,x.offer_id])]).toLowerCase().includes(q);});
 const statuses={awaiting_packaging:'Сборка Ozon',awaiting_deliver:'Ожидает доставки',delivering:'Доставка',delivered:'Доставлен',cancelled:'Отменён',arbitration:'Спор',client_arbitration:'Спор покупателя',driver_pickup:'У курьера'};
 return rows.length?rows.slice().reverse().map(p=>'<div class="item"><div><b>Заказ '+esc(p.posting_number)+'</b> · '+esc(statuses[p.status]||p.status)+'</div><div class="muted">'+new Date(p.creationDate).toLocaleString('ru-RU')+'</div>'+(p.products||[]).map(x=>'<div style="margin-top:8px">'+esc(x.name||x.offer_id)+'<div class="muted">'+esc(x.offer_id||x.sku)+' · '+Number(x.quantity||0)+' шт. · '+money(Number(x.price)*Number(x.quantity),x.currency_code||p.financial_data?.currency_code||'RUB')+'</div></div>').join('')+'</div>').join(''):'<div class="empty">За выбранный период заказов нет.</div>';
}
function stockHtml(a){
 const map=names(),q=String(document.getElementById('orderSearch')?.value||'').toLowerCase();
 const rows=(a.stocks?.rows||[]).filter(x=>!q||JSON.stringify([x.offer_id,...(x.stocks||[]).map(s=>map.get(String(s.sku)))]).toLowerCase().includes(q));
 return rows.length?rows.map(x=>{const stocks=x.stocks||[],title=stocks.map(s=>map.get(String(s.sku))).find(Boolean)||x.offer_id||x.product_id;
 return '<div class="item"><b>'+esc(title)+'</b><div class="muted">Артикул '+esc(x.offer_id||'—')+'</div><div>На Ozon: <b>'+stocks.reduce((n,s)=>n+Number(s.present||0),0)+' шт.</b> · В резерве: '+stocks.reduce((n,s)=>n+Number(s.reserved||0),0)+' шт.</div></div>';}).join(''):'<div class="empty">Остатков ФБО нет.</div>';
}
function financeHtml(a){
 const rows=periodRows(a.finance?.rows||[]);
 const amount=rows.reduce((n,x)=>n+Number(x.amount||0),0);
 const sales=rows.reduce((n,x)=>n+Number(x.accruals_for_sale||0),0);
 const commission=rows.reduce((n,x)=>n+Number(x.sale_commission||0),0);
 return '<div class="item"><b>Начислено Ozon: '+money(amount)+'</b><div class="muted">После удержаний Ozon, до себестоимости товара. Это не чистая прибыль.</div><div>Начисления за продажи: '+money(sales)+'</div><div>Комиссия: '+money(commission)+'</div><div class="muted">Сумма операций уже включает услуги, возвраты и другие начисления. Повторно расходы не вычитаются.</div></div>'+
 (rows.length?rows.slice().reverse().map(x=>'<div class="item"><b>'+esc(x.operation_type_name||x.operation_type)+'</b><div>'+money(x.amount)+'</div><div class="muted">'+new Date(x.creationDate).toLocaleDateString('ru-RU')+(x.posting?.posting_number?' · '+esc(x.posting.posting_number):'')+'</div>'+(x.items||[]).map(i=>'<div>'+esc(i.name||i.sku)+'</div>').join('')+'</div>').join(''):'<div class="empty">За выбранный период финансовых операций нет.</div>');
}
function draw(){
 if(selectedOrderMarket!=='Ozon')return;
 const target=document.getElementById('kaspiOrderList');if(!target)return;
 const accounts=data?.accounts||[];
 let qty=0,count=0;const amounts={};
 for(const a of accounts)for(const p of periodRows(a.postings?.rows||[])){count++;if(p.status==='cancelled')continue;for(const x of p.products||[]){qty+=Number(x.quantity||0);const c=x.currency_code||p.financial_data?.currency_code||'RUB';amounts[c]=(amounts[c]||0)+Number(x.price||0)*Number(x.quantity||0);}}
 const amountText=Object.entries(amounts).map(([c,v])=>money(v,c)).join(' + ')||'—';
 for(const id of ['koQty','koTotal']){const el=document.getElementById(id);if(el)el.textContent=qty+' шт.';}
 for(const id of ['koAmount','koMatched']){const el=document.getElementById(id);if(el)el.textContent=amountText;}
 const countEl=document.getElementById('orderCountBadge');if(countEl)countEl.textContent=count;
 const unmatched=document.getElementById('koUnmatchedCard');if(unmatched)unmatched.style.display='none';
 const tabs=[['orders','Заказы'],['stocks','Остатки ФБО'],['finance','Начисления и расходы']].map(([key,label])=>'<button class="btn '+(key===tab?'dark':'')+'" onclick="ozonFboTab(\''+key+'\')">'+label+'</button>').join('');
 target.innerHTML='<div class="actions">'+tabs+'<button class="btn" onclick="ozonFboSync()" '+(data?.syncing?'disabled':'')+'>'+(data?.syncing?'Загружаю…':'Обновить Ozon')+'</button></div><div class="muted" style="margin:8px 0">ФБО · Последние 30 дней · Автообновление каждые 10 минут</div>'+
 (message?'<div class="empty">'+esc(message)+'</div>':'')+
 (!data?'<div class="empty">Загружаю Ozon…</div>':!data.configured?'<div class="empty">Добавьте API-ключ Ozon в настройках.</div>':!accounts.length?'<div class="empty">Первая загрузка Ozon выполняется…</div>':accounts.map(a=>{
 const key=tab==='orders'?'postings':tab==='stocks'?'stocks':'finance',section=a[key];
 return '<h3>'+esc(a.label)+'</h3><div class="muted">'+(section?.updatedAt?'Обновлено '+new Date(section.updatedAt).toLocaleString('ru-RU'):'Данные ещё не загружены')+'</div>'+
 (a.errors?.[key]?'<div class="empty">Не удалось обновить: '+esc(a.errors[key])+(section?' · показаны последние сохранённые данные':'')+'</div>':'')+
 (section?(tab==='orders'?orderHtml(a):tab==='stocks'?stockHtml(a):financeHtml(a)):'');
 }).join(''));
}
async function load(force=false){
 if(loading||(!force&&Date.now()-loadedAt<60000))return;
 loading=true;
 try{data=await apiJson(MILLIONER_API+'/api/ozon-fbo');loadedAt=Date.now();message='';}
 catch(e){message='Не удалось загрузить Ozon: '+String(e.message||e);}
 finally{loading=false;draw();}
 if(data?.syncing||(data?.configured&&!data.accounts.length)){clearTimeout(pollTimer);pollTimer=setTimeout(()=>load(true),5000);}
}
window.ozonFboTab=key=>{tab=key;draw();};
window.ozonFboSync=async()=>{
 try{const response=await fetch(MILLIONER_API+'/api/ozon-sync-now',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});if(!response.ok)throw new Error('HTTP '+response.status);if(data)data.syncing=true;draw();clearTimeout(pollTimer);pollTimer=setTimeout(()=>load(true),3000);}
 catch(e){message=String(e.message||e);draw();}
};
renderMarketplaceOrders=function(){baseRender();const el=document.getElementById('koUnmatchedCard');if(el)el.style.display=selectedOrderMarket==='Ozon'?'none':'';if(selectedOrderMarket==='Ozon'){draw();load();}};
const baseTransition=applyMarketplaceTransitions;
applyMarketplaceTransitions=function(market,feed){if(String(market).startsWith('Ozon'))return {reservedCount:0,soldCount:0,cancelledCount:0};return baseTransition(market,feed);};
setInterval(()=>{if(document.getElementById('home')?.classList.contains('active')&&selectedOrderMarket==='Ozon')load(true);},60000);
})();