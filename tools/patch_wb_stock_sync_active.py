from pathlib import Path

p=Path('cloudflare/millioner-api/src/index.js')
s=p.read_text(encoding='utf-8')
if "async function previewWbStockMarket" not in s or "function computeSharedAvailableStocks" not in s:
    raise SystemExit('WB preview base is missing; refusing active stock patch')

schema_anchor="    `CREATE TABLE IF NOT EXISTS wb_stock_links (market TEXT NOT NULL,sku TEXT NOT NULL,chrt_id INTEGER NOT NULL,source TEXT NOT NULL DEFAULT '',updated_at INTEGER NOT NULL,PRIMARY KEY(market,sku))`,\n"
schema_insert=schema_anchor+"    `CREATE TABLE IF NOT EXISTS wb_stock_state (market TEXT PRIMARY KEY,warehouse_id TEXT NOT NULL DEFAULT '',payload_hash TEXT NOT NULL DEFAULT '',last_sent_at INTEGER NOT NULL DEFAULT 0,last_items INTEGER NOT NULL DEFAULT 0,last_error TEXT NOT NULL DEFAULT '',updated_at INTEGER NOT NULL DEFAULT 0)`,\n"
if 'CREATE TABLE IF NOT EXISTS wb_stock_state' not in s:
    if s.count(schema_anchor)!=1: raise SystemExit('wb_stock_links schema anchor mismatch')
    s=s.replace(schema_anchor,schema_insert,1)

old_status="""async function getStockSyncStatus(db) {
  const rows = [];
  for (const market of ['WB','WB2']) {
    const latest = await db.prepare('SELECT * FROM stock_sync_runs WHERE market=? ORDER BY id DESC LIMIT 1').bind(market).first();
    rows.push({ market, latest: latest || null, ready: Boolean(latest?.ok && Number(latest?.linked || 0) > 0 && Number(latest?.missing || 0) === 0 && String(latest?.warehouse_id || '')) });
  }
  return rows;
}
"""
new_status="""async function getStockSyncStatus(db) {
  const rows = [];
  for (const market of ['WB','WB2']) {
    const latest = await db.prepare('SELECT * FROM stock_sync_runs WHERE market=? ORDER BY id DESC LIMIT 1').bind(market).first();
    const preview = await db.prepare(\"SELECT * FROM stock_sync_runs WHERE market=? AND mode='preview' AND ok=1 ORDER BY id DESC LIMIT 1\").bind(market).first();
    const write = await db.prepare(\"SELECT * FROM stock_sync_runs WHERE market=? AND mode='write' ORDER BY id DESC LIMIT 1\").bind(market).first();
    const state = await db.prepare('SELECT * FROM wb_stock_state WHERE market=?').bind(market).first();
    rows.push({ market, latest: latest || null, preview: preview || null, lastWrite: write || null, state: state || null, ready: Boolean(preview?.ok && Number(preview?.linked || 0) > 0 && Number(preview?.missing || 0) === 0 && String(preview?.warehouse_id || '')), active: Boolean(write?.ok && Number(state?.last_sent_at || 0) > 0) });
  }
  return rows;
}
"""
if old_status in s:
    s=s.replace(old_status,new_status,1)
elif 'lastWrite:' not in s:
    raise SystemExit('getStockSyncStatus anchor mismatch')

s=s.replace("return json({ ok: true, serverTime: Date.now(), mode: 'preview', markets: stocks }, 200, cors);","return json({ ok: true, serverTime: Date.now(), mode: 'active', markets: stocks }, 200, cors);",1)

old_sched="""      const stocks = {};
      for (const market of ['WB','WB2']) {
        try { stocks[market] = await previewWbStockMarket(env, market, { force: false }); }
        catch (e) { stocks[market] = { ok: false, error: String(e?.message || e) }; }
      }
      return { orders, stocks };
"""
new_sched="""      const stocks = {};
      for (const market of ['WB','WB2']) {
        try { stocks[market] = await syncWbStockMarket(env, market, { force: false }); }
        catch (e) { stocks[market] = { ok: false, error: String(e?.message || e) }; }
      }
      return { orders, stocks };
"""
if old_sched in s:
    s=s.replace(old_sched,new_sched,1)
elif 'syncWbStockMarket(env, market' not in s:
    raise SystemExit('scheduled stock preview anchor mismatch')

anchor="async function previewWbStockMarket(env, market='WB', { force = false } = {}) {\n"
active=r'''async function stockPayloadHash(items) {
  const text = (items || []).slice().sort((a,b)=>Number(a.chrtId)-Number(b.chrtId)).map(x => String(Number(x.chrtId)) + ':' + String(Math.max(0,Math.floor(Number(x.amount)||0)))).join('|');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');
}

async function readWbCachedStockLinks(db, market, linked) {
  const rows = await db.prepare('SELECT sku,chrt_id AS chrtId FROM wb_stock_links WHERE market=?').bind(market).all();
  const map = new Map((rows.results || []).map(x => [String(x.sku || ''), Number(x.chrtId || 0)]));
  return (linked || []).map(x => ({ product:x.product, sku:x.sku, chrtId:Number(map.get(String(x.sku)) || 0) }));
}

async function syncWbStockMarket(env, market='WB', { force = false } = {}) {
  if (!['WB','WB2'].includes(market)) throw new Error('Unsupported WB stock market');
  const token = String((market === 'WB2' ? env.WB_TOKEN_2 : env.WB_TOKEN) || '').trim();
  if (!token) throw new Error((market === 'WB2' ? 'WB_TOKEN_2' : 'WB_TOKEN') + ' is not configured');
  const warehouse = await loadWarehouseSnapshotForStock(env.DB);
  if (!(warehouse.products || []).length) return { ok:true, market, skipped:true, reason:'warehouse-empty-safety', sent:false };
  const linked = wbLinkedProducts(warehouse, market);
  if (!linked.length) return { ok:true, market, skipped:true, reason:'no-linked-products', sent:false };

  let preview = await env.DB.prepare("SELECT * FROM stock_sync_runs WHERE market=? AND mode='preview' AND ok=1 ORDER BY id DESC LIMIT 1").bind(market).first();
  if (!preview || !String(preview.warehouse_id || '') || Number(preview.missing || 0) > 0 || Number(preview.mapped || 0) < linked.length) {
    const check = await previewWbStockMarket(env, market, { force: false });
    if (!check?.ready) return { ok:true, market, skipped:true, reason:'mapping-not-ready', sent:false, preview:check };
    preview = await env.DB.prepare("SELECT * FROM stock_sync_runs WHERE market=? AND mode='preview' AND ok=1 ORDER BY id DESC LIMIT 1").bind(market).first();
  }
  const warehouseId = String(preview?.warehouse_id || '').trim();
  if (!warehouseId) return { ok:true, market, skipped:true, reason:'warehouse-not-ready', sent:false };

  let mapped = await readWbCachedStockLinks(env.DB, market, linked);
  if (mapped.some(x => !x.chrtId)) {
    const check = await previewWbStockMarket(env, market, { force: true });
    if (!check?.ready) return { ok:true, market, skipped:true, reason:'chrt-mapping-not-ready', sent:false, preview:check };
    mapped = await readWbCachedStockLinks(env.DB, market, linked);
  }
  if (mapped.some(x => !x.chrtId) || mapped.length !== linked.length) return { ok:true, market, skipped:true, reason:'partial-mapping-safety', sent:false };

  const orderRows = await env.DB.prepare("SELECT market,order_id AS orderId,entry_id AS entryId,status,state,creation_date AS creationDate,sku,qty FROM marketplace_order_lines WHERE market IN ('Kaspi','WB','WB2')").all();
  const amounts = computeSharedAvailableStocks(warehouse, orderRows.results || []);
  const items = mapped.map(x => ({ chrtId:x.chrtId, amount:Math.max(0,Math.floor(Number(amounts.get(String(x.product.id))) || 0)) }));
  if (!items.length) return { ok:true, market, skipped:true, reason:'empty-payload-safety', sent:false };
  const hash = await stockPayloadHash(items);
  const previous = await env.DB.prepare('SELECT * FROM wb_stock_state WHERE market=?').bind(market).first();
  if (!force && previous && String(previous.warehouse_id || '') === warehouseId && String(previous.payload_hash || '') === hash) {
    return { ok:true, market, skipped:true, reason:'unchanged', sent:false, warehouseId, items:items.length, lastSentAt:Number(previous.last_sent_at || 0) };
  }

  const startedAt = Date.now();
  const run = await env.DB.prepare("INSERT INTO stock_sync_runs(market,mode,started_at,warehouse_id,linked,mapped,missing,items) VALUES(?,'write',?,?,?,?,0,?) RETURNING id")
    .bind(market,startedAt,warehouseId,linked.length,mapped.length,items.length).first();
  try {
    const headers = { 'Accept':'application/json', 'Content-Type':'application/json', 'Authorization':token };
    for (let i=0;i<items.length;i+=1000) {
      const chunk=items.slice(i,i+1000);
      const r=await fetch(WB_MARKETPLACE_BASE + '/api/v3/stocks/' + encodeURIComponent(warehouseId), { method:'PUT', headers, body:JSON.stringify({ stocks:chunk }) });
      const text=await r.text();
      let data=null; if(text){ try{data=JSON.parse(text)}catch{data={message:text.slice(0,500)}} }
      if(!r.ok) throw new Error(wbError('WB stocks',r.status,data||{}));
    }
    const now=Date.now();
    await env.DB.prepare("INSERT INTO wb_stock_state(market,warehouse_id,payload_hash,last_sent_at,last_items,last_error,updated_at) VALUES(?,?,?,?,?,'',?) ON CONFLICT(market) DO UPDATE SET warehouse_id=excluded.warehouse_id,payload_hash=excluded.payload_hash,last_sent_at=excluded.last_sent_at,last_items=excluded.last_items,last_error='',updated_at=excluded.updated_at")
      .bind(market,warehouseId,hash,now,items.length,now).run();
    await env.DB.prepare('UPDATE stock_sync_runs SET finished_at=?,ok=1 WHERE id=?').bind(now,run.id).run();
    return { ok:true, market, sent:true, warehouseId, items:items.length, sentAt:now };
  } catch(e) {
    const message=String(e?.message||e).slice(0,2000),now=Date.now();
    await env.DB.prepare('UPDATE stock_sync_runs SET finished_at=?,ok=0,error=? WHERE id=?').bind(now,message,run.id).run();
    await env.DB.prepare("INSERT INTO wb_stock_state(market,warehouse_id,payload_hash,last_sent_at,last_items,last_error,updated_at) VALUES(?,?, '',0,0,?,?) ON CONFLICT(market) DO UPDATE SET last_error=excluded.last_error,updated_at=excluded.updated_at")
      .bind(market,warehouseId,message,now).run();
    throw e;
  }
}

'''
if 'async function syncWbStockMarket' not in s:
    if s.count(anchor)!=1: raise SystemExit('preview function anchor mismatch')
    s=s.replace(anchor,active+anchor,1)

p.write_text(s,encoding='utf-8')
print('Active WB stock synchronization patch applied')
