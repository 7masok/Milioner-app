(function(){
'use strict';

if(typeof marketplaceLifecycleStage!=='function')return;
const originalMarketplaceLifecycleStage=marketplaceLifecycleStage;

marketplaceLifecycleStage=function(market,status,state=''){
  const original=originalMarketplaceLifecycleStage(market,status,state);
  if(market!=='Kaspi'||original==='cancelled'||original==='delivery')return original;
  const u=String(status||'').toUpperCase();
  const st=String(state||'').toUpperCase();
  if(u==='ASSEMBLE'||u==='ACCEPTED_BY_MERCHANT'||['DELIVERY','KASPI_DELIVERY','PICKUP'].includes(st))return 'transfer';
  return original;
};
})();
