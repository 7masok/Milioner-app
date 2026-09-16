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

// cloud-sync rebuilds the header into compact Kaspi/WB rows after the Ozon module
// initially adds its status. Restore an Ozon row inside that compact stack and keep
// the ids expected by ozon-fbo-v1.js so its live status painter continues to work.
function ensureOzonHeaderRow(){
  const sync=document.querySelector('header .sync');
  if(!sync)return;
  const stack=sync.querySelector('.compact-market-stack');
  let dot=document.getElementById('dotOzonTop');
  let status=document.getElementById('ozonTopStatus');
  if(stack){
    if(!stack.querySelector('#ozonStatusRow')){
      const row=document.createElement('button');
      row.className='compact-market-row';
      row.id='ozonStatusRow';
      row.type='button';
      row.innerHTML='<span id="dotOzonTop" class="dot warn"></span><b>Ozon</b><span id="ozonTopStatus" class="compact-market-time">подключение…</span>';
      stack.appendChild(row);
    }
    return;
  }
  if(!dot||!status){
    sync.insertAdjacentHTML('beforeend',' · <span id="dotOzonTop" class="dot warn"></span>Ozon: <span id="ozonTopStatus">подключение…</span>');
  }
}

function startOzonHeaderGuard(){
  ensureOzonHeaderRow();
  const sync=document.querySelector('header .sync');
  if(sync&&!sync.dataset.ozonHeaderGuard){
    sync.dataset.ozonHeaderGuard='1';
    new MutationObserver(()=>ensureOzonHeaderRow()).observe(sync,{childList:true,subtree:true});
  }
  setTimeout(ensureOzonHeaderRow,300);
  setTimeout(ensureOzonHeaderRow,1200);
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',startOzonHeaderGuard,{once:true});else startOzonHeaderGuard();
window.addEventListener('load',startOzonHeaderGuard);
})();