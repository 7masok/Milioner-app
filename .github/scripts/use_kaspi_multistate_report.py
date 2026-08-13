from pathlib import Path
p=Path('cloudflare/millioner-api/src/index.js')
s=p.read_text(encoding='utf-8')
start=s.index("      if (url.pathname === '/api/kaspi-report-orders' && request.method === 'GET') {")
end=s.index("      if (url.pathname === '/api/products' && request.method === 'GET') {",start)
route="""      if (url.pathname === '/api/kaspi-report-orders' && request.method === 'GET') {
        const rawDays = Number(url.searchParams.get('days') || 1);
        const base = cleanUrl(env.KASPI_WORKER_URL) || 'https://kaspi-worker.internal';
        const specs = [
          { days: 2, state: '' },
          { days: 14, state: 'KASPI_DELIVERY' },
          { days: 14, state: 'PICKUP' },
          { days: 14, state: 'DELIVERY' },
          { days: 14, state: 'NEW' },
          { days: 14, state: 'SIGN_REQUIRED' },
          { days: 14, state: 'ARCHIVE' }
        ];
        try {
          const chunks = await Promise.all(specs.map(async spec => {
            const q = new URLSearchParams();
            q.set('days', String(spec.days));
            if (spec.state) q.set('state', spec.state);
            const req = new Request(`${base}/kaspi/orders?${q.toString()}`, { headers: { 'Accept':'application/json' } });
            const response = env.KASPI_WORKER ? await env.KASPI_WORKER.fetch(req) : await fetch(req);
            const data = await safeJson(response, `Kaspi raw orders ${spec.state || 'ALL'}`);
            if (!response.ok) throw new Error(data?.error || data?.message || `Kaspi Worker HTTP ${response.status}`);
            return { spec, items: Array.isArray(data?.data) ? data.data : [] };
          }));
          const byId = new Map();
          const counts = {};
          for (const chunk of chunks) {
            counts[chunk.spec.state || 'ALL2'] = chunk.items.length;
            for (const item of chunk.items) {
              const a = item?.attributes || {};
              const id = String(item?.id || a?.code || '');
              if (!id) continue;
              byId.set(id, {
                id:String(item?.id || ''), code:String(a?.code || ''), status:String(a?.status || ''), state:String(a?.state || ''),
                creationDate:toTimestamp(a?.creationDate), completionDate:toTimestamp(a?.completionDate), approvedByBankDate:toTimestamp(a?.approvedByBankDate),
                totalPrice:Number(a?.totalPrice || 0), deliveryCostForSeller:Number(a?.deliveryCostForSeller || 0), lines:[]
              });
            }
          }
          const orders = [...byId.values()];
          return json({ ok:true, days:rawDays, fetchedAt:Date.now(), source:'Kaspi multi-state '+JSON.stringify(counts), orders }, 200, cors);
        } catch (e) {
          return json({ ok:false, error:String(e?.message || e) }, 502, cors);
        }
      }

"""
s=s[:start]+route+s[end:]
p.write_text(s,encoding='utf-8')
print('switched report to multi-state Kaspi source')
