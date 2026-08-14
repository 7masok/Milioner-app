from pathlib import Path

# Patch browser boot so the external v3 sync module loads before bootstrap runs.
p=Path('index.html')
s=p.read_text(encoding='utf-8')
old="openView(state.settings.activeView||'home',false);bootstrapWarehouseD1().finally(()=>{startWarehouseCloudWatcher();return loadSharedOrderCache({silent:true})});setTimeout(()=>maybeAutoGoogleBackup(),2500);"
new="openView(state.settings.activeView||'home',false);setTimeout(()=>bootstrapWarehouseD1().finally(()=>{startWarehouseCloudWatcher();return loadSharedOrderCache({silent:true})}),0);setTimeout(()=>maybeAutoGoogleBackup(),2500);"
if old in s:
    s=s.replace(old,new,1)
elif new not in s:
    raise SystemExit('bootstrap marker missing')
old_tag='<script src="./kaspi-report-v2.js?v=20260814h"></script>'
new_tag='<script src="./cloud-sync-v3.js?v=20260814a"></script>\n'+old_tag
if './cloud-sync-v3.js?' not in s:
    if old_tag not in s: raise SystemExit('Kaspi script marker missing')
    s=s.replace(old_tag,new_tag,1)
p.write_text(s,encoding='utf-8')

# Add a lightweight metadata mode to the D1 warehouse endpoint.
p=Path('cloudflare/millioner-api/src/index.js')
s=p.read_text(encoding='utf-8')
old="""      if (url.pathname === '/api/warehouse-state' && request.method === 'GET') {
        if (!isTrustedBrowserOrigin(origin, env)) return json({ ok: false, error: 'Forbidden origin' }, 403, cors);
        const row = await env.DB.prepare('SELECT payload,revision,updated_at FROM warehouse_state WHERE id=1').first();
        if (!row) return json({ ok: true, exists: false, revision: 0, updatedAt: null, state: null }, 200, cors);
        let warehouse = null;
        try { warehouse = JSON.parse(row.payload || '{}'); } catch { warehouse = {}; }
        return json({ ok: true, exists: true, revision: Number(row.revision || 0), updatedAt: Number(row.updated_at || 0), state: warehouse }, 200, cors);
      }
"""
new="""      if (url.pathname === '/api/warehouse-state' && request.method === 'GET') {
        if (!isTrustedBrowserOrigin(origin, env)) return json({ ok: false, error: 'Forbidden origin' }, 403, cors);
        const metaOnly = url.searchParams.get('meta') === '1';
        const row = await env.DB.prepare(metaOnly ? 'SELECT revision,updated_at FROM warehouse_state WHERE id=1' : 'SELECT payload,revision,updated_at FROM warehouse_state WHERE id=1').first();
        if (!row) return json({ ok: true, exists: false, revision: 0, updatedAt: null, state: metaOnly ? undefined : null }, 200, cors);
        if (metaOnly) return json({ ok: true, exists: true, revision: Number(row.revision || 0), updatedAt: Number(row.updated_at || 0) }, 200, cors);
        let warehouse = null;
        try { warehouse = JSON.parse(row.payload || '{}'); } catch { warehouse = {}; }
        return json({ ok: true, exists: true, revision: Number(row.revision || 0), updatedAt: Number(row.updated_at || 0), state: warehouse }, 200, cors);
      }
"""
if old in s:
    s=s.replace(old,new,1)
elif "const metaOnly = url.searchParams.get('meta') === '1';" not in s:
    raise SystemExit('warehouse GET route marker missing')
p.write_text(s,encoding='utf-8')
print('cloud sync v3 patch applied')
