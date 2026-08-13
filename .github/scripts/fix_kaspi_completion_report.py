from pathlib import Path

p=Path('cloudflare/millioner-api/src/index.js')
s=p.read_text(encoding='utf-8')

s=s.replace("async function fetchKaspiOrdersDirect(token, { days = 7, state = 'KASPI_DELIVERY' } = {}) {","async function fetchKaspiOrdersDirect(token, { days = 7, state = 'KASPI_DELIVERY', status = '' } = {}) {",1)
s=s.replace("    if (state) q.set('filter[orders][state]', state);\n    q.set('filter[orders][creationDate][$ge]', String(start));","    if (state) q.set('filter[orders][state]', state);\n    if (status) q.set('filter[orders][status]', status);\n    q.set('filter[orders][creationDate][$ge]', String(start));",1)
s=s.replace("        creationDate: toTimestamp(attrs?.creationDate),\n        totalPrice: Number(attrs?.totalPrice || 0),","        creationDate: toTimestamp(attrs?.creationDate),\n        completionDate: toTimestamp(attrs?.completionDate),\n        approvedByBankDate: toTimestamp(attrs?.approvedByBankDate),\n        totalPrice: Number(attrs?.totalPrice || 0),",1)

start=s.index("      if (url.pathname === '/api/kaspi-report-orders' && request.method === 'GET') {")
end=s.index("      if (url.pathname === '/api/products' && request.method === 'GET') {",start)
route="""      if (url.pathname === '/api/kaspi-report-orders' && request.method === 'GET') {
        const rawDays = Number(url.searchParams.get('days') || 1);
        const requestedDays = rawDays === -1 ? 1 : Math.max(1, Math.min(90, rawDays || 1));
        const lookback = Math.min(90, Math.max(30, requestedDays + 30));
        const token = String(env.KASPI_TOKEN || '').trim();
        if (!token) return json({ ok:false, error:'KASPI_TOKEN is not configured' }, 500, cors);
        try {
          const directFeed = await fetchKaspiOrdersDirect(token, { days: lookback, state: '', status: 'COMPLETED' });
          const orders = (directFeed.orders || []).filter(o => String(o?.status || '').toUpperCase() === 'COMPLETED');
          return json({ ok:true, days:rawDays, lookback, fetchedAt:Date.now(), source:'Kaspi API completionDate', requests:directFeed.requests || 0, orders }, 200, cors);
        } catch (e) {
          return json({ ok:false, error:String(e?.message || e) }, 502, cors);
        }
      }

"""
s=s[:start]+route+s[end:]
p.write_text(s,encoding='utf-8')

p=Path('kaspi-report-v2.js')
s=p.read_text(encoding='utf-8')
old="const ts=Number(o.creationDate)||0;if(ts>=start&&ts<end&&!isCancelledOrder(o))orders.push(o)"
new="const ts=Number(o.completionDate)||0;if(ts>=start&&ts<end&&String(o.status||'').toUpperCase()==='COMPLETED')orders.push(o)"
if old not in s: raise SystemExit('client date marker missing')
s=s.replace(old,new,1)
old="loadKaspiOrders(reportPeriod).then(s=>{if(seq!==renderSeq)return;renderKpis(buildModel(s,reportPeriod))}).catch(e=>{if(seq!==renderSeq)return;console.warn('Kaspi report orders',e);renderKpis(fallbackModel(reportPeriod))})"
new="loadKaspiOrders(reportPeriod).then(s=>{if(seq!==renderSeq)return;renderKpis(buildModel(s,reportPeriod))}).catch(e=>{if(seq!==renderSeq)return;console.warn('Kaspi report orders',e);for(const id of['rRevenue','rCost','rFees','rAds','rProfit']){const el=document.getElementById(id);if(el)el.textContent='—'}const box=document.getElementById('mpReport');if(box)box.innerHTML='<div class=\"empty\">Не удалось загрузить выкупы Kaspi. Нажмите обновить.</div>'})"
if old not in s: raise SystemExit('client catch marker missing')
s=s.replace(old,new,1)
p.write_text(s,encoding='utf-8')

p=Path('index.html')
s=p.read_text(encoding='utf-8')
s=s.replace('./kaspi-report-v2.js?v=20260814f','./kaspi-report-v2.js?v=20260814g',1)
p.write_text(s,encoding='utf-8')
print('patched completionDate report')
