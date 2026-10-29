export function withOzonProtectionPage(html){
 return html.replace(/(prices-v1\.js\?v=)[^"']+/g,(_,prefix)=>prefix+'20261029-ozon-selection')
  .replace(/(business-dashboard-v1\.js\?v=)[^"']+/g,(_,prefix)=>prefix+'20261029-shared-period')
  .replace('<script>initOwnerAuth();</script>','<script src="./ozon-price-protection-v1.js?v=20261029-ozon-selection"></script>\n<script>initOwnerAuth();</script>');
}
