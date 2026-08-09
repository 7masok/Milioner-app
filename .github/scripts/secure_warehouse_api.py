from pathlib import Path
p=Path('cloudflare/millioner-api/src/index.js')
s=p.read_text(encoding='utf-8')
old="""      if (url.pathname === '/api/warehouse-state' && request.method === 'GET') {
        const row = await env.DB.prepare('SELECT payload,revision,updated_at FROM warehouse_state WHERE id=1').first();"""
new="""      if (url.pathname === '/api/warehouse-state' && request.method === 'GET') {
        if (!isTrustedBrowserOrigin(origin, env)) return json({ ok: false, error: 'Forbidden origin' }, 403, cors);
        const row = await env.DB.prepare('SELECT payload,revision,updated_at FROM warehouse_state WHERE id=1').first();"""
if s.count(old)!=1: raise SystemExit(f'warehouse GET marker count {s.count(old)}')
s=s.replace(old,new,1)
p.write_text(s,encoding='utf-8')
