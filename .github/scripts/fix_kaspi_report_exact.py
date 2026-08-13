from pathlib import Path
import re

server_path = Path('cloudflare/millioner-api/src/index.js')
s = server_path.read_text(encoding='utf-8')

old = "async function fetchKaspiWorkerFeed(base, params, serviceBinding = null) {"
new = "async function fetchKaspiWorkerFeed(base, params, serviceBinding = null, maxBatches = KASPI_MAX_BATCHES) {"
if old in s:
    s = s.replace(old, new, 1)
old = "for (let safety = 0; safety < KASPI_MAX_BATCHES; safety++) {"
new = "for (let safety = 0; safety < Math.max(1, Math.min(20, Number(maxBatches) || KASPI_MAX_BATCHES)); safety++) {"
if old in s:
    s = s.replace(old, new, 1)
old = "q.set('filter[orders][state]', state);"
new = "if (state) q.set('filter[orders][state]', state);"
if old in s:
    s = s.replace(old, new, 1)
marker = "      if (url.pathname === '/api/products' && request.method === 'GET') {"
if '/api/kaspi-report-orders' not in s:
    if marker not in s:
        raise SystemExit('products route marker missing')
    route = r'''      if (url.pathname === '/api/kaspi-report-orders' && request.method === 'GET') {
        const rawDays = Number(url.searchParams.get('days') || 1);
        const lookback = rawDays === -1 ? 2 : Math.max(1, Math.min(90, rawDays || 1));
        const warnings = [];
        let workerFeed = { orders: [], requests: 0 };
        let directFeed = { orders: [], requests: 0 };
        const base = cleanUrl(env.KASPI_WORKER_URL);
        if (base) {
          try { workerFeed = await fetchKaspiWorkerFeed(base, { days: String(Math.min(14, lookback)) }, env.KASPI_WORKER, 20); }
          catch (e) { warnings.push('worker: ' + String(e?.message || e)); }
        } else warnings.push('worker: KASPI_WORKER_URL is not configured');
        const token = String(env.KASPI_TOKEN || '').trim();
        if (token) {
          try { directFeed = await fetchKaspiOrdersDirect(token, { days: lookback, state: '' }); }
          catch (e) { warnings.push('direct: ' + String(e?.message || e)); }
        } else warnings.push('direct: KASPI_TOKEN is not configured');
        const byId = new Map();
        for (const order of workerFeed.orders || []) { const key = String(order?.id || order?.code || ''); if (key) byId.set(key, order); }
        for (const order of directFeed.orders || []) {
          const key = String(order?.id || order?.code || ''); if (!key) continue;
          const previous = byId.get(key) || {};
          const lines = Array.isArray(previous?.lines) && previous.lines.length ? previous.lines : (Array.isArray(order?.lines) ? order.lines : []);
          byId.set(key, { ...previous, ...order, lines });
        }
        const orders = [...byId.values()].sort((a,b)=>(Number(b?.creationDate)||0)-(Number(a?.creationDate)||0));
        if (!orders.length && warnings.length >= 2) return json({ ok:false, error:warnings.join('; ') }, 502, cors);
        return json({ ok:true, days:rawDays, lookback, fetchedAt:Date.now(), source:token?'Kaspi API totalPrice + detailed Worker':'Kaspi detailed Worker', warnings, orders }, 200, cors);
      }

'''
    s = s.replace(marker, route + marker, 1)
server_path.write_text(s, encoding='utf-8')

html_path = Path('index.html')
h = html_path.read_text(encoding='utf-8')
start = h.index('<section id="reports"')
end = h.index('</section>', start) + len('</section>')
section = '''<section id="reports" class="view"><h2>Отчёты · Kaspi</h2><div id="reportPeriod" class="period"><button class="chip" data-report-period="1" onclick="setReportPeriod(1)">Сегодня</button><button class="chip" data-report-period="-1" onclick="setReportPeriod(-1)">Вчера</button><button class="chip" data-report-period="7" onclick="setReportPeriod(7)">7 дней</button><button class="chip" data-report-period="30" onclick="setReportPeriod(30)">30 дней</button><button class="chip" data-report-period="0" onclick="setReportPeriod(0)">Свой период</button></div><div class="kpi"><div class="card"><div class="label">Выручка</div><div class="num" id="rRevenue">—</div></div><div class="card"><div class="label">Себестоимость</div><div class="num" id="rCost">—</div></div><div class="card"><div class="label">Расходы Kaspi</div><div class="num" id="rFees">—</div></div><div class="card"><div class="label">Прибыль</div><div class="num" id="rProfit">—</div></div><div class="card"><div class="label">Реклама Kaspi</div><div class="num" id="rAds">—</div></div></div><h2>Kaspi</h2><div id="mpReport"><div class="empty">Загрузка Kaspi…</div></div></section>'''
h = h[:start] + section + h[end:]
rs = h.index('function renderReports(')
re_ = h.index('function marketplaceProductStats(', rs)
preload = '''function renderReports(){document.querySelectorAll('[data-report-period]').forEach(b=>b.classList.toggle('active',Number(b.dataset.reportPeriod)===reportPeriodPreset));for(const id of ['rRevenue','rCost','rFees','rAds','rProfit']){const e=document.getElementById(id);if(e)e.textContent='…'}const box=document.getElementById('mpReport');if(box)box.innerHTML='<div class="empty">Загружаю Kaspi…</div>'}\n'''
h = h[:rs] + preload + h[re_:]
pattern = r'<script src="\./(?:kaspi-auto-finance|kaspi-report-v2)\.js\?v=[^"]+"></script>'
replacement = '<script src="./kaspi-report-v2.js?v=20260814f"></script>'
if re.search(pattern, h): h = re.sub(pattern, replacement, h, count=1)
else: raise SystemExit('Kaspi report script tag marker missing')
html_path.write_text(h, encoding='utf-8')
if 'Реклама Kaspi</b><span id="kaspiAdsBadge"' in h: raise SystemExit('old standalone Kaspi ad block still present')
if '<h2>Отчёты · Kaspi</h2>' not in h: raise SystemExit('Kaspi static report missing')
if './kaspi-report-v2.js?v=20260814f' not in h: raise SystemExit('new Kaspi report module not linked')
if '/api/kaspi-report-orders' not in s: raise SystemExit('Kaspi report endpoint missing')
print('Kaspi report patch applied')
