(function(){
'use strict';
const OLD_API='https://millioner-api.7masok.workers.dev';
const DONE_KEY='milioner_cloudflare_purchase_rescue_20260820_v1';

function statusOf(x){const v=String(x?.status||'');return ['to_forwarder','to_me','at_warehouse','received'].includes(v)?v:'received'}
function keyId(x){return String(x?.id||'').trim()}
function keyFallback(x){return [String(x?.shipmentId||''),String(x?.productId||''),String(x?.batch||''),String(x?.orderedAt||x?.date||''),String(x?.qty||'')].join('|')}
function ready(){try{return typeof warehouseRemoteReady!=='undefined'&&warehouseRemoteReady&&typeof state==='object'&&Array.isArray(state.purchases)}catch{return false}}
function snapshotCurrent(){return Array.isArray(state?.purchases)?state.purchases:[]}
function missingRows(remote,current){
  const ids=new Set(current.map(keyId).filter(Boolean));
  const fallback=new Set(current.map(keyFallback));
  const add=[];
  for(const row of(remote||[])){
    const id=keyId(row),fk=keyFallback(row);
    if(id&&ids.has(id))continue;
    if(fallback.has(fk))continue;
    add.push({...row,_syncUpdatedAt:Date.now()});
    if(id)ids.add(id);fallback.add(fk);
  }
  return add;
}
async function fetchOldState(){
  const r=await fetch(OLD_API+'/api/warehouse-state',{cache:'no-store'});
  let data={};try{data=await r.json()}catch{}
  if(!r.ok||data?.ok===false)throw new Error(data?.error||('HTTP '+r.status));
  if(!data?.exists||!data?.state)throw new Error('В Cloudflare D1 нет warehouse_state');
  return data;
}
window.restorePurchasesFromCloudflare=async function({manual=true}={}){
  if(!ready()){
    if(manual)alert('Склад ещё не получил актуальный снимок Railway. Повторите через несколько секунд.');
    return {ok:false,reason:'not-ready'};
  }
  try{
    const data=await fetchOldState();
    const remote=Array.isArray(data.state?.purchases)?data.state.purchases:[];
    const current=snapshotCurrent();
    const add=missingRows(remote,current);
    const remoteOpen=remote.filter(x=>statusOf(x)!=='received').length;
    const addOpen=add.filter(x=>statusOf(x)!=='received').length;
    if(add.length){
      state.purchases=[...add,...current];
      save();render();
      try{openView('purchases',true)}catch{}
    }
    localStorage.setItem(DONE_KEY,JSON.stringify({at:Date.now(),revision:Number(data.revision||0),remote:remote.length,remoteOpen,added:add.length,addedOpen:addOpen}));
    const message=`Cloudflare D1 найден.\nРевизия: ${Number(data.revision||0)}\nЗакупок в старом снимке: ${remote.length}\nНезавершённых там: ${remoteOpen}\nВосстановлено отсутствующих: ${add.length}${addOpen?`\nИз них незавершённых: ${addOpen}`:''}`;
    if(manual||add.length)alert(message);
    console.log('Cloudflare purchase rescue', {revision:data.revision,remote:remote.length,remoteOpen,added:add.length,addedOpen:addOpen});
    return {ok:true,revision:data.revision,remote:remote.length,remoteOpen,added:add.length,addedOpen:addOpen};
  }catch(e){
    console.error('Cloudflare purchase rescue failed',e);
    if(manual)alert('Не удалось прочитать старый Cloudflare D1:\n'+String(e.message||e));
    return {ok:false,error:String(e.message||e)};
  }
};
function autoTry(attempt=0){
  if(!ready()){if(attempt<30)setTimeout(()=>autoTry(attempt+1),1000);return}
  const current=snapshotCurrent(),open=current.filter(x=>statusOf(x)!=='received');
  if(open.length>0)return;
  window.restorePurchasesFromCloudflare({manual:false}).then(r=>{if(r?.ok&&!r.added)console.log('Cloudflare D1 checked; no missing purchases')});
}
setTimeout(()=>autoTry(0),2500);
})();
