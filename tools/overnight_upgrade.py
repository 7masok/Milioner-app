from pathlib import Path

INDEX = Path('index.html')


def between(text: str, start: str, end: str, replacement: str, label: str) -> str:
    a = text.find(start)
    if a < 0:
        raise SystemExit(f'{label}: start marker not found')
    b = text.find(end, a)
    if b < 0:
        raise SystemExit(f'{label}: end marker not found')
    return text[:a] + replacement + text[b:]


def once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 match, got {count}')
    return text.replace(old, new, 1)


html = INDEX.read_text(encoding='utf-8')

html = once(
    html,
    ".worker-url{width:100%;padding:11px;border:1px solid var(--line);border-radius:11px;background:#fff;margin-top:6px}\n",
    ".worker-url{width:100%;padding:11px;border:1px solid var(--line);border-radius:11px;background:#fff;margin-top:6px}\n"
    ".dot.warn{background:var(--warn)}.dot.bad{background:var(--bad)}.dot.off{background:#b9bdc3}\n"
    ".integration-title{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:8px}.integration-title b{font-size:14px}.integration-status{margin-top:8px;line-height:1.4}.integration-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}\n",
    'integration css',
)

html = once(
    html,
    '  <div class="sync"><span class="dot"></span>Kaspi &nbsp; <span class="dot"></span>WB &nbsp; <span class="dot"></span>Ozon · последняя синхронизация: <span id="lastSync">—</span></div>',
    '  <div class="sync"><span id="dotKaspi" class="dot warn"></span>Kaspi &nbsp; <span id="dotWb" class="dot warn"></span>WB &nbsp; <span id="dotOzon" class="dot off"></span>Ozon · последняя синхронизация: <span id="lastSync">—</span></div>',
    'header status dots',
)

settings_start = '<div class="setting" style="display:block"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><span>Kaspi API</span>'
settings_end = '<button class="btn full" onclick="backup()">'
settings_new = '''<div class="setting" style="display:block">
  <div class="integration-title"><b>Kaspi API</b><span id="kaspiApiBadge" class="badge warn">Проверяем</span></div>
  <div class="muted">Фоновая синхронизация: Kaspi Worker → общая база D1. API-токен остаётся в Cloudflare Secret и в сайт не попадает.</div>
  <div id="kaspiApiStatus" class="muted integration-status">Статус: проверяем сервер…</div>
  <div class="integration-actions"><button class="btn" onclick="checkMarketStatus('Kaspi')">Проверить</button><button class="btn dark" onclick="syncNow()">Обновить Kaspi</button></div>
</div>
<div class="setting" style="display:block">
  <div class="integration-title"><b>Wildberries API</b><span id="wbApiBadge" class="badge warn">Проверяем</span></div>
  <div class="muted">WB обновляется на сервере с учётом лимитов Wildberries. Сайт не делает лишние запросы к WB и показывает последнюю успешную копию из D1.</div>
  <div id="wbApiStatus" class="muted integration-status">Статус: проверяем сервер…</div>
  <div class="integration-actions"><button class="btn" onclick="checkMarketStatus('WB')">Проверить</button><button class="btn dark" onclick="refreshWbFromServer()">Обновить данные</button></div>
</div>
<div class="setting" style="display:block">
  <div class="integration-title"><b>Ozon API</b><span class="badge">Позже</span></div>
  <div class="muted">Ozon пока не подключён. Подключим его к той же общей схеме после стабилизации Kaspi и WB.</div>
</div>
'''
html = between(html, settings_start, settings_end, settings_new, 'settings integrations')

html = once(
    html,
    "const WB_WORKER='https://wb-sync.7masok.workers.dev';\n",
    "const WB_WORKER='https://wb-sync.7masok.workers.dev';\nconst MILLIONER_API='https://millioner-api.7masok.workers.dev';\n",
    'millioner api constant',
)

html = once(
    html,
    "let selectedPeriodPreset=[0,1,7,30].includes(Number(state.settings.selectedPeriodPreset))?Number(state.settings.selectedPeriodPreset):1;let selectedPeriod=selectedPeriodPreset===0?Math.max(1,Number(state.settings.selectedPeriod)||14):selectedPeriodPreset;let selectedOrderMarket='Kaspi';",
    "let selectedPeriodPreset=[0,1,7,30].includes(Number(state.settings.selectedPeriodPreset))?Number(state.settings.selectedPeriodPreset):1;let selectedPeriod=selectedPeriodPreset===0?Math.max(1,Number(state.settings.selectedPeriod)||14):selectedPeriodPreset;let selectedOrderMarket=['Kaspi','WB','Ozon'].includes(state.settings.selectedOrderMarket)?state.settings.selectedOrderMarket:'Kaspi';",
    'selected market persistence',
)

new_render = r'''function render(){
  document.querySelectorAll('.chip').forEach(b=>b.classList.toggle('active',Number(b.dataset.period)===selectedPeriodPreset));
  document.querySelectorAll('.market-tab').forEach(b=>b.classList.toggle('active',b.dataset.market===selectedOrderMarket));
  document.getElementById('mStock').textContent=stockTotal().toLocaleString('ru-RU');
  let since=Date.now()-selectedPeriod*86400000;
  let ss=state.sales.filter(s=>s.date>=since);
  let rev=ss.reduce((a,s)=>a+s.qty*s.price,0);
  let pr=ss.reduce((a,s)=>a+s.qty*(s.price-s.cost-s.fee),0);
  document.getElementById('mSales').textContent=fmt(rev);
  document.getElementById('mProfit').textContent=fmt(pr);
  document.getElementById('periodLabel').textContent=selectedPeriod===1?'сегодня':selectedPeriod+' дней';
  renderMarketplaceOrders();renderAttention();renderRecent();renderProducts();renderMovement();renderPurchases();renderReports();
  document.getElementById('lastSync').textContent=state.settings.lastSync?new Date(state.settings.lastSync).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'}):'—';
  const ab=document.getElementById('autoBackup');if(ab)ab.checked=state.settings.autoBackup!==false;
  renderIntegrationStatus();
}
function marketServerStatus(market){return state.settings.serverMarketStatus?.[market]||null}
function isWbRateLimit(error){return /\b429\b|too many requests|global limiter|rate limit/i.test(String(error||''))}
function shortClock(ts){return ts?new Date(Number(ts)).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'}):'—'}
function setDot(id,kind){const el=document.getElementById(id);if(el)el.className='dot '+(kind||'')}
function setIntegrationBadge(id,text,kind){const el=document.getElementById(id);if(el){el.textContent=text;el.className='badge '+(kind||'')}}
function renderIntegrationStatus(){
  const k=marketServerStatus('Kaspi'),w=marketServerStatus('WB');
  const ks=document.getElementById('kaspiApiStatus'),ws=document.getElementById('wbApiStatus');
  if(k?.latest?.ok){setIntegrationBadge('kaspiApiBadge','Работает','ok');setDot('dotKaspi','');if(ks)ks.textContent=`Статус: фоновая синхронизация работает · ${k.orderLines||0} строк · успешно ${shortClock(k.lastSuccessAt)}`}
  else if(k?.latest){setIntegrationBadge('kaspiApiBadge','Ошибка','bad');setDot('dotKaspi','bad');if(ks)ks.textContent='Статус: '+String(k.latest.error||'ошибка фоновой синхронизации').slice(0,180)}
  else{setIntegrationBadge('kaspiApiBadge','Проверяем','warn');setDot('dotKaspi','warn');if(ks)ks.textContent='Статус: ждём первый фоновый запуск'}
  if(w?.latest?.ok){setIntegrationBadge('wbApiBadge','Работает','ok');setDot('dotWb','');if(ws)ws.textContent=`Статус: данные WB в общей базе · ${w.orderLines||0} строк · успешно ${shortClock(w.lastSuccessAt)}`}
  else if(w?.latest&&isWbRateLimit(w.latest.error)){setIntegrationBadge('wbApiBadge','Лимит WB','warn');setDot('dotWb','warn');if(ws)ws.textContent=`Статус: Wildberries временно ограничил запросы. Сервер не спамит API и повторит после ${shortClock(w.nextSyncAt)}`}
  else if(w?.latest){setIntegrationBadge('wbApiBadge','Ошибка','bad');setDot('dotWb','bad');if(ws)ws.textContent='Статус: '+String(w.latest.error||'ошибка фоновой синхронизации').slice(0,180)}
  else{setIntegrationBadge('wbApiBadge','Проверяем','warn');setDot('dotWb','warn');if(ws)ws.textContent='Статус: ждём первый фоновый запуск'}
  setDot('dotOzon','off');
}
'''
html = between(html, 'function render(){', 'function selectOrderMarket(', new_render, 'render function')

new_select = "function selectOrderMarket(market){selectedOrderMarket=market;state.settings.selectedOrderMarket=market;save();renderMarketplaceOrders();document.querySelectorAll('.market-tab').forEach(b=>b.classList.toggle('active',b.dataset.market===market))}\n"
html = between(html, 'function selectOrderMarket(', 'function marketplaceStatusLabel(', new_select, 'select market')

server_helpers = r'''function normalizeServerFeed(rows,market){const field=marketplaceField(market);return (rows||[]).map(o=>{const sku=String(o.sku||'').trim();const p=field&&sku?state.products.find(x=>String(x[field]||'').trim()===sku):null;return {...o,creationDate:toTimestamp(o.creationDate),productId:o.productId||p?.id||null}})}
function mergeOrderFeeds(local,remote){const map=new Map();for(const o of(local||[])map.set(String(o.orderId)+':'+String(o.entryId),o);for(const o of(remote||[]){const key=String(o.orderId)+':'+String(o.entryId),prev=map.get(key)||{};map.set(key,{...prev,...o,productId:o.productId||prev.productId||null})}return [...map.values()].sort((a,b)=>(Number(b.creationDate)||0)-(Number(a.creationDate)||0)).slice(0,500)}
async function apiJson(url){const r=await fetch(url,{cache:'no-store'});let data;try{data=await r.json()}catch(e){throw new Error('Сервер вернул не JSON (HTTP '+r.status+')')}if(!r.ok||data?.ok===false)throw new Error(data?.error||('HTTP '+r.status));return data}
async function loadSharedOrderCache({silent=true}={}){try{const [status,kd,wd]=await Promise.all([apiJson(MILLIONER_API+'/api/market-status'),apiJson(MILLIONER_API+'/api/orders?market=Kaspi&limit=500'),apiJson(MILLIONER_API+'/api/orders?market=WB&limit=500')]);state.settings.serverMarketStatus={};for(const s of(status.markets||[]))state.settings.serverMarketStatus[s.market]=s;const k=normalizeServerFeed(kd.orders,'Kaspi'),w=normalizeServerFeed(wd.orders,'WB');if(k.length)state.kaspiOrderFeed=mergeOrderFeeds(state.kaspiOrderFeed,k);if(w.length)state.wbOrderFeed=mergeOrderFeeds(state.wbOrderFeed,w);const success=(status.markets||[]).map(x=>Number(x.lastSuccessAt||0)).filter(Boolean);if(success.length)state.settings.lastSync=Math.max(Number(state.settings.lastSync||0),...success);save();render();return {kaspi:k.length,wb:w.length,status}}catch(e){console.error('Shared cache error',e);if(!silent)alert('Ошибка общей базы:\n'+String(e.message||e));return {kaspi:0,wb:0,error:e}}}
async function checkMarketStatus(market){await loadSharedOrderCache({silent:true});const s=marketServerStatus(market);if(!s)return alert(market+': сервер пока не вернул статус');if(s.latest?.ok)return alert(`${market}: фоновая синхронизация работает.\nСтрок в общей базе: ${s.orderLines||0}\nПоследний успех: ${shortClock(s.lastSuccessAt)}`);if(market==='WB'&&isWbRateLimit(s.latest?.error))return alert(`WB подключён, но Wildberries включил лимит запросов.\nМы больше не дёргаем API из браузера.\nСледующая серверная попытка: ${shortClock(s.nextSyncAt)}`);alert(`${market}: ошибка фоновой синхронизации\n${String(s.latest?.error||'неизвестная ошибка').slice(0,500)}`)}
async function refreshWbFromServer(){const result=await loadSharedOrderCache({silent:false});selectedOrderMarket='WB';state.settings.selectedOrderMarket='WB';save();render();const count=(state.wbOrderFeed||[]).length,s=marketServerStatus('WB');if(count)return alert('WB: показана последняя серверная копия.\nСтрок заказов: '+count);if(s?.latest&&isWbRateLimit(s.latest.error))return alert('WB пока не отдал новую копию из-за лимита. Сервер повторит после '+shortClock(s.nextSyncAt)+'.');alert('WB: в общей базе пока нет заказов.')}
'''
html = html.replace('async function testWbWorker(){', server_helpers + 'async function testWbWorker(){', 1)

html = between(
    html,
    'async function testWbWorker(){',
    'async function syncWbNow(){',
    "async function testWbWorker(){return checkMarketStatus('WB')}\n",
    'wb test function',
)
html = between(
    html,
    'async function syncWbNow(){',
    'async function syncNow(){',
    "async function syncWbNow(){return refreshWbFromServer()}\n",
    'wb sync function',
)

html = once(
    html,
    "document.getElementById('autoBackup').onchange=e=>{state.settings.autoBackup=e.target.checked;save()};openView(state.settings.activeView||'home',false);",
    "document.getElementById('autoBackup').onchange=e=>{state.settings.autoBackup=e.target.checked;save()};openView(state.settings.activeView||'home',false);loadSharedOrderCache({silent:true});setInterval(()=>loadSharedOrderCache({silent:true}),180000);",
    'initial shared cache load',
)

INDEX.write_text(html, encoding='utf-8')
print('index.html upgraded safely')
