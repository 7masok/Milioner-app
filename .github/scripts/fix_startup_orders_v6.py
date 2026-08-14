from pathlib import Path

p=Path('index.html')
s=p.read_text(encoding='utf-8')
start=s.find('async function loadSharedOrderCache({silent=true}={}){')
end=s.find('\nasync function checkMarketStatus(',start)
if start<0 or end<0: raise SystemExit('loadSharedOrderCache block not found')
new=r'''async function loadSharedOrderCache({silent=true}={}){
  const statusPromise=apiJson(MILLIONER_API+'/api/market-status').then(status=>{
    state.settings.serverMarketStatus={};
    for(const x of(status.markets||[]))state.settings.serverMarketStatus[x.market]=x;
    const success=(status.markets||[]).map(x=>Number(x.lastSuccessAt||0)).filter(Boolean);
    if(success.length)state.settings.lastSync=Math.max(Number(state.settings.lastSync||0),...success);
    saveLocalOnly();
    const lastSync=document.getElementById('lastSync');if(lastSync)lastSync.textContent=state.settings.lastSync?new Date(state.settings.lastSync).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'}):'—';
    renderIntegrationStatus();
    return status;
  }).catch(e=>{console.warn('Market status update failed',e);return {ok:false,markets:[],error:e}});
  try{
    const [kdResult,w1Result,w2Result]=await Promise.allSettled([
      apiJson(MILLIONER_API+'/api/orders?market=Kaspi&limit=500'),
      apiJson(MILLIONER_API+'/api/orders?market=WB&limit=500'),
      apiJson(MILLIONER_API+'/api/orders?market=WB2&limit=500')
    ]);
    let k=[],w1=[],w2=[],warnings=[];
    if(kdResult.status==='fulfilled'){
      k=normalizeServerFeed(kdResult.value.orders,'Kaspi');
      state.kaspiOrderFeed=mergeOrderFeeds(state.kaspiOrderFeed,k);
      if(k.length)applyMarketplaceTransitions('Kaspi',state.kaspiOrderFeed);
    }else warnings.push('Kaspi: '+String(kdResult.reason?.message||kdResult.reason));
    if(w1Result.status==='fulfilled'){
      w1=normalizeServerFeed(w1Result.value.orders,'WB');
      state.wbOrderFeed=mergeOrderFeeds(state.wbOrderFeed,w1);
      if(w1.length)applyMarketplaceTransitions('WB',state.wbOrderFeed.filter(o=>String(o.market||'WB')==='WB'));
    }else warnings.push('WB 1: '+String(w1Result.reason?.message||w1Result.reason));
    if(w2Result.status==='fulfilled'){
      w2=normalizeServerFeed(w2Result.value.orders,'WB2');
      state.wbOrderFeed=mergeOrderFeeds(state.wbOrderFeed,w2);
      if(w2.length)applyMarketplaceTransitions('WB2',state.wbOrderFeed.filter(o=>String(o.market||'WB')==='WB2'));
    }else warnings.push('WB 2: '+String(w2Result.reason?.message||w2Result.reason));
    // Marketplace transitions change reservations/sales/stock, so this must go through cloud save.
    save();render();
    if(warnings.length)console.warn('Shared cache partial update',warnings.join('; '));
    const allFailed=kdResult.status==='rejected'&&w1Result.status==='rejected'&&w2Result.status==='rejected';
    if(allFailed)throw kdResult.reason||w1Result.reason||w2Result.reason;
    // Do not block the home screen on status. Manual refresh may wait briefly for nicer status text.
    if(!silent)await Promise.race([statusPromise,new Promise(r=>setTimeout(r,1200))]);
    return {kaspi:k.length,wb:w1.length,wb2:w2.length,status:state.settings.serverMarketStatus||{},warnings};
  }catch(e){
    console.error('Shared cache error',e);
    if(!silent)alert('Ошибка общей базы:\n'+String(e.message||e));
    return {kaspi:0,wb:0,wb2:0,error:e};
  }
}'''
s=s[:start]+new+s[end:]
p.write_text(s,encoding='utf-8')
print('nonblocking order startup v6 applied')
