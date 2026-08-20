// Load preserved Kaspi Ads logic, reservation compatibility, then current helpers.
(function(){
  const ads=document.createElement('script');
  ads.src='./kaspi-ads-v2-original.js?v=20260820-low-stock-alerts';
  ads.async=false;
  document.head.appendChild(ads);

  const reservationCompat=document.createElement('script');
  reservationCompat.src='./reservation-compat-v1.js?v=20260820-2200';
  reservationCompat.async=false;
  document.head.appendChild(reservationCompat);

  const extra=document.createElement('script');
  extra.src='./stock-alerts-rescue-v1.js?v=20260820-1732';
  extra.async=false;
  document.head.appendChild(extra);

  const rescue=document.createElement('script');
  rescue.src='./cloudflare-purchase-rescue-v1.js?v=20260820-1748';
  rescue.async=false;
  document.head.appendChild(rescue);
})();
