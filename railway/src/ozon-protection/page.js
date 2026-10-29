export function withOzonProtectionPage(html){
 return html.replace(/(prices-v1\.js\?v=)[^"']+/g,(_,prefix)=>prefix+'20261029-ozon-protection')
  .replace('<script>initOwnerAuth();</script>','<script src="./ozon-price-protection-v1.js?v=20261029-ozon-protection"></script>\n<script>initOwnerAuth();</script>');
}
