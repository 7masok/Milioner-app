from pathlib import Path

p = Path('cloudflare/millioner-api/src/index.js')
s = p.read_text(encoding='utf-8')
if not s.startswith("const DEFAULT_CORS_ORIGIN") or "async function fetchWb(" not in s:
    raise SystemExit('Unexpected millioner-api source; full current Worker was not read')

anchor = "const WB_MARKETPLACE_BASE = 'https://marketplace-api.wildberries.ru';\n"
insert = anchor + "const WB_CONTENT_BASE = 'https://content-api.wildberries.ru';\nconst WB_STOCK_PREVIEW_MIN_MS = 10 * 60 * 1000;\n"
if "const WB_CONTENT_BASE" not in s:
    if s.count(anchor) != 1: raise SystemExit('WB base anchor mismatch')
    s = s.replace(anchor, insert, 1)

route_anchor = """      if (url.pathname === '/api/market-status' && request.method === 'GET') {
        const markets = await getMarketStatuses(env);
        return json({ ok: true, serverTime: Date.now(), markets }, 200, cors);
      }
"""
route_insert = route_anchor + """
      if (url.pathname === '/api/stock-sync-status' && request.method === 'GET') {
        const stocks = await getStockSyncStatus(env.DB);
        return json({ ok: true, serverTime: Date.now(), mode: 'preview', markets: stocks }, 200, cors);
      }

      if (url.pathname === '/api/stock-sync-preview' && request.method === 'GET') {
        const market = normalizeMarket(url.searchParams.get('market'));
        if (!['WB','WB2'].includes(market)) return json({ ok: false, error: 'market must be WB or WB2' }, 400, cors);
        const result = await previewWbStockMarket(env, market, { force: false });
        return json({ ok: true, result }, 200, cors);
      }
"""
if "/api/stock-sync-status" not in s:
    if s.count(route_anchor) != 1: raise SystemExit('market-status route anchor mismatch')
    s = s.replace(route_anchor, route_insert, 1)

sched_old = """    ctx.waitUntil((async () => {
      await ensureSchema(env.DB);
      return syncAll(env, { scheduled: true });
    })());
"""
sched_new = """    ctx.waitUntil((async () => {
      await ensureSchema(env.DB);
      const orders = await syncAll(env, { scheduled: true });
      const stocks = {};
      for (const market of ['WB','WB2']) {
        try { stocks[market] = await previewWbStockMarket(env, market, { force: false }); }
        catch (e) { stocks[market] = { ok: false, error: String(e?.message || e) }; }
      }
      return { orders, stocks };
    })());
"""
if "const stocks = {};" not in s:
    if s.count(sched_old) != 1: raise SystemExit('scheduled anchor mismatch')
    s = s.replace(sched_old, sched_new, 1)

schema_anchor = "    `CREATE TABLE IF NOT EXISTS warehouse_state (id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL DEFAULT '{}',revision INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL DEFAULT 0)`,\n"
schema_insert = schema_anchor + """    `CREATE TABLE IF NOT EXISTS stock_sync_runs (id INTEGER PRIMARY KEY AUTOINCREMENT,market TEXT NOT NULL,mode TEXT NOT NULL DEFAULT 'preview',started_at INTEGER NOT NULL,finished_at INTEGER,ok INTEGER NOT NULL DEFAULT 0,warehouse_id TEXT NOT NULL DEFAULT '',linked INTEGER NOT NULL DEFAULT 0,mapped INTEGER NOT NULL DEFAULT 0,missing INTEGER NOT NULL DEFAULT 0,items INTEGER NOT NULL DEFAULT 0,error TEXT NOT NULL DEFAULT '')`,
    `CREATE TABLE IF NOT EXISTS wb_stock_links (market TEXT NOT NULL,sku TEXT NOT NULL,chrt_id INTEGER NOT NULL,source TEXT NOT NULL DEFAULT '',updated_at INTEGER NOT NULL,PRIMARY KEY(market,sku))`,
    `CREATE INDEX IF NOT EXISTS idx_stock_sync_runs_market_started ON stock_sync_runs(market,started_at DESC)`,
"""
if "CREATE TABLE IF NOT EXISTS stock_sync_runs" not in s:
    if s.count(schema_anchor) != 1: raise SystemExit('schema anchor mismatch')
    s = s.replace(schema_anchor, schema_insert, 1)

func_anchor = "async function fetchWb(env, market='WB') {\n"
functions = r'''
async function getStockSyncStatus(db) {
  const rows = [];
  for (const market of ['WB','WB2']) {
    const latest = await db.prepare('SELECT * FROM stock_sync_runs WHERE market=? ORDER BY id DESC LIMIT 1').bind(market).first();
    rows.push({ market, latest: latest || null, ready: Boolean(latest?.ok && Number(latest?.linked || 0) > 0 && Number(latest?.missing || 0) === 0 && String(latest?.warehouse_id || '')) });
  }
  return rows;
}

async function previewWbStockMarket(env, market='WB', { force = false } = {}) {
  if (!['WB','WB2'].includes(market)) throw new Error('Unsupported WB stock market');
  const now = Date.now();
  const latest = await env.DB.prepare('SELECT * FROM stock_sync_runs WHERE market=? ORDER BY id DESC LIMIT 1').bind(market).first();
  if (!force && latest && now - Number(latest.started_at || 0) < WB_STOCK_PREVIEW_MIN_MS) {
    return { ok: Boolean(latest.ok), skipped: true, reason: 'preview-rate-gate', market, ready: Boolean(latest.ok && Number(latest.linked || 0) > 0 && Number(latest.missing || 0) === 0 && String(latest.warehouse_id || '')), warehouseId: String(latest.warehouse_id || ''), linked: Number(latest.linked || 0), mapped: Number(latest.mapped || 0), missing: Number(latest.missing || 0), items: Number(latest.items || 0), error: String(latest.error || '') };
  }
  const run = await env.DB.prepare("INSERT INTO stock_sync_runs(market,mode,started_at) VALUES(?,'preview',?) RETURNING id").bind(market, now).first();
  try {
    const token = String((market === 'WB2' ? env.WB_TOKEN_2 : env.WB_TOKEN) || '').trim();
    if (!token) throw new Error((market === 'WB2' ? 'WB_TOKEN_2' : 'WB_TOKEN') + ' is not configured');
    const warehouse = await loadWarehouseSnapshotForStock(env.DB);
    const linked = wbLinkedProducts(warehouse, market);
    if (!linked.length) {
      await finishStockPreviewRun(env.DB, run.id, { ok: true, warehouseId: '', linked: 0, mapped: 0, missing: 0, items: 0, error: 'No products linked to this WB account' });
      return { ok: true, market, ready: false, warehouseId: '', linked: 0, mapped: 0, missing: 0, items: [], warnings: ['Нет товаров с артикулом этого WB кабинета.'] };
    }
    const mapping = await resolveWbChrtMap(env.DB, token, market, linked.map(x => x.sku));
    const warehouseInfo = await resolveWbWarehouseId(env.DB, token, market, env);
    const orderRows = await env.DB.prepare("SELECT market,order_id AS orderId,entry_id AS entryId,status,state,creation_date AS creationDate,sku,qty FROM marketplace_order_lines WHERE market IN ('Kaspi','WB','WB2')").all();
    const amounts = computeSharedAvailableStocks(warehouse, orderRows.results || []);
    const items = linked.map(x => ({ productId: x.product.id, name: String(x.product.name || ''), sku: x.sku, chrtId: Number(mapping.map.get(x.sku) || 0), amount: Math.max(0, Math.floor(Number(amounts.get(String(x.product.id))) || 0)) }));
    const missingItems = items.filter(x => !x.chrtId);
    const warnings = [...mapping.warnings, ...warehouseInfo.warnings];
    const ready = Boolean(warehouseInfo.id && !missingItems.length && items.length);
    if (!warehouseInfo.id) warnings.push('Не удалось однозначно определить склад продавца WB.');
    if (missingItems.length) warnings.push('Не найден chrtId для: ' + missingItems.slice(0, 8).map(x => x.sku).join(', ') + (missingItems.length > 8 ? '…' : ''));
    await finishStockPreviewRun(env.DB, run.id, { ok: true, warehouseId: warehouseInfo.id || '', linked: items.length, mapped: items.length - missingItems.length, missing: missingItems.length, items: items.length, error: warnings.join(' | ').slice(0, 2000) });
    return { ok: true, market, ready, warehouseId: warehouseInfo.id || '', warehouseSource: warehouseInfo.source || '', linked: items.length, mapped: items.length - missingItems.length, missing: missingItems.length, items: items.slice(0, 200), warnings };
  } catch (e) {
    const message = String(e?.message || e).slice(0, 2000);
    await finishStockPreviewRun(env.DB, run.id, { ok: false, error: message });
    throw e;
  }
}

async function finishStockPreviewRun(db, id, x = {}) {
  await db.prepare('UPDATE stock_sync_runs SET finished_at=?,ok=?,warehouse_id=?,linked=?,mapped=?,missing=?,items=?,error=? WHERE id=?')
    .bind(Date.now(), x.ok ? 1 : 0, String(x.warehouseId || ''), Number(x.linked || 0), Number(x.mapped || 0), Number(x.missing || 0), Number(x.items || 0), String(x.error || '').slice(0, 2000), id).run();
}

async function loadWarehouseSnapshotForStock(db) {
  const row = await db.prepare('SELECT payload,updated_at FROM warehouse_state WHERE id=1').first();
  if (!row?.payload) throw new Error('Warehouse state is not initialized in D1');
  let state = null;
  try { state = JSON.parse(row.payload); } catch { throw new Error('Warehouse state JSON is invalid'); }
  state = state && typeof state === 'object' ? state : {};
  state.products = Array.isArray(state.products) ? state.products : [];
  state.sales = Array.isArray(state.sales) ? state.sales : [];
  state.reservations = Array.isArray(state.reservations) ? state.reservations : [];
  state.marketplaceLiveSince = state.marketplaceLiveSince && typeof state.marketplaceLiveSince === 'object' ? state.marketplaceLiveSince : {};
  state.marketOrderState = state.marketOrderState && typeof state.marketOrderState === 'object' ? state.marketOrderState : {};
  state.updatedAt = Number(row.updated_at || 0);
  return state;
}

function wbLinkedProducts(warehouse, market) {
  const field = market === 'WB2' ? 'wb2' : 'wb';
  const seen = new Set();
  const out = [];
  for (const product of warehouse.products || []) {
    const sku = String(product?.[field] || '').trim();
    if (!sku || seen.has(sku)) continue;
    seen.add(sku);
    out.push({ sku, product });
  }
  return out;
}

async function resolveWbChrtMap(db, token, market, wantedSkus) {
  const wanted = new Set((wantedSkus || []).map(x => String(x || '').trim()).filter(Boolean));
  const map = new Map();
  const warnings = [];
  const cached = await db.prepare('SELECT sku,chrt_id AS chrtId FROM wb_stock_links WHERE market=?').bind(market).all();
  for (const row of cached.results || []) if (wanted.has(String(row.sku))) map.set(String(row.sku), Number(row.chrtId || 0));

  const orderRows = await db.prepare("SELECT sku,raw_json AS rawJson FROM marketplace_order_lines WHERE market=? AND sku<>'' ORDER BY creation_date DESC LIMIT 5000").bind(market).all();
  const orderCandidates = new Map();
  for (const row of orderRows.results || []) {
    const sku = String(row.sku || '').trim();
    if (!wanted.has(sku)) continue;
    let raw = null;
    try { raw = JSON.parse(row.rawJson || '{}'); } catch { raw = {}; }
    const chrt = Number(raw?.order?.chrtId || raw?.order?.chrtID || 0);
    if (!chrt) continue;
    if (!orderCandidates.has(sku)) orderCandidates.set(sku, new Set());
    orderCandidates.get(sku).add(chrt);
  }
  for (const [sku, ids] of orderCandidates) {
    if (ids.size === 1) map.set(sku, [...ids][0]);
    else if (ids.size > 1) { map.delete(sku); warnings.push('Несколько chrtId у артикула ' + sku + '; нужна ручная проверка размера.'); }
  }

  const missing = [...wanted].filter(sku => !map.get(sku));
  if (missing.length) {
    try {
      const aliases = await fetchWbCardAliases(token);
      for (const sku of missing) {
        const chrt = Number(aliases.get(sku) || 0);
        if (chrt) map.set(sku, chrt);
      }
    } catch (e) {
      warnings.push('WB Content API: ' + String(e?.message || e));
    }
  }

  const now = Date.now();
  for (const [sku, chrtId] of map) {
    if (!wanted.has(sku) || !chrtId) continue;
    await db.prepare("INSERT INTO wb_stock_links(market,sku,chrt_id,source,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(market,sku) DO UPDATE SET chrt_id=excluded.chrt_id,source=excluded.source,updated_at=excluded.updated_at")
      .bind(market, sku, chrtId, orderCandidates.has(sku) ? 'orders/cards' : 'cards/cache', now).run();
  }
  return { map, warnings };
}

function putAlias(map, alias, chrtId) {
  const key = String(alias || '').trim();
  const id = Number(chrtId || 0);
  if (!key || !id) return;
  if (!map.has(key)) map.set(key, id);
  else if (Number(map.get(key)) !== id) map.set(key, 0);
}

async function fetchWbCardAliases(token) {
  const aliases = new Map();
  let cursor = {};
  for (let page = 0; page < 20; page++) {
    const body = { settings: { sort: { ascending: true }, cursor: { limit: 100, ...cursor }, filter: { withPhoto: -1 } } };
    const r = await fetch(WB_CONTENT_BASE + '/content/v2/get/cards/list', { method: 'POST', headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'Authorization': token }, body: JSON.stringify(body) });
    const data = await safeJson(r, 'WB Content cards');
    if (!r.ok) throw new Error(wbError('WB Content cards', r.status, data));
    const cards = Array.isArray(data?.cards) ? data.cards : [];
    for (const card of cards) {
      const sizes = Array.isArray(card?.sizes) ? card.sizes : [];
      const ids = new Set();
      for (const size of sizes) {
        const chrtId = Number(size?.chrtID || size?.chrtId || 0);
        if (!chrtId) continue;
        ids.add(chrtId);
        for (const barcode of Array.isArray(size?.skus) ? size.skus : []) putAlias(aliases, barcode, chrtId);
      }
      if (ids.size === 1) {
        const only = [...ids][0];
        putAlias(aliases, card?.vendorCode, only);
        putAlias(aliases, card?.nmID, only);
      }
    }
    if (!cards.length || cards.length < 100) break;
    const next = data?.cursor || {};
    if (!next.updatedAt || !next.nmID) break;
    cursor = { updatedAt: next.updatedAt, nmID: next.nmID };
  }
  return aliases;
}

async function resolveWbWarehouseId(db, token, market, env) {
  const explicit = String((market === 'WB2' ? env.WB_WAREHOUSE_ID_2 : env.WB_WAREHOUSE_ID) || '').trim();
  if (explicit) return { id: explicit, source: 'env', warnings: [] };
  const warnings = [];
  const rows = await db.prepare("SELECT raw_json AS rawJson FROM marketplace_order_lines WHERE market=? ORDER BY creation_date DESC LIMIT 500").bind(market).all();
  const recent = new Set();
  for (const row of rows.results || []) {
    let raw = null;
    try { raw = JSON.parse(row.rawJson || '{}'); } catch { raw = {}; }
    const id = String(raw?.order?.warehouseId || '').trim();
    if (id) recent.add(id);
  }
  const r = await fetch(WB_MARKETPLACE_BASE + '/api/v3/warehouses', { headers: { 'Accept': 'application/json', 'Authorization': token } });
  const data = await safeJson(r, 'WB warehouses');
  if (!r.ok) throw new Error(wbError('WB warehouses', r.status, data));
  const active = (Array.isArray(data) ? data : []).filter(x => !x?.isDeleting && x?.id != null);
  if (recent.size === 1) {
    const id = [...recent][0];
    if (!active.length || active.some(x => String(x.id) === id)) return { id, source: 'recent-orders', warnings };
  }
  if (active.length === 1) return { id: String(active[0].id), source: 'warehouses-api', warnings };
  if (recent.size > 1) warnings.push('В последних заказах найдено несколько складов: ' + [...recent].join(', ') + '.');
  if (active.length > 1) warnings.push('В кабинете WB несколько активных складов: ' + active.map(x => String(x.id)).join(', ') + '.');
  return { id: '', source: '', warnings };
}

function stockLifecycleStage(market, status, state='') {
  const u = String(status || '').toUpperCase(), st = String(state || '').toUpperCase();
  if (market === 'WB' || market === 'WB2') {
    if (['CANCELED','CANCELLED','CANCELED_BY_CLIENT','DECLINED_BY_CLIENT','DEFECT'].includes(st) || ['CANCEL','CANCELLED'].includes(u)) return 'cancelled';
    if (['SORTED','ACCEPTED_BY_CARRIER','SENT_TO_CARRIER','READY_FOR_PICKUP','SOLD'].includes(st)) return 'delivery';
    if (u === 'CONFIRM' || u === 'COMPLETE' || (st === 'WAITING' && u !== 'NEW')) return 'transfer';
    return 'new';
  }
  if (market === 'Kaspi') {
    if (['CANCELLED','CANCELLING','RETURNED','KASPI_DELIVERY_RETURN_REQUESTED'].includes(u)) return 'cancelled';
    if (u === 'COMPLETED' || st === 'KASPI_DELIVERY_TRANSIT') return 'delivery';
    if (u === 'ASSEMBLE') return 'transfer';
    return 'new';
  }
  return 'cancelled';
}

function isBundleStateProduct(p) { return String(p?.kind || 'simple') === 'bundle' && Array.isArray(p?.components) && p.components.length > 0; }
function stateBundleParts(p) { return isBundleStateProduct(p) ? p.components.map(x => ({ productId: String(x?.productId || ''), qty: Math.max(1, Number(x?.qty) || 1) })).filter(x => x.productId) : []; }
function addQty(map, key, qty) { if (!key || !(Number(qty) > 0)) return; map.set(String(key), (Number(map.get(String(key))) || 0) + Number(qty)); }

function computeSharedAvailableStocks(warehouse, orderRows) {
  const products = new Map((warehouse.products || []).map(p => [String(p.id), p]));
  const skuMaps = { Kaspi: new Map(), WB: new Map(), WB2: new Map() };
  for (const p of warehouse.products || []) {
    if (String(p.kaspi || '').trim()) skuMaps.Kaspi.set(String(p.kaspi).trim(), String(p.id));
    if (String(p.wb || '').trim()) skuMaps.WB.set(String(p.wb).trim(), String(p.id));
    if (String(p.wb2 || '').trim()) skuMaps.WB2.set(String(p.wb2).trim(), String(p.id));
  }
  const stageByKey = new Map();
  for (const row of orderRows || []) {
    const market = String(row.market || '');
    if (!skuMaps[market]) continue;
    const legacy = String(row.orderId || '') + ':' + String(row.entryId || '');
    const scoped = market + ':' + legacy;
    const stage = stockLifecycleStage(market, row.status, row.state);
    stageByKey.set(scoped, stage);
    if (market === 'Kaspi') stageByKey.set(legacy, stage);
  }
  const direct = new Map();
  const reservationKeys = new Set();
  for (const r of warehouse.reservations || []) {
    if (!r?.active || !r?.productId || !(Number(r.qty) > 0)) continue;
    const key = String(r.externalKey || '');
    const currentStage = key ? stageByKey.get(key) : null;
    if (currentStage && !['new','transfer'].includes(currentStage)) continue;
    addQty(direct, r.productId, r.qty);
    if (key) reservationKeys.add(key);
  }
  const soldKeys = new Set();
  for (const sale of warehouse.sales || []) if (sale?.externalKey) soldKeys.add(String(sale.externalKey));
  for (const row of orderRows || []) {
    const market = String(row.market || '');
    const pid = skuMaps[market]?.get(String(row.sku || '').trim());
    const qty = Math.max(0, Number(row.qty) || 0);
    if (!pid || !qty) continue;
    const legacy = String(row.orderId || '') + ':' + String(row.entryId || '');
    const scoped = market + ':' + legacy;
    const stage = stockLifecycleStage(market, row.status, row.state);
    const hasReservation = reservationKeys.has(scoped) || (market === 'Kaspi' && reservationKeys.has(legacy));
    if (stage === 'new' || stage === 'transfer') {
      if (!hasReservation) addQty(direct, pid, qty);
      continue;
    }
    if (stage !== 'delivery' || hasReservation) continue;
    if (soldKeys.has(scoped) || (market === 'Kaspi' && soldKeys.has(legacy))) continue;
    const liveSince = Number(warehouse.marketplaceLiveSince?.[market] || 0);
    const prev = warehouse.marketOrderState?.[market]?.[legacy] || warehouse.marketOrderState?.[market]?.[scoped] || null;
    const wasActive = Boolean(prev?.active || ['new','transfer'].includes(String(prev?.stage || '')));
    if (wasActive || (liveSince && Number(row.creationDate || 0) >= liveSince)) addQty(direct, pid, qty);
  }
  const committed = new Map();
  for (const [pid, qty] of direct) {
    const p = products.get(String(pid));
    if (!p) continue;
    if (isBundleStateProduct(p)) for (const part of stateBundleParts(p)) addQty(committed, part.productId, qty * part.qty);
    else addQty(committed, pid, qty);
  }
  const available = new Map();
  for (const p of warehouse.products || []) {
    const pid = String(p.id);
    if (!isBundleStateProduct(p)) {
      available.set(pid, Math.max(0, Math.floor((Number(p.stock) || 0) - (Number(committed.get(pid)) || 0))));
      continue;
    }
    let max = Infinity;
    for (const part of stateBundleParts(p)) {
      const component = products.get(String(part.productId));
      if (!component || isBundleStateProduct(component)) { max = 0; break; }
      const free = Math.max(0, (Number(component.stock) || 0) - (Number(committed.get(String(component.id))) || 0));
      max = Math.min(max, Math.floor(free / part.qty));
    }
    available.set(pid, Number.isFinite(max) ? Math.max(0, max) : 0);
  }
  return available;
}

'''
if "async function previewWbStockMarket" not in s:
    if s.count(func_anchor) != 1: raise SystemExit('fetchWb anchor mismatch')
    s = s.replace(func_anchor, functions + func_anchor, 1)

p.write_text(s, encoding='utf-8')
print('WB stock sync preview patch applied')
