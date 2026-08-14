from pathlib import Path
import re

# Worker fast GET path before the expensive ensureSchema chain.
p = Path('cloudflare/millioner-api/src/index.js')
s = p.read_text(encoding='utf-8')
marker = "    try {\n      await ensureSchema(env.DB);"
fast = """    // WAREHOUSE_FAST_READ_V4: hot warehouse reads must not run the full schema chain.
    if (url.pathname === '/api/warehouse-state' && request.method === 'GET') {
      try {
        if (!isTrustedBrowserOrigin(origin, env)) return json({ ok: false, error: 'Forbidden origin' }, 403, cors);
        const metaOnly = url.searchParams.get('meta') === '1';
        const row = await env.DB.prepare(metaOnly ? 'SELECT revision,updated_at FROM warehouse_state WHERE id=1' : 'SELECT payload,revision,updated_at FROM warehouse_state WHERE id=1').first();
        if (!row) return json({ ok: true, exists: false, revision: 0, updatedAt: null, state: metaOnly ? undefined : null }, 200, cors);
        if (metaOnly) return json({ ok: true, exists: true, revision: Number(row.revision || 0), updatedAt: Number(row.updated_at || 0) }, 200, cors);
        let warehouse = null;
        try { warehouse = JSON.parse(row.payload || '{}'); } catch { warehouse = {}; }
        return json({ ok: true, exists: true, revision: Number(row.revision || 0), updatedAt: Number(row.updated_at || 0), state: warehouse }, 200, cors);
      } catch (e) {
        return json({ ok: false, error: 'warehouse-read: ' + String(e?.message || e) }, 500, cors);
      }
    }

"""
if 'WAREHOUSE_FAST_READ_V4' not in s:
    if marker not in s:
        raise SystemExit('worker insertion marker missing')
    s = s.replace(marker, fast + marker, 1)
p.write_text(s, encoding='utf-8')

# Browser sync: meta first, mobile-friendly timeouts, and explicit full-pull state.
p = Path('cloud-sync-v3.js')
s = p.read_text(encoding='utf-8')
if 'let warehouseCloudNeedsFull=false;' not in s:
    s = s.replace(
        "const sleep=ms=>new Promise(r=>setTimeout(r,ms));",
        "const sleep=ms=>new Promise(r=>setTimeout(r,ms));\nlet warehouseCloudNeedsFull=false;",
        1,
    )
s = s.replace('meta?12000:35000', 'meta?30000:90000')
s = s.replace(
    'if(!warehouseRemoteReady||warehouseSaveInFlight||!warehouseLocalDirty)return false;',
    'if(!warehouseRemoteReady||warehouseCloudNeedsFull||warehouseSaveInFlight||!warehouseLocalDirty)return false;',
)
s = s.replace(
    'const remoteRevision=Number(meta.revision||0),remoteUpdated=Number(meta.updatedAt||0),needFull=!warehouseRemoteReady||remoteRevision>warehouseRemoteRevision;',
    'const remoteRevision=Number(meta.revision||0),remoteUpdated=Number(meta.updatedAt||0),needFull=warehouseCloudNeedsFull||!warehouseRemoteReady||remoteRevision>warehouseRemoteRevision;',
)
s = s.replace(
    'const data=await fetchCloudJson(false,3),remoteSnap=coreSnapshot(data.state),rev=Number(data.revision||remoteRevision),upd=Number(data.updatedAt||remoteUpdated);',
    'const data=await fetchCloudJson(false,3),remoteSnap=coreSnapshot(data.state),rev=Number(data.revision||remoteRevision),upd=Number(data.updatedAt||remoteUpdated);warehouseCloudNeedsFull=false;',
)

start = s.find('bootstrapWarehouseD1=async function(){')
end = s.find('\n};\n\nstartWarehouseCloudWatcher=', start)
if start < 0 or end < 0:
    raise SystemExit('bootstrap block missing')
new_boot = r'''bootstrapWarehouseD1=async function(){
  const rawLocal=localStorage.getItem(KEY);if(rawLocal&&!localStorage.getItem(KEY+'_pre_d1'))localStorage.setItem(KEY+'_pre_d1',rawLocal);if(rawLocal&&!localStorage.getItem(KEY+'_pre_cloud_v3'))localStorage.setItem(KEY+'_pre_cloud_v3',rawLocal);
  const localSnap=coreSnapshot(state);cloudStatus('подключение…','warn');
  try{
    const meta=await fetchCloudJson(true,3);
    warehouseRemoteRevision=Number(meta.revision||0);warehouseRemoteUpdatedAt=Number(meta.updatedAt||0);warehouseRemoteReady=true;
    if(!meta.exists){warehouseCloudNeedsFull=false;warehouseLastCloudSnapshot=coreSnapshot({});warehouseLastSyncedText=coreText({});markWarehouseDirty();localStorage.setItem(CLOUD_V3_KEY,'1');cloudStatus('подключено · сохраняю данные','warn');scheduleWarehouseSave(0);return {mode:'uploaded-local'};}
    const knownRevision=Number(state.settings.d1WarehouseRevision||0),firstV3=localStorage.getItem(CLOUD_V3_KEY)!=='1';
    if(!warehouseLocalDirty&&knownRevision===warehouseRemoteRevision&&coreHasData(localSnap)){
      warehouseCloudNeedsFull=false;warehouseLastCloudSnapshot=localSnap;warehouseLastSyncedText=coreText(localSnap);localStorage.setItem(CLOUD_V3_KEY,'1');clearWarehouseDirty();state.settings.d1WarehouseRevision=warehouseRemoteRevision;state.settings.d1WarehouseUpdatedAt=warehouseRemoteUpdatedAt;state.settings.d1MigratedAt=state.settings.d1MigratedAt||Date.now();saveLocalOnly();cloudStatus('синхронизировано','ok');render();return {mode:'meta-current'};
    }
    cloudStatus('подключено · загружаю данные…','warn');
    let data;
    try{data=await fetchCloudJson(false,3)}catch(e){warehouseCloudNeedsFull=true;console.warn('D1 meta online, full snapshot pending',e);cloudStatus('облако доступно · повтор загрузки','warn');return {mode:'meta-only',error:String(e?.message||e)}}
    warehouseCloudNeedsFull=false;
    const remoteSnap=coreSnapshot(data.state),remoteText=coreText(remoteSnap);warehouseRemoteRevision=Number(data.revision||warehouseRemoteRevision);warehouseRemoteUpdatedAt=Number(data.updatedAt||warehouseRemoteUpdatedAt);warehouseLastCloudSnapshot=remoteSnap;warehouseLastSyncedText=remoteText;
    let chosen=remoteSnap;if(warehouseLocalDirty)chosen=mergeDirtyPreferLocal(remoteSnap,localSnap);else if(firstV3&&coreHasData(localSnap))chosen=mergeUniquePreferRemote(remoteSnap,localSnap);
    applyWarehouseSnapshot(chosen);saveLocalOnly();localStorage.setItem(CLOUD_V3_KEY,'1');
    if(coreText(chosen)!==remoteText){markWarehouseDirty();cloudStatus('подключено · сохраняю изменения','warn');scheduleWarehouseSave(0)}else{clearWarehouseDirty();cloudStatus('синхронизировано','ok')}
    state.settings.d1WarehouseRevision=warehouseRemoteRevision;state.settings.d1WarehouseUpdatedAt=warehouseRemoteUpdatedAt;state.settings.d1MigratedAt=state.settings.d1MigratedAt||Date.now();saveLocalOnly();render();return {mode:'loaded-d1-v4'};
  }catch(e){warehouseRemoteReady=false;warehouseCloudNeedsFull=true;const msg=e?.name==='AbortError'?'таймаут Cloudflare':String(e?.message||e);console.warn('D1 warehouse bootstrap failed',e);cloudStatus('ошибка облака · '+msg.slice(0,70),'warn');return {mode:'local-fallback',error:msg}}
}'''
s = s[:start] + new_boot + s[end + 3:]
p.write_text(s, encoding='utf-8')

# Cache bust for Android Chrome.
p = Path('index.html')
s = p.read_text(encoding='utf-8')
s = re.sub(r"cloud-sync-v3\.js\?v=[^\"']+", 'cloud-sync-v3.js?v=20260814v4', s)
p.write_text(s, encoding='utf-8')
