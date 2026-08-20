(function(){
'use strict';

if(typeof applyMarketplaceTransitions!=='function')return;
const originalApplyMarketplaceTransitions=applyMarketplaceTransitions;

function sameText(a,b){return String(a??'')===String(b??'')}
function isWbReservationMarket(market){return market==='WB'||market==='WB2'}

function findMatchingActiveReservation(market,order,reservations){
  const orderId=String(order?.orderId??'');
  const entryId=String(order?.entryId??'');
  if(!orderId||!entryId)return null;
  const legacy=orderId+':'+entryId;
  const scoped=market+':'+legacy;

  // Exact keys are always authoritative. Legacy unscoped keys are accepted
  // only inside the same marketplace source, so they cannot collide cross-market.
  let match=reservations.find(r=>r?.active&&sameText(r.source,market)&&(
    sameText(r.externalKey,scoped)||sameText(r.externalKey,legacy)
  ));
  if(match)return {reservation:match,scoped,legacy};

  // WB order numbers changed from the internal API id to public gNumber/orderNumber.
  // Repair that historical key only when the current row clearly uses the public
  // number (orderId != entryId) and the stable entryId + productId both agree.
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
  const rows=Array.isArray(feed)?feed:[];
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
    // An exact active reservation is proof that this order previously occupied
    // stock. Seed the transition cache only when it is missing, so a later exact
    // COMPLETED status converts the reserve into a sale instead of merely hiding it.
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

// The first startup order-cache read may have happened before this module loaded.
// Run one ordinary refresh after the warehouse is online so repaired/seeded state
// immediately goes through the existing exact marketplace transition logic.
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
