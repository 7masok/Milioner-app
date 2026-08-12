from pathlib import Path

root = Path(__file__).resolve().parents[1]
html_path = root / 'index.html'
html = html_path.read_text(encoding='utf-8')

old = '''function render(){
  document.querySelectorAll('.chip').forEach(b=>b.classList.toggle('active',Number(b.dataset.period)===selectedPeriodPreset));
  document.querySelectorAll('.market-tab').forEach(b=>b.classList.toggle('active',b.dataset.market===selectedOrderMarket));
  renderOrderPeriodControls();renderMarketplaceOrders();renderAttention();renderRecent();renderProducts();renderMovement();renderPurchases();renderReports();
  document.getElementById('lastSync').textContent=state.settings.lastSync?new Date(state.settings.lastSync).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'}):'—';
  const ab=document.getElementById('autoBackup');if(ab)ab.checked=state.settings.autoBackup!==false;
  renderIntegrationStatus();renderDriveStatus();
}'''

new = '''function render(){
  const activeView=document.querySelector('.view.active')?.id||state.settings.activeView||'home';
  if(activeView==='home'){
    document.querySelectorAll('.market-tab[data-market]').forEach(b=>b.classList.toggle('active',b.dataset.market===selectedOrderMarket));
    renderOrderPeriodControls();renderMarketplaceOrders();renderAttention();renderRecent();
  }else if(activeView==='products'){
    renderProducts();
  }else if(activeView==='movement'){
    renderMovement();
  }else if(activeView==='purchases'){
    renderPurchases();
  }else if(activeView==='reports'){
    document.querySelectorAll('.chip').forEach(b=>b.classList.toggle('active',Number(b.dataset.period)===selectedPeriodPreset));
    renderReports();
  }
  const lastSync=document.getElementById('lastSync');if(lastSync)lastSync.textContent=state.settings.lastSync?new Date(state.settings.lastSync).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'}):'—';
  const ab=document.getElementById('autoBackup');if(ab)ab.checked=state.settings.autoBackup!==false;
  renderIntegrationStatus();
  if(activeView==='settings')renderDriveStatus();
}'''

if new in html:
    print('Active-view render optimization already applied')
    raise SystemExit(0)
if old not in html:
    raise SystemExit('Expected render() block not found; refusing unsafe edit')

html = html.replace(old, new, 1)

required = [
    "const activeView=document.querySelector('.view.active')?.id||state.settings.activeView||'home';",
    "if(activeView==='home')",
    "else if(activeView==='products')",
    "else if(activeView==='movement')",
    "else if(activeView==='purchases')",
    "else if(activeView==='reports')",
    "if(activeView==='settings')renderDriveStatus();",
]
missing = [marker for marker in required if marker not in html]
if missing:
    raise SystemExit('Missing optimization markers: ' + ', '.join(missing))

html_path.write_text(html, encoding='utf-8')
print('Optimized render() to update only the active warehouse view')
