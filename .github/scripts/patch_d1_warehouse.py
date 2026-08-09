from pathlib import Path

# Backend: D1 warehouse snapshot + normalized products.
p=Path('cloudflare/millioner-api/src/index.js')
s=p.read_text(encoding='utf-8')
marker="      if (url.pathname === '/api/sync-status' && request.method === 'GET') {"
insert="""      if (url.pathname === '/api/warehouse-state' && request.method === 'GET') {
        const row = await env.DB.prepare('SELECT payload,revision,updated_at FROM warehouse_state WHERE id=1').first();
        if (!row) return json({ ok: true, exists: false, revision: 0, updatedAt: null, state: null }, 200, cors);
        let warehouse = null;
        try { warehouse = JSON.parse(row.payload || '{}'); } catch { warehouse = {}; }
        return json({ ok: true, exists: true, revision: Number(row.revision || 0), updatedAt: Number(row.updated_at || 0), state: warehouse }, 200, cors);
      }

      if (url.pathname === '/api/warehouse-state' && request.method === 'PUT') {
        if (!isTrustedBrowserOrigin(origin, env)) return json({ ok: false, error: 'Forbidden origin' }, 403, cors);
        const body = await request.json();
        const warehouse = sanitizeWarehouseState(body?.state);
        const raw = JSON.stringify(warehouse);
        if (raw.length > 1500000) return json({ ok: false, error: 'Warehouse snapshot is too large' }, 413, cors);
        const current = await env.DB.prepare('SELECT revision FROM warehouse_state WHERE id=1').first();
        const currentRevision = Number(current?.revision || 0);
        const baseRevision = Number(body?.baseRevision || 0);
        if (current && baseRevision !== currentRevision) return json({ ok: false, error: 'revision-conflict', revision: currentRevision }, 409, cors);
        const nextRevision = currentRevision + 1;
        const now = Date.now();
        await env.DB.prepare(`INSERT INTO warehouse_state(id,payload,revision,updated_at) VALUES(1,?,?,?)
          ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,revision=excluded.revision,updated_at=excluded.updated_at`)
          .bind(raw,nextRevision,now).run();
        await importProducts(env.DB, warehouse.products || []);
        return json({ ok: true, revision: nextRevision, updatedAt: now, products: (warehouse.products || []).length }, 200, cors);
      }

"""+marker
if s.count(marker)!=1: raise SystemExit(f'backend endpoint marker count {s.count(marker)}')
s=s.replace(marker,insert,1)
schema="    `CREATE TABLE IF NOT EXISTS sync_runs (id INTEGER PRIMARY KEY AUTOINCREMENT,market TEXT NOT NULL,started_at INTEGER NOT NULL,finished_at INTEGER,ok INTEGER NOT NULL DEFAULT 0,items INTEGER NOT NULL DEFAULT 0,error TEXT NOT NULL DEFAULT '')`,"
if s.count(schema)!=1: raise SystemExit(f'schema marker count {s.count(schema)}')
s=s.replace(schema,schema+"\n    `CREATE TABLE IF NOT EXISTS warehouse_state (id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL DEFAULT '{}',revision INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL DEFAULT 0)`,",1)
fn='async function importProducts(db, products) {'
helpers="""function sanitizeWarehouseState(input) {
  const x = input && typeof input === 'object' ? input : {};
  const arr = key => Array.isArray(x[key]) ? x[key] : [];
  const obj = key => x[key] && typeof x[key] === 'object' && !Array.isArray(x[key]) ? x[key] : {};
  const settings = { ...obj('settings') };
  delete settings.serverMarketStatus; delete settings.wbToken; delete settings.kaspiToken;
  return { products:arr('products').slice(0,20000), movements:arr('movements').slice(0,5000), sales:arr('sales').slice(0,20000), purchases:arr('purchases').slice(0,20000), reservations:arr('reservations').slice(0,20000), settings, marketOrderState:obj('marketOrderState'), marketplaceLiveSince:obj('marketplaceLiveSince'), kaspiBaselineAt:x.kaspiBaselineAt||null };
}
function isTrustedBrowserOrigin(origin, env) {
  const allowed = String(env.CORS_ORIGIN || DEFAULT_CORS_ORIGIN).replace(/\\/$/, '');
  return String(origin || '').replace(/\\/$/, '') === allowed;
}

"""+fn
if s.count(fn)!=1: raise SystemExit(f'helper marker count {s.count(fn)}')
s=s.replace(fn,helpers,1)
if "'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'" not in s: raise SystemExit('cors methods marker missing')
s=s.replace("'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'","'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS'",1)
p.write_text(s,encoding='utf-8')

# Client: safe local-first migration, then D1 authoritative.
p=Path('index.html')
s=p.read_text(encoding='utf-8')
start="const save=()=>localStorage.setItem(KEY,JSON.stringify(state));"
end="const prod=id=>state.products.find(p=>p.id===id);"
i=s.find(start)
j=s.find(end,i)
if i<0 or j<0: raise SystemExit('save block markers missing')
j+=len(end)
new="""let warehouseRemoteReady=false,warehouseRemoteRevision=0,warehouseRemoteUpdatedAt=0,warehouseSaveTimer=null,warehouseSaveInFlight=false;
function saveLocalOnly(){localStorage.setItem(KEY,JSON.stringify(state))}
function warehouseSnapshot(){const settings={...(state.settings||{})};delete settings.serverMarketStatus;return {products:state.products||[],movements:state.movements||[],sales:state.sales||[],purchases:state.purchases||[],reservations:state.reservations||[],settings,marketOrderState:state.marketOrderState||{},marketplaceLiveSince:state.marketplaceLiveSince||{},kaspiBaselineAt:state.kaspiBaselineAt||null}}
function normalizeWarehouseSnapshot(x){x=x&&typeof x==='object'?x:{};return {products:Array.isArray(x.products)?x.products:[],movements:Array.isArray(x.movements)?x.movements:[],sales:Array.isArray(x.sales)?x.sales:[],purchases:Array.isArray(x.purchases)?x.purchases:[],reservations:Array.isArray(x.reservations)?x.reservations:[],settings:x.settings&&typeof x.settings==='object'?x.settings:{},marketOrderState:x.marketOrderState&&typeof x.marketOrderState==='object'?x.marketOrderState:{},marketplaceLiveSince:x.marketplaceLiveSince&&typeof x.marketplaceLiveSince==='object'?x.marketplaceLiveSince:{},kaspiBaselineAt:x.kaspiBaselineAt||null}}
function hasWarehouseData(x){return !!((x?.products?.length||0)+(x?.purchases?.length||0)+(x?.sales?.length||0)+(x?.movements?.length||0)+(x?.reservations?.length||0))}
function applyWarehouseSnapshot(remote){const snap=normalizeWarehouseSnapshot(remote),feeds={kaspiOrderFeed:state.kaspiOrderFeed||[],wbOrderFeed:state.wbOrderFeed||[],ozonOrderFeed:state.ozonOrderFeed||[],kaspiOrders:state.kaspiOrders||{}},localSettings={...(state.settings||{})};state={...state,...snap,...feeds};state.settings={...localSettings,...snap.settings};state.purchases.forEach(x=>{x.receivedAt=Number(x.receivedAt||x.date)||Date.now();x.remainingQty=Number.isFinite(Number(x.remainingQty))?Math.max(0,Number(x.remainingQty)):Math.max(0,Number(x.qty)||0);x.landedUnitCost=Number(x.landedUnitCost)||((Number(x.unitCost)||0)+((Number(x.delivery)||0)/(Math.max(1,Number(x.qty)||1))))})}
function scheduleWarehouseSave(){if(!warehouseRemoteReady)return;clearTimeout(warehouseSaveTimer);warehouseSaveTimer=setTimeout(()=>pushWarehouseToD1().catch(e=>console.warn('D1 warehouse save failed',e)),700)}
function save(){state.settings.localWarehouseUpdatedAt=Date.now();saveLocalOnly();scheduleWarehouseSave()}
async function pushWarehouseToD1(){if(!warehouseRemoteReady||warehouseSaveInFlight)return false;warehouseSaveInFlight=true;try{const r=await fetch(MILLIONER_API+'/api/warehouse-state',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({baseRevision:warehouseRemoteRevision,state:warehouseSnapshot()})});let data={};try{data=await r.json()}catch{}if(r.status===409){warehouseRemoteReady=false;throw new Error('D1 revision conflict; local copy kept safely')}if(!r.ok||data.ok===false)throw new Error(data.error||('HTTP '+r.status));warehouseRemoteRevision=Number(data.revision||warehouseRemoteRevision);warehouseRemoteUpdatedAt=Number(data.updatedAt||Date.now());state.settings.d1WarehouseRevision=warehouseRemoteRevision;state.settings.d1WarehouseUpdatedAt=warehouseRemoteUpdatedAt;state.settings.d1MigratedAt=state.settings.d1MigratedAt||Date.now();saveLocalOnly();return true}finally{warehouseSaveInFlight=false}}
async function bootstrapWarehouseD1(){const rawLocal=localStorage.getItem(KEY);if(rawLocal&&!localStorage.getItem(KEY+'_pre_d1'))localStorage.setItem(KEY+'_pre_d1',rawLocal);const localSnap=warehouseSnapshot();try{const r=await fetch(MILLIONER_API+'/api/warehouse-state',{cache:'no-store'});const data=await r.json();if(!r.ok||data.ok===false)throw new Error(data.error||('HTTP '+r.status));warehouseRemoteRevision=Number(data.revision||0);warehouseRemoteUpdatedAt=Number(data.updatedAt||0);if(!data.exists){warehouseRemoteReady=true;await pushWarehouseToD1();state.settings.d1MigratedAt=state.settings.d1MigratedAt||Date.now();saveLocalOnly();return {mode:'uploaded-local'}}const localUpdated=Number(state.settings.localWarehouseUpdatedAt||0);if(state.settings.d1MigratedAt&&localUpdated>warehouseRemoteUpdatedAt+2000&&hasWarehouseData(localSnap)){warehouseRemoteReady=true;await pushWarehouseToD1();return {mode:'recovered-newer-local'}}applyWarehouseSnapshot(data.state);warehouseRemoteReady=true;state.settings.d1WarehouseRevision=warehouseRemoteRevision;state.settings.d1WarehouseUpdatedAt=warehouseRemoteUpdatedAt;state.settings.d1MigratedAt=state.settings.d1MigratedAt||Date.now();saveLocalOnly();render();return {mode:'loaded-d1'}}catch(e){warehouseRemoteReady=false;console.warn('D1 warehouse bootstrap failed; keeping local data',e);return {mode:'local-fallback',error:String(e.message||e)}}}
const id=()=>Date.now().toString(36)+Math.random().toString(36).slice(2,7);const fmt=n=>new Intl.NumberFormat('ru-RU').format(Math.round(n||0))+' ₸';const esc=s=>String(s??'').replace(/[&<>\"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#039;'}[m]));const prod=id=>state.products.find(p=>p.id===id);"""
s=s[:i]+new+s[j:]
old="openView(state.settings.activeView||'home',false);loadSharedOrderCache({silent:true});setTimeout(()=>maybeAutoGoogleBackup(),2500);"
newstart="openView(state.settings.activeView||'home',false);bootstrapWarehouseD1().finally(()=>loadSharedOrderCache({silent:true}));setTimeout(()=>maybeAutoGoogleBackup(),2500);"
if s.count(old)!=1: raise SystemExit(f'startup marker count {s.count(old)}')
s=s.replace(old,newstart,1)
p.write_text(s,encoding='utf-8')

# Smoke contract.
p=Path('.github/workflows/smoke-test.yml')
s=p.read_text(encoding='utf-8')
check="              'unmatched filtered orders': 'const visibleOrders=unmatchedOrderFilter?unmatchedOrders:orders',"
if s.count(check)!=1: raise SystemExit('smoke marker missing')
s=s.replace(check,check+"\n              'D1 warehouse bootstrap': 'async function bootstrapWarehouseD1()',\n              'D1 warehouse save': 'async function pushWarehouseToD1()',\n              'D1 local safety copy': \"KEY+'_pre_d1'\",\n              'D1 warehouse API': \"'/api/warehouse-state'\",\n              'D1 warehouse table': 'CREATE TABLE IF NOT EXISTS warehouse_state',",1)
published="          grep -q '300000' /tmp/site.html"
if s.count(published)!=1: raise SystemExit('published marker missing')
s=s.replace(published,published+"\n          grep -q 'async function bootstrapWarehouseD1()' /tmp/site.html\n          grep -q \"KEY+'_pre_d1'\" /tmp/site.html",1)
health="      - name: Check Millioner API health"
if s.count(health)!=1: raise SystemExit('health marker missing')
s=s.replace(health,"""      - name: Check D1 warehouse endpoint
        run: |
          set -e
          body=$(curl -fsSL --retry 4 --retry-delay 3 --max-time 25 'https://millioner-api.7masok.workers.dev/api/warehouse-state')
          echo "$body" | jq -e '.ok == true and (.exists == true or .exists == false)'

"""+health,1)
p.write_text(s,encoding='utf-8')
