(()=>{
'use strict';
let snapshot=null,loading=null;
const e=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function request(url,body){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);try{const r=await fetch(url,{cache:'no-store',signal:controller.signal,...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});const d=await r.json();if(!r.ok)throw Error(d.error||'HTTP '+r.status);return d}finally{clearTimeout(timer)}}
const path=()=>window.WB3_ONLY?'/api/wb3/supplies':'/api/unified/wb3/supplies';
const labels={1:'Не запланировано',2:'Запланировано',3:'Отгрузка разрешена',4:'Идёт приёмка',5:'Принято',6:'Отгружено на воротах'};
function render(){
 const box=document.getElementById('wb3SupplyPanel');if(!box)return;
 if(!snapshot){box.innerHTML='<div class="item">Поставки WB3 · загружаю…</div>';return}
 const d=snapshot;
 box.innerHTML=`<details class="item" style="margin-bottom:16px" ${window.WB3_ONLY?'open':''}><summary><b>WB3 · поставки FBO</b> · ${d.enabled?'автоучёт включён':'автоучёт выключен'}</summary><p class="muted">Резерв до отгрузки. Списание по подтверждению WB. При продаже повторного списания нет.</p>${d.error?`<p role="alert">${e(d.error)}</p>`:''}<button type="button" class="btn" id="wb3SupplyToggle">${d.enabled?'Выключить автоучёт':'Включить автоучёт'}</button>${!d.fetchedAt?'<p class="muted">Сервер получает список поставок</p>':(d.supplies||[]).map(s=>{const key='preorder:'+s.preorderID,r=(d.results||[]).find(r=>r.key===key),old=(d.excluded||[]).includes(key),receipt=d.receipts?.[key];return `<div class="item" style="margin-top:8px"><b>Поставка ${e(s.supplyID||s.preorderID)}</b><div class="muted">${e(labels[s.statusID]||'Статус неизвестен')} · ${old?'История, без повторного списания':e(r?.message||'Ожидает проверки')}</div>${receipt?.lines?.map(l=>`<div>${e(l.barcode)} · отправлено ${e(l.sent)} · принято ${l.accepted===null?'неизвестно':e(l.accepted)}</div>`).join('')||''}${r?.status==='reserved'?`<button type="button" class="btn" data-wb3-release="${e(key)}">Снять резерв</button>`:''}</div>`}).join('')}</details>`;
 box.querySelector('#wb3SupplyToggle').onclick=async()=>{try{await request(path()+'/accounting',{enabled:!d.enabled});await load()}catch(err){alert(String(err.message||err))}};
 box.querySelectorAll('[data-wb3-release]').forEach(b=>b.onclick=async()=>{if(!confirm('Снять резерв этой поставки? Автоматически он повторно не создастся.'))return;try{await request(path()+'/cancel-reservation',{key:b.dataset.wb3Release});await load()}catch(err){alert(String(err.message||err))}});
}
async function load(){if(loading)return loading;loading=(async()=>{try{snapshot=await request(path());render()}catch(err){const box=document.getElementById('wb3SupplyPanel');if(box&&!snapshot)box.textContent='Поставки WB3: '+String(err.message||err)}finally{loading=null}})();return loading}
const base=window.renderFboDashboard;
window.renderFboDashboard=function(){render();load();if(!window.WB3_ONLY)return base?.apply(this,arguments);const root=document.getElementById('fboRoot');if(root)root.hidden=true};
setInterval(()=>{if(typeof activeView!=='undefined'&&activeView==='fbo')load()},30000);
})();
