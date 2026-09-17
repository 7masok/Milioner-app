(function(){
'use strict';
// Compatibility override removed: the built-in Kaspi lifecycle mapping is authoritative.
// ACCEPTED_BY_MERCHANT + KASPI_DELIVERY is still packing/new, not courier hand-off.

// Ozon FBO data is loaded from its own server cache, while cloud-sync replaces the
// warehouse state object from /api/warehouse-state. Preserve the already loaded
// Ozon order feed across that replacement so the shared marketplace order UI can
// render it and keep product-link controls available.
try{
  if(typeof applyWarehouseSnapshot==='function'){
    const baseApplyWarehouseSnapshot=applyWarehouseSnapshot;
    applyWarehouseSnapshot=function(remote){
      const ozonFeed=Array.isArray(state?.ozonOrderFeed)?state.ozonOrderFeed:null;
      const result=baseApplyWarehouseSnapshot(remote);
      if(ozonFeed)state.ozonOrderFeed=ozonFeed;
      return result;
    };
  }
}catch(error){
  console.warn('Ozon feed snapshot compatibility hook failed',error);
}

// Movement history is an audit trail. Do not trim it in the browser.
try{
  if(typeof log==='function'){
    log=function(type,pid,qty,extra=''){
      const movement={id:id(),date:Date.now(),type,productId:pid,qty,extra};
      if(!Array.isArray(state.movements))state.movements=[];
      state.movements.unshift(movement);
      return movement;
    };
  }
}catch(error){
  console.warn('Movement history log compatibility hook failed',error);
}

// Only the visible movement list is filtered/paginated; the underlying history stays intact.
const MOVEMENT_PERIOD_KEY='millioner_movement_period_v1';
let movementHistoryDays=(()=>{try{const v=Number(localStorage.getItem(MOVEMENT_PERIOD_KEY));return [0,7,30,60,180].includes(v)?v:60}catch{return 60}})();
function ensureMovementPeriodControls(){
  const section=document.getElementById('movement');
  if(!section||document.getElementById('movementPeriod'))return;
  const toolbar=section.querySelector('.toolbar');
  if(!toolbar)return;
  const wrap=document.createElement('div');
  wrap.id='movementPeriod';
  wrap.className='period';
  wrap.style.margin='0 0 10px';
  wrap.innerHTML=[
    [7,'7 дней'],[30,'30 дней'],[60,'60 дней'],[180,'6 месяцев'],[0,'Всё время']
  ].map(([days,label])=>`<button type="button" class="chip" data-movement-period="${days}" onclick="setMovementHistoryPeriod(${days})">${label}</button>`).join('');
  toolbar.parentNode.insertBefore(wrap,toolbar);
}
function paintMovementPeriodControls(){
  ensureMovementPeriodControls();
  document.querySelectorAll('[data-movement-period]').forEach(button=>button.classList.toggle('active',Number(button.dataset.movementPeriod)===movementHistoryDays));
}
window.setMovementHistoryPeriod=function(days){
  const value=Number(days);
  movementHistoryDays=[0,7,30,60,180].includes(value)?value:60;
  try{localStorage.setItem(MOVEMENT_PERIOD_KEY,String(movementHistoryDays))}catch{}
  try{movementPage=1}catch{}
  renderMovement();
};

try{
  if(typeof renderMovement==='function'){
    renderMovement=function(){
      paintMovementPeriodControls();
      const t=document.getElementById('moveType')?.value||'all';
      const q=(document.getElementById('moveQ')?.value||'').toLowerCase();
      const cutoff=movementHistoryDays>0?Date.now()-movementHistoryDays*86400000:0;
      let a=(Array.isArray(state.movements)?state.movements:[]).filter(m=>
        (!cutoff||Number(m?.date||0)>=cutoff)&&
        (t==='all'||m.type===t)&&
        ((prod(m.productId)?.name||'').toLowerCase().includes(q))
      );
      const list=document.getElementById('movementList'),pager=document.getElementById('movementPager');
      if(!list)return;
      if(!a.length){movementPage=1;list.innerHTML='<div class="empty">Нет операций за выбранный период</div>';if(pager)pager.innerHTML='';return}
      const totalPages=Math.max(1,Math.ceil(a.length/MOVEMENT_PAGE_SIZE));
      movementPage=Math.min(Math.max(1,movementPage),totalPages);
      const rows=a.slice((movementPage-1)*MOVEMENT_PAGE_SIZE,movementPage*MOVEMENT_PAGE_SIZE);
      list.innerHTML='<table><tr><th>Дата</th><th>Операция</th><th>Товар</th><th>Кол.</th><th></th></tr>'+rows.map(m=>`<tr><td>${new Date(m.date).toLocaleDateString('ru-RU')}</td><td>${esc(movementIsStockAdjustment(m)?movementAdjustmentLabel(m):m.type)}</td><td>${esc(productNameById(m.productId,'—'))}</td><td>${Number(m.qty)||0}</td><td>${movementIsStockAdjustment(m)?`<button type="button" class="btn" aria-label="Редактировать операцию" onclick="openMovementEdit('${encodeURIComponent(String(m.id))}')">✎</button>`:''}</td></tr>`).join('')+'</table>';
      if(pager)pager.innerHTML=totalPages>1?`<div class="item" style="padding:10px;margin-top:8px"><div class="row" style="justify-content:space-between"><button class="btn" ${movementPage<=1?'disabled':''} onclick="setMovementPage(${movementPage-1})">← Назад</button><div class="muted" style="text-align:center">Страница ${movementPage} из ${totalPages}<br>${a.length} операций</div><button class="btn" ${movementPage>=totalPages?'disabled':''} onclick="setMovementPage(${movementPage+1})">Вперёд →</button></div></div>`:'';
    };
  }
}catch(error){
  console.warn('Movement period compatibility hook failed',error);
}

function initMovementHistoryUi(){paintMovementPeriodControls();}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',initMovementHistoryUi,{once:true});else initMovementHistoryUi();
})();