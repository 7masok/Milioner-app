(function(){
'use strict';

if(typeof applyMarketplaceTransitions!=='function')return;
const originalApplyMarketplaceTransitions=applyMarketplaceTransitions;

function sameText(a,b){return String(a??'')===String(b??'')}
function isWbReservationMarket(market){return market==='WB'||market==='WB2'}
function transitionFreshMs(market){return isWbReservationMarket(market)?5*60*1000:market==='Kaspi'?15*60*1000:15*60*1000}
function freshTransitionRows(market,feed){
  const now=Date.now(),maxAge=transitionFreshMs(market);
  return (Array.isArray(feed)?feed:[]).filter(order=>{
    const updatedAt=Number(order?.updatedAt||0);
    return updatedAt>0&&updatedAt<=now+60*1000&&now-updatedAt<=maxAge;
  });
}

function findMatchingActiveReservation(market,order,reservations){
  const orderId=String(order?.orderId??'');
  const entryId=String(order?.entryId??'');
  if(!orderId||!entryId)return null;
  const legacy=orderId+':'+entryId;
  const scoped=market+':'+legacy;

  let match=reservations.find(r=>r?.active&&sameText(r.source,market)&&(
    sameText(r.externalKey,scoped)||sameText(r.externalKey,legacy)
  ));
  if(match)return {reservation:match,scoped,legacy};

  if(!isWbReservationMarket(market)||orderId===entryId)return null;
  const productId=String(order?.productId??'');
  if(!productId)return null;
  match=reservations.find(r=>{
    if(!r?.active||!sameText(r.source,market))return false;
    const key=String(r.externalKey??'');
    if(!key||!key.endsWith(':'+entryId))return false;
    const reservedProductId=String(r.productId??'');
    return reservedProductId!==''&&reservedProductId===productId;
  });
  return match?{reservation:match,scoped,legacy}:null;
}

applyMarketplaceTransitions=function(market,feed){
  // Order history is kept for reports, but only rows touched by a recent
  // authoritative server sync are allowed to change warehouse reservations.
  // This prevents old NEW/WAITING rows from recreating phantom reserves.
  const rows=freshTransitionRows(market,feed);
  if(!rows.length)return {reserved:0,sold:0,cancelled:0};
  const reservations=Array.isArray(state?.reservations)?state.reservations:[];
  const now=Date.now();
  state.marketOrderState||={};
  const bucket=state.marketOrderState[market]||(market==='Kaspi'?{...(state.kaspiOrders||{})}:{});
  state.marketOrderState[market]=bucket;
  let repaired=0,seeded=0;

  for(const order of rows){
    const found=findMatchingActiveReservation(market,order,reservations);
    if(!found)continue;
    if(!sameText(found.reservation.externalKey,found.scoped)){
      found.reservation.externalKey=found.scoped;
      found.reservation.updatedAt=now;
      found.reservation.keyRepairedAt=now;
      repaired++;
    }
    if(!bucket[found.legacy]&&!bucket[found.scoped]){
      bucket[found.legacy]={
        status:'',state:'',active:true,
        stage:String(found.reservation.stage||'new'),
        qty:Number(found.reservation.qty||order?.qty||0)||0,
        sku:String(order?.sku||''),
        updatedAt:Number(found.reservation.updatedAt||found.reservation.date||now)||now
      };
      seeded++;
    }
  }

  const result=originalApplyMarketplaceTransitions(market,rows);
  if(repaired||seeded)console.info('reservation compatibility',market,{repaired,seeded});
  return result;
};

function refreshOnce(attempt=0){
  let ready=false;
  try{ready=typeof warehouseRemoteReady!=='undefined'&&warehouseRemoteReady===true}catch{}
  if(ready&&typeof loadSharedOrderCache==='function'){
    Promise.resolve(loadSharedOrderCache({silent:true})).catch(e=>console.warn('reservation reconcile refresh failed',e));
    return;
  }
  if(attempt<12)setTimeout(()=>refreshOnce(attempt+1),1000);
}
setTimeout(()=>refreshOnce(0),1200);
})();
