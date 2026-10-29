export function withFboPage(html){
 return html.replace(/<button id="ozonFboSuppliesBtn"[^>]*>[^<]*<\/button>/,'').replace("source==='WB'?'WB1'","source==='FBO'?'Планы FBO':source==='WB'?'WB1'").replace('<section id="purchases"','<section id="fbo" class="view"><div id="fboRoot"></div></section>\n<section id="purchases"')
  .replace('<button data-view="reports">','<button data-view="fbo"><span>▤</span>FBO</button><button data-view="reports">')
  .replaceAll("'purchases','reports'","'purchases','fbo','reports'")
  .replace("}else if(activeView==='purchases'){","}else if(activeView==='fbo'){\n    renderFboDashboard();\n  }else if(activeView==='purchases'){")
  .replace(/(ozon-fbo-v1\.js\?v=)[^"']+/g,(_,prefix)=>prefix+'20261029-full-catalog')
  .replace('</head>','<link rel="stylesheet" href="./fbo-dashboard.css?v=20261029-full-catalog">\n</head>')
  .replace('<script>initOwnerAuth();</script>','<script src="./fbo-dashboard-model.js?v=20261029-full-catalog"></script>\n<script src="./fbo-dashboard-v1.js?v=20261029-full-catalog"></script>\n<script src="./fbo-warehouse-v1.js?v=20261029-full-catalog"></script>\n<script>initOwnerAuth();</script>');
}
