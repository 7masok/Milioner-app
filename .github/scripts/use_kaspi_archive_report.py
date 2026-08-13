from pathlib import Path
p=Path('cloudflare/millioner-api/src/index.js')
s=p.read_text(encoding='utf-8')
start=s.index("      if (url.pathname === '/api/kaspi-report-orders' && request.method === 'GET') {")
end=s.index("      if (url.pathname === '/api/products' && request.method === 'GET') {",start)
route="""      if (url.pathname === '/api/kaspi-report-orders' && request.method === 'GET') {
        const rawDays = Number(url.searchParams.get('days') || 1);
        const workerDays = 14;
        const base = cleanUrl(env.KASPI_WORKER_URL) || 'https://kaspi-worker.internal';
        const q = new URLSearchParams();
        q.set('days', String(workerDays));
        q.set('state', 'ARCHIVE');
        const req = new Request(`${base}/kaspi/orders?${q.toString()}`, { headers: { 'Accept':'application/json' } });
        try {
          const response = env.KASPI_WORKER ? await env.KASPI_WORKER.fetch(req) : await fetch(req);
          const data = await safeJson(response, 'Kaspi archived raw orders');
          if (!response.ok) throw new Error(data?.error || data?.message || `Kaspi Worker HTTP ${response.status}`);
          const items = Array.isArray(data?.data) ? data.data : [];
          const orders = items.map(item => {
            const a = item?.attributes || {};
            return {
              id:String(item?.id || ''), code:String(a?.code || ''), status:String(a?.status || ''), state:String(a?.state || ''),
              creationDate:toTimestamp(a?.creationDate), completionDate:toTimestamp(a?.completionDate), approvedByBankDate:toTimestamp(a?.approvedByBankDate),
              totalPrice:Number(a?.totalPrice || 0), deliveryCostForSeller:Number(a?.deliveryCostForSeller || 0), lines:[]
            };
          });
          return json({ ok:true, days:rawDays, workerDays, fetchedAt:Date.now(), source:'Kaspi archive completionDate', orders }, 200, cors);
        } catch (e) {
          return json({ ok:false, error:String(e?.message || e) }, 502, cors);
        }
      }

"""
s=s[:start]+route+s[end:]
p.write_text(s,encoding='utf-8')
print('switched report to archived Kaspi orders')
