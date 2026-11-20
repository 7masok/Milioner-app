import {readFileSync} from 'node:fs';

const wbAdsBulk=readFileSync(new URL('../../wb-ads-bulk-v1.js',import.meta.url),'utf8');

const wbQueryHistory=readFileSync(new URL('../../wb-query-history-v1.js',import.meta.url),'utf8');

export function withGrowthAnalyticsPage(html){
  const queryStart=html.indexOf('let wbQueryView=null,');
  const queryEnd=html.indexOf('async function renderAds(){',queryStart);
  if(queryStart>=0&&queryEnd>queryStart)html=html.slice(0,queryStart)+wbQueryHistory+'\n'+html.slice(queryEnd);
  html=html.replaceAll("<section id=\"ads\"","<section id=\"analytics\" class=\"view\"><div id=\"growthAnalyticsRoot\"></div></section>\n<section id=\"ads\"");
  html=html.replaceAll("<button data-view=\"ads\">","<button data-view=\"analytics\"><span>↗</span>Аналитика</button><button data-view=\"ads\">");
  html=html.replaceAll("'reports','ads','settings'","'reports','analytics','ads','settings'");
  html=html.replaceAll("}else if(activeView==='ads'){","}else if(activeView==='analytics'){\n    renderGrowthAnalytics();\n  }else if(activeView==='ads'){");
  html=html.replaceAll("<script src=\"./product-sales-trend-v1.js","<link rel=\"stylesheet\" href=\"./growth-analytics.css?v=20261028\">\n<script src=\"./growth-analytics-model.js?v=20261028\"></script>\n<script src=\"./growth-analytics-v1.js?v=20261028\"></script>\n<script src=\"./product-sales-trend-v1.js");
  return html.replace('<script>initOwnerAuth();</script>',()=>'<script data-source="wb-ads-bulk-v1.js">\n'+wbAdsBulk+'</script>\n<script>initOwnerAuth();</script>');
}
