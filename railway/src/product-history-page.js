export function withProductHistoryPage(html){
 return html.replace('<div class="pack-toolbar">','<div class="pack-toolbar"><button type="button" class="btn" data-product-history="">История изменений</button>')
  .replace(' let s=`<h3>${esc(p.name)}</h3>',' let s=`<h3>${esc(p.name)}</h3><button type="button" class="btn" data-product-history="${esc(p.id)}">История товара</button>')
  .replace('<script>initOwnerAuth();</script>','<script src="./product-history-v1.js?v=20261029-history-descriptive"></script>\n<script>initOwnerAuth();</script>');
}
