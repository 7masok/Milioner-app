(()=>{
'use strict';
window.fboMovementRows=function(rows){
 const byId=new Map(rows.map(r=>[String(r.id),r])),hidden=new Set(),shown=new Map();
 for(const out of rows){if(!['FBO Ozon','FBO WB3'].includes(out.type)||!String(out.id).includes('fbo-out-'))continue;
  const incoming=byId.get(String(out.id).replace('fbo-out-','fbo-in-'));
  if(!incoming||incoming.type!=='приход'||String(incoming.productId)!==String(out.productId)||Number(incoming.date)!==Number(out.date)||!(Number(incoming.qty)>0)||Number(incoming.qty)>-Number(out.qty))continue;
  hidden.add(String(incoming.id));shown.set(String(out.id),{...out,displayFboWarehouse:Number(incoming.qty),displayFboSale:-Number(out.qty)-Number(incoming.qty)});
 }
 return rows.filter(r=>!hidden.has(String(r.id))).map(r=>shown.get(String(r.id))||r);
};
for(const name of ['renderMovement','renderRecent']){const original=window[name];if(typeof original==='function')window[name]=function(...args){const saved=state.movements;try{state.movements=window.fboMovementRows(saved);return original.apply(this,args)}finally{state.movements=saved}}}
const oldBalance=typeof movementBalanceHtml==='function'?movementBalanceHtml:null;
if(oldBalance)movementBalanceHtml=function(m){return m.displayFboWarehouse?'<div class="movement-balance muted">Со склада: '+m.displayFboWarehouse+' шт.'+(m.displayFboSale?' · из продажи: '+m.displayFboSale+' шт.':'')+'</div>':oldBalance(m)};
let snapshot=null,pending=null,selected='Ozon';
try{selected=localStorage.getItem('fboSelectedStoreV2')||'Ozon'}catch{}
if(!['Ozon','WB3'].includes(selected))selected='Ozon';
const e=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const path=()=>MILLIONER_API+(window.WB3_ONLY?'/api/wb3/supplies':'/api/unified/wb3/supplies');
const labels={1:'Подготовка',2:'Запланировано',3:'Готово к отгрузке',4:'Идёт приёмка',5:'Принято WB',6:'Передано WB'};
function shell(){
 window.fboSelectedStore=selected;
 const bar=document.getElementById('fboStoreSwitch');if(bar){bar.hidden=!!window.WB3_ONLY;bar.querySelectorAll('button').forEach(b=>{b.classList.toggle('active',b.dataset.fboStore===selected);b.setAttribute('aria-pressed',String(b.dataset.fboStore===selected))})}
 const own=document.getElementById('wb3SupplyPanel'),ozon=document.getElementById('fboRoot');if(own)own.hidden=selected!=='WB3';if(ozon)ozon.hidden=selected==='WB3';
}
function render(){shell();const box=document.getElementById('wb3SupplyPanel');if(!box||selected!=='WB3')return;
 if(!snapshot){box.innerHTML='<h2>Поставки WB3</h2><p class="muted">Получаем поставки…</p>';return}
 const d=snapshot;
 box.innerHTML='<h2>Поставки WB3</h2>'+(d.error?'<p role="alert">'+e(d.error)+'</p>':'')+(d.supplies||[]).filter(s=>!(d.excluded||[]).includes('preorder:'+s.preorderID)).map(s=>{const key='preorder:'+s.preorderID,r=(d.results||[]).find(r=>r.key===key),receipt=d.receipts?.[key];return '<article class="item" style="margin-bottom:10px"><b>Поставка '+e(s.supplyID||s.preorderID)+'</b><p class="muted">'+e(labels[s.statusID]||'Проверяем статус')+(r?' · '+e(r.message):'')+'</p>'+(receipt?.lines||[]).map(l=>'<div>'+e(l.name||l.barcode)+' · отправлено '+e(l.sent)+(l.accepted===null?'':' · принято '+e(l.accepted))+'</div>').join('')+'</article>'}).join('')+(!d.supplies?.length?'<p class="muted">Поставок пока нет</p>':'');
}
async function load(){if(pending)return pending;pending=(async()=>{const c=new AbortController(),timer=setTimeout(()=>c.abort(),20000);try{const r=await fetch(path(),{cache:'no-store',signal:c.signal}),d=await r.json();if(!r.ok)throw Error(d.error==='login-required'?'Сеанс закончился. Обновите страницу.':d.error||'HTTP '+r.status);snapshot=d;render()}catch(err){const box=document.getElementById('wb3SupplyPanel');if(box&&selected==='WB3'){if(snapshot){render();box.insertAdjacentHTML('beforeend','<p class="muted">Не удалось обновить поставки</p>')}else box.textContent='Поставки WB3: '+String(err.message||err)}}finally{clearTimeout(timer);pending=null}})();return pending}
const base=window.renderFboDashboard;
window.selectFboStore=value=>{if(!['Ozon','WB3'].includes(value))return;selected=value;try{localStorage.setItem('fboSelectedStoreV2',value)}catch{}window.renderFboDashboard()};
window.renderFboDashboard=function(){if(window.WB3_ONLY)selected='WB3';shell();if(selected==='WB3'){render();return load()}return base?.apply(this,arguments)};
setInterval(()=>{if(typeof activeView!=='undefined'&&activeView==='fbo'&&selected==='WB3')load()},30000);
})();
