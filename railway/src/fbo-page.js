export function withFboPage(html){
 return html.replace('<section id="purchases"','<section id="fbo" class="view"><div id="fboRoot"></div></section>\n<section id="purchases"')
  .replace('<button data-view="reports">','<button data-view="fbo"><span>▤</span>FBO</button><button data-view="reports">')
  .replaceAll("'purchases','reports'","'purchases','fbo','reports'")
  .replace("}else if(activeView==='purchases'){","}else if(activeView==='fbo'){\n    renderFboDashboard();\n  }else if(activeView==='purchases'){")
  .replace('</head>','<link rel="stylesheet" href="./fbo-dashboard.css?v=20261028-fbo">\n</head>')
  .replace('<script>initOwnerAuth();</script>','<script src="./fbo-dashboard-model.js?v=20261028-fbo"></script>\n<script src="./fbo-dashboard-v1.js?v=20261028-fbo"></script>\n<script>initOwnerAuth();</script>');
}
