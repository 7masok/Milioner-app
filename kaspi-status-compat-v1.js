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
})();