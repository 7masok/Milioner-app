// Load the warehouse save guard first, then preserved Kaspi helpers.
(function(){
  const saveGuard=document.createElement('script');
  saveGuard.src='./save-conflict-v1.js?v=20260820-2353';
  saveGuard.async=false;
  document.head.appendChild(saveGuard);

  const purchaseDelete=document.createElement('script');
  purchaseDelete.src='./purchase-delete-v1.js?v=20260821-0014';
  purchaseDelete.async=false;
  document.head.appendChild(purchaseDelete);

  const ads=document.createElement('script');
  ads.src='./kaspi-ads-v2-original.js?v=20260820-low-stock-alerts';
  ads.async=false;
  document.head.appendChild(ads);

  const reservationCompat=document.createElement('script');
  reservationCompat.src='./reservation-compat-v1.js?v=20260820-2324';
  reservationCompat.async=false;
  document.head.appendChild(reservationCompat);

  const extra=document.createElement('script');
  extra.src='./stock-alerts-rescue-v1.js?v=20260821-0140';
  extra.async=false;
  document.head.appendChild(extra);

  const rescue=document.createElement('script');
  rescue.src='./cloudflare-purchase-rescue-v1.js?v=20260820-1748';
  rescue.async=false;
  document.head.appendChild(rescue);
})();
