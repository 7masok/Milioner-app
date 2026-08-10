const DEFAULT_CORS_ORIGIN = 'https://7masok.github.io';
const KASPI_SCHEDULE_MS = 5 * 60 * 1000;
const KASPI_MAX_BATCHES = 10;
const KASPI_EXTERNAL_BUDGET = 45;
const WB_MIN_SYNC_MS = 10 * 60 * 1000;
const WB_MARKETPLACE_BASE = 'https://marketplace-api.wildberries.ru';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      await ensureSchema(env.DB);

      if (url.pathname === '/health') {
        const db = await env.DB.prepare('SELECT 1 AS ok').first();
        return json({ ok: true, service: 'millioner-api', d1: db?.ok === 1 }, 200, cors);
      }

      if (url.pathname === '/api/orders' && request.method === 'GET') {
        const market = normalizeMarket(url.searchParams.get('market'));
        const limit = clamp(Number(url.searchParams.get('limit') || 500), 1, 1000);
        const where = market ? 'WHERE o.market = ?' : '';
        const args = market ? [market, limit] : [limit];
        const sql = `
          SELECT o.market,o.order_id AS orderId,o.code,o.entry_id AS entryId,o.status,o.state,
                 o.creation_date AS creationDate,o.sku,o.product_name AS productName,o.qty,
                 o.unit_price AS unitPrice,o.total_price AS totalPrice,l.product_id AS productId
          FROM marketplace_order_lines o
          LEFT JOIN product_links l ON l.market=o.market AND l.sku=o.sku
          ${where}
          ORDER BY o.creation_date DESC
          LIMIT ?`;
        const rows = await env.DB.prepare(sql).bind(...args).all();
        return json({ ok: true, orders: rows.results || [] }, 200, cors);
      }

      if (url.pathname === '/api/products' && request.method === 'GET') {
        const rows = await env.DB.prepare(`
          SELECT p.id,p.name,p.category,p.photo,p.min_stock AS min,p.stock,p.cost,p.total_profit AS totalProfit,
                 MAX(CASE WHEN l.market='Kaspi' THEN l.sku END) AS kaspi,
                 MAX(CASE WHEN l.market='WB' THEN l.sku END) AS wb,
                 MAX(CASE WHEN l.market='WB2' THEN l.sku END) AS wb2,
                 MAX(CASE WHEN l.market='Ozon' THEN l.sku END) AS ozon
          FROM products p LEFT JOIN product_links l ON l.product_id=p.id
          GROUP BY p.id ORDER BY p.name COLLATE NOCASE`).all();
        return json({ ok: true, products: rows.results || [] }, 200, cors);
      }

      if (url.pathname === '/api/warehouse-state' && request.method === 'GET') {
        if (!isTrustedBrowserOrigin(origin, env)) return json({ ok: false, error: 'Forbidden origin' }, 403, cors);
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

      if (url.pathname === '/api/sync-status' && request.method === 'GET') {
        const rows = await env.DB.prepare(`
          SELECT s.* FROM sync_runs s
          JOIN (SELECT market,MAX(id) id FROM sync_runs GROUP BY market) x ON x.id=s.id
          ORDER BY s.market`).all();
        return json({ ok: true, markets: rows.results || [] }, 200, cors);
      }

      if (url.pathname === '/api/market-status' && request.method === 'GET') {
        const markets = await getMarketStatuses(env);
        return json({ ok: true, serverTime: Date.now(), markets }, 200, cors);
      }

      if (url.pathname === '/admin/import-products' && request.method === 'POST') {
        requireAdmin(request, env);
        const body = await request.json();
        const products = Array.isArray(body?.products) ? body.products : [];
        const result = await importProducts(env.DB, products);
        return json({ ok: true, ...result }, 200, cors);
      }

      if (url.pathname === '/admin/sync' && request.method === 'POST') {
        requireAdmin(request, env);
        const market = normalizeMarket(url.searchParams.get('market'));
        const result = market ? await syncMarket(env, market) : await syncAll(env, { scheduled: false });
        return json({ ok: true, result }, 200, cors);
      }

      return json({ ok: false, error: 'Not found' }, 404, cors);
    } catch (error) {
      return json({ ok: false, error: String(error?.message || error) }, error?.status || 500, cors);
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil((async () => {
      await ensureSchema(env.DB);
      return syncAll(env, { scheduled: true });
    })());
  }
};

async function ensureSchema(db) {
  if (!db) throw new Error('D1 binding DB is not configured');
  const statements = [
    `CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY,name TEXT NOT NULL,category TEXT NOT NULL DEFAULT '',photo TEXT NOT NULL DEFAULT '',min_stock INTEGER NOT NULL DEFAULT 0,stock INTEGER NOT NULL DEFAULT 0,cost REAL NOT NULL DEFAULT 0,total_profit REAL NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS product_links (id INTEGER PRIMARY KEY AUTOINCREMENT,product_id TEXT NOT NULL,market TEXT NOT NULL,sku TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE,UNIQUE(market,sku))`,
    `CREATE TABLE IF NOT EXISTS marketplace_order_lines (id INTEGER PRIMARY KEY AUTOINCREMENT,market TEXT NOT NULL,order_id TEXT NOT NULL,code TEXT NOT NULL DEFAULT '',entry_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT '',state TEXT NOT NULL DEFAULT '',creation_date INTEGER NOT NULL DEFAULT 0,sku TEXT NOT NULL DEFAULT '',product_name TEXT NOT NULL DEFAULT '',qty REAL NOT NULL DEFAULT 0,unit_price REAL NOT NULL DEFAULT 0,total_price REAL NOT NULL DEFAULT 0,raw_json TEXT NOT NULL DEFAULT '',first_seen_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(market,order_id,entry_id))`,
    `CREATE TABLE IF NOT EXISTS sync_runs (id INTEGER PRIMARY KEY AUTOINCREMENT,market TEXT NOT NULL,started_at INTEGER NOT NULL,finished_at INTEGER,ok INTEGER NOT NULL DEFAULT 0,items INTEGER NOT NULL DEFAULT 0,error TEXT NOT NULL DEFAULT '')`,
    `CREATE TABLE IF NOT EXISTS warehouse_state (id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL DEFAULT '{}',revision INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL DEFAULT 0)`,
    `CREATE INDEX IF NOT EXISTS idx_product_links_product ON product_links(product_id)`,
    `CREATE INDEX IF NOT EXISTS idx_order_lines_market_date ON marketplace_order_lines(market,creation_date DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_order_lines_market_sku ON marketplace_order_lines(market,sku)`,
    `CREATE INDEX IF NOT EXISTS idx_sync_runs_market_started ON sync_runs(market,started_at DESC)`
  ];
  for (const sql of statements) await db.prepare(sql).run();
}

async function syncAll(env, { scheduled = false } = {}) {
  const results = {};
  for (const market of ['Kaspi', 'WB', 'WB2']) {
    try {
      if (scheduled && (market === 'WB' || market === 'WB2')) {
        const gate = await getWbSyncGate(env.DB, market);
        if (!gate.allowed) {
          results[market] = {
            ok: true,
            skipped: true,
            reason: 'WB seller-wide rate-limit window',
            nextSyncAt: gate.nextSyncAt
          };
          continue;
        }
      }
      results[market] = await syncMarket(env, market);
    } catch (e) {
      results[market] = { ok: false, error: String(e?.message || e) };
    }
  }
  return results;
}

async function getWbSyncGate(db, market='WB') {
  const row = await db.prepare('SELECT MAX(started_at) AS lastAttempt FROM sync_runs WHERE market=?').bind(market).first();
  const lastAttempt = Number(row?.lastAttempt || 0);
  const nextSyncAt = lastAttempt ? lastAttempt + WB_MIN_SYNC_MS : Date.now();
  return { allowed: !lastAttempt || Date.now() >= nextSyncAt, lastAttempt, nextSyncAt };
}

async function getMarketStatuses(env) {
  const db = env.DB;
  const result = [];
  for (const market of ['Kaspi', 'WB', 'WB2', 'Ozon']) {
    const latest = await db.prepare('SELECT * FROM sync_runs WHERE market=? ORDER BY id DESC LIMIT 1').bind(market).first();
    const success = await db.prepare('SELECT MAX(finished_at) AS lastSuccessAt FROM sync_runs WHERE market=? AND ok=1').bind(market).first();
    const count = await db.prepare('SELECT COUNT(*) AS n FROM marketplace_order_lines WHERE market=?').bind(market).first();
    const lastAttempt = Number(latest?.started_at || 0);
    let nextSyncAt = null;
    if (market === 'Kaspi') nextSyncAt = lastAttempt ? lastAttempt + KASPI_SCHEDULE_MS : Date.now();
    if (market === 'WB' || market === 'WB2') nextSyncAt = lastAttempt ? lastAttempt + WB_MIN_SYNC_MS : Date.now();
    result.push({
      market,
      configured: market === 'Kaspi' ? Boolean(env.KASPI_WORKER_URL) : market === 'WB' ? Boolean(env.WB_TOKEN) : market === 'WB2' ? Boolean(env.WB_TOKEN_2) : false,
      mode: market === 'WB' ? (env.WB_TOKEN ? 'marketplace-api' : 'missing-token') : market === 'WB2' ? (env.WB_TOKEN_2 ? 'marketplace-api' : 'missing-token') : market === 'Kaspi' ? (env.KASPI_TOKEN ? 'worker+direct-recovery' : 'worker-only') : 'off',
      directRecoveryConfigured: market === 'Kaspi' ? Boolean(env.KASPI_TOKEN) : null,
      latest: latest || null,
      lastSuccessAt: Number(success?.lastSuccessAt || 0) || null,
      orderLines: Number(count?.n || 0),
      nextSyncAt
    });
  }
  return result;
}

async function syncMarket(env, market) {
  const startedAt = Date.now();
  const run = await env.DB.prepare('INSERT INTO sync_runs(market,started_at) VALUES(?,?) RETURNING id').bind(market, startedAt).first();
  try {
    let lines = [];
    if (market === 'Kaspi') lines = await fetchKaspi(env);
    else if (market === 'WB' || market === 'WB2') lines = await fetchWb(env, market);
    else throw new Error('Unsupported market');

    await upsertOrderLines(env.DB, market, lines);
    await env.DB.prepare('UPDATE sync_runs SET finished_at=?,ok=1,items=? WHERE id=?').bind(Date.now(), lines.length, run.id).run();
    return { ok: true, items: lines.length };
  } catch (e) {
    await env.DB.prepare('UPDATE sync_runs SET finished_at=?,ok=0,error=? WHERE id=?').bind(Date.now(), String(e?.message || e).slice(0, 2000), run.id).run();
    throw e;
  }
}

async function fetchKaspi(env) {
  const base = cleanUrl(env.KASPI_WORKER_URL);
  if (!base) throw new Error('KASPI_WORKER_URL is not configured');

  // Packing orders are the most time-sensitive. Asking the dedicated Kaspi
  // Worker for this smaller set first keeps its per-invocation subrequest
  // budget available for line/product expansion. One page of up to 100 accepted
  // delivery orders is enough for the current feed and avoids repeated expensive
  // nested Worker calls. Handoff is derived from deliveryCostForSeller below.
  let activeFeed = { orders: [], requests: 0 };
  let broadFeed = { orders: [], requests: 0 };
  let activeError = null;
  let broadError = null;
  try {
    activeFeed = await fetchKaspiWorkerFeed(base, {
      days: '1',
      status: 'ACCEPTED_BY_MERCHANT',
      state: 'KASPI_DELIVERY',
      size: '6'
    }, env.KASPI_WORKER);
  } catch (e) {
    activeError = String(e?.message || e);
    console.warn('Kaspi active feed failed', activeError);
  }
  // Kaspi's API rejects KASPI_DELIVERY_TRANSIT as an order-state filter.
  // Handoff is derived from deliveryCostForSeller on the accepted delivery feed,
  // so a second invalid/heavy broad request only makes the cron less reliable.
  const token = String(env.KASPI_TOKEN || '').trim();
  let deliveryFeed = { orders: [], requests: 0 };
  let directError = null;
  if (token) {
    try {
      deliveryFeed = await fetchKaspiOrdersDirect(token, { days: 7, state: 'KASPI_DELIVERY' });
    } catch (e) {
      directError = String(e?.message || e);
      console.warn('Kaspi direct order feed failed', directError);
    }
  }
  if (!activeFeed.orders.length && !broadFeed.orders.length && !deliveryFeed.orders.length) {
    const workerMessage = activeError || broadError || 'empty worker feed';
    const directMessage = token ? (directError || 'empty direct feed') : 'KASPI_TOKEN is not configured';
    throw new Error(`Kaspi sync unavailable: worker=${workerMessage}; direct=${directMessage}`);
  }
  const workerRequests = activeFeed.requests + broadFeed.requests + deliveryFeed.requests;

  const byId = new Map();
  for (const order of broadFeed.orders) {
    const key = String(order?.id || order?.code || '');
    if (key) byId.set(key, order);
  }
  for (const originalOrder of activeFeed.orders) {
    // In worker-only mode Kaspi does not expose courierTransmissionDate.
    // For the current Kaspi Delivery feed, deliveryCostForSeller is 0 while an
    // order is still in packing and becomes positive after courier handoff.
    // If KASPI_TOKEN is later configured, the direct feed below overrides this
    // fallback with the authoritative courierTransmissionDate marker.
    const order = Number(originalOrder?.deliveryCostForSeller || 0) > 0
      ? { ...originalOrder, state: 'KASPI_DELIVERY_TRANSIT' }
      : originalOrder;
    const key = String(order?.id || order?.code || '');
    if (!key) continue;
    const previous = byId.get(key);
    const activeHasLines = Array.isArray(order?.lines) && order.lines.length > 0;
    const previousHasLines = Array.isArray(previous?.lines) && previous.lines.length > 0;
    if (!previous || activeHasLines || !previousHasLines) byId.set(key, order);
  }
  for (const order of deliveryFeed.orders) {
    const key = String(order?.id || order?.code || '');
    if (!key) continue;
    const previous = byId.get(key) || {};
    const previousLines = Array.isArray(previous?.lines) ? previous.lines : [];
    byId.set(key, { ...previous, ...order, lines: previousLines.length ? previousLines : (order.lines || []) });
  }
  const orders = [...byId.values()];

  const result = [];
  const missing = [];
  for (const order of orders) {
    const lines = Array.isArray(order?.lines) ? order.lines : [];
    if (lines.length) appendKaspiLines(result, order, lines);
    else missing.push(order);
  }

  if (!missing.length) return result;

  const existingRows = await env.DB.prepare(`
    SELECT DISTINCT order_id AS orderId
    FROM marketplace_order_lines
    WHERE market='Kaspi'
  `).all();
  const existing = new Set((existingRows.results || []).map(r => String(r.orderId || '')));

  const now = Date.now();
  for (const order of missing) {
    const orderId = String(order?.id || '');
    if (!orderId || !existing.has(orderId)) continue;
    await env.DB.prepare(`
      UPDATE marketplace_order_lines
      SET status=?,state=?,creation_date=?,updated_at=?
      WHERE market='Kaspi' AND order_id=?
    `).bind(String(order?.status || ''),String(order?.state || ''),toTimestamp(order?.creationDate),now,orderId).run();
  }

  if (!token) {
    for (const order of missing) {
      const orderId = String(order?.id || '');
      if (orderId && !existing.has(orderId)) appendKaspiPlaceholder(result, order);
    }
    return result;
  }

  const queue = missing
    .filter(order => {
      const orderId = String(order?.id || '');
      return orderId && !existing.has(orderId);
    })
    .sort((a,b) => {
      const ap = isKaspiActive(a) ? 1 : 0;
      const bp = isKaspiActive(b) ? 1 : 0;
      return (bp - ap) || (toTimestamp(b?.creationDate) - toTimestamp(a?.creationDate));
    });

  let budget = Math.max(0, KASPI_EXTERNAL_BUDGET - workerRequests);
  for (const order of queue) {
    if (budget < 1) break;
    try {
      const recovered = await fetchKaspiOrderLinesDirect(token, order, budget);
      budget = recovered.budget;
      if (recovered.lines.length) appendKaspiLines(result, order, recovered.lines);
    } catch (e) {
      console.warn('Kaspi direct line recovery failed', String(order?.code || order?.id || ''), String(e?.message || e));
    }
  }

  const represented = new Set(result.map(line => String(line?.orderId || '')));
  for (const order of missing) {
    const orderId = String(order?.id || '');
    if (orderId && !existing.has(orderId) && !represented.has(orderId)) appendKaspiPlaceholder(result, order);
  }

  return result;
}

async function fetchKaspiWorkerFeed(base, params, serviceBinding = null) {
  const orders = [];
  let batch = 0;
  let requests = 0;
  const transient = new Set([429, 500, 502, 503, 504]);
  for (let safety = 0; safety < KASPI_MAX_BATCHES; safety++) {
    const q = new URLSearchParams({ ...params, batch: String(batch) });
    let data = null;
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const workerUrl = `${base}/kaspi/sync?${q.toString()}`;
        const workerRequest = new Request(workerUrl, { headers: { 'Accept': 'application/json' } });
        const r = serviceBinding ? await serviceBinding.fetch(workerRequest) : await fetch(workerRequest);
        requests++;
        const text = await r.text();
        try { data = JSON.parse(text); }
        catch { lastError = new Error(`Kaspi Worker returned non-JSON (HTTP ${r.status})`); }
        if (r.ok && data?.ok !== false) break;
        if (!lastError) lastError = new Error(data?.error || `Kaspi Worker HTTP ${r.status}`);
        if (!(transient.has(r.status) && attempt === 0)) throw lastError;
      } catch (e) {
        lastError = e;
        if (attempt > 0) throw e;
      }
      await new Promise(resolve => setTimeout(resolve, 350));
      data = null;
    }
    if (!data || data?.ok === false) throw lastError || new Error('Kaspi Worker empty response');
    orders.push(...(Array.isArray(data?.orders) ? data.orders : []));
    if (!data.hasMore) break;
    const next = Number(data.nextBatch);
    if (!Number.isFinite(next)) break;
    batch = next;
  }
  return { orders, requests };
}

function isKaspiActive(order) {
  const status = String(order?.status || '').toUpperCase();
  return status === 'APPROVED_BY_BANK' || status === 'ACCEPTED_BY_MERCHANT' || status === 'ASSEMBLE';
}

function appendKaspiLines(result, order, lines) {
  for (const line of lines || []) {
    const qty = Math.max(0, Number(line?.quantity || 1));
    const total = Number(line?.totalPrice || (Number(line?.basePrice || 0) * qty) || 0);
    result.push({
      orderId: String(order?.id || ''), code: String(order?.code || ''), entryId: String(line?.entryId || line?.id || ''),
      status: String(order?.status || ''), state: String(order?.state || ''), creationDate: toTimestamp(order?.creationDate),
      sku: String(line?.merchantCode || line?.sku || '').trim(), productName: String(line?.productName || line?.name || ''), qty,
      unitPrice: qty ? total / qty : Number(line?.basePrice || 0), totalPrice: total, raw: { order, line }
    });
  }
}

async function fetchKaspiOrdersDirect(token, { days = 7, state = 'KASPI_DELIVERY' } = {}) {
  const headers = {
    'Accept': 'application/vnd.api+json',
    'Content-Type': 'application/vnd.api+json',
    'X-Auth-Token': token
  };
  const orders = [];
  const end = Date.now();
  const start = end - Math.max(1, Number(days) || 7) * 86400000;
  let requests = 0;
  for (let page = 0; page < 10; page++) {
    const q = new URLSearchParams();
    q.set('page[number]', String(page));
    q.set('page[size]', '100');
    q.set('filter[orders][state]', state);
    q.set('filter[orders][creationDate][$ge]', String(start));
    q.set('filter[orders][creationDate][$le]', String(end));
    const response = await fetch(`https://kaspi.kz/shop/api/v2/orders?${q.toString()}`, { headers });
    requests++;
    const data = await safeJson(response, 'Kaspi orders');
    if (!response.ok) throw new Error(data?.message || data?.error || `Kaspi orders HTTP ${response.status}`);
    const batch = Array.isArray(data?.data) ? data.data : [];
    for (const item of batch) {
      const attrs = item?.attributes || {};
      const transmissionDate = Number(attrs?.courierTransmissionDate || 0) || 0;
      orders.push({
        id: String(item?.id || ''),
        code: String(attrs?.code || ''),
        status: String(attrs?.status || ''),
        state: transmissionDate ? 'KASPI_DELIVERY_TRANSIT' : String(attrs?.state || state),
        creationDate: toTimestamp(attrs?.creationDate),
        totalPrice: Number(attrs?.totalPrice || 0),
        deliveryCostForSeller: Number(attrs?.deliveryCostForSeller || 0),
        courierTransmissionDate: transmissionDate || null,
        courierTransmissionPlanningDate: Number(attrs?.courierTransmissionPlanningDate || 0) || null,
        plannedDeliveryDate: Number(attrs?.plannedDeliveryDate || 0) || null,
        waybillNumber: String(attrs?.waybillNumber || ''),
        lines: [],
        rawOrder: item
      });
    }
    const pageCount = Number(data?.meta?.pageCount || 0);
    if (!batch.length || batch.length < 100 || (pageCount && page + 1 >= pageCount)) break;
  }
  return { orders, requests };
}

function appendKaspiPlaceholder(result, order) {
  result.push({
    orderId: String(order?.id || ''),
    code: String(order?.code || ''),
    entryId: '__pending__',
    status: String(order?.status || ''),
    state: String(order?.state || ''),
    creationDate: toTimestamp(order?.creationDate),
    sku: '',
    productName: 'Состав загружается',
    qty: 0,
    unitPrice: 0,
    totalPrice: Number(order?.totalPrice || 0),
    raw: { order, pending: true }
  });
}

async function fetchKaspiOrderLinesDirect(token, order, budget) {
  const orderId = String(order?.id || '').trim();
  if (!orderId || budget < 1) return { lines: [], budget };
  const headers = {
    'Accept': 'application/vnd.api+json',
    'Content-Type': 'application/vnd.api+json',
    'X-Auth-Token': token
  };

  const entriesResponse = await fetch(`https://kaspi.kz/shop/api/v2/orders/${encodeURIComponent(orderId)}/entries`, { headers });
  budget--;
  const entriesData = await safeJson(entriesResponse, 'Kaspi order entries');
  if (!entriesResponse.ok) {
    throw new Error(entriesData?.message || entriesData?.error || `Kaspi entries HTTP ${entriesResponse.status}`);
  }

  const lines = [];
  for (const entry of Array.isArray(entriesData?.data) ? entriesData.data : []) {
    const attrs = entry?.attributes || {};
    const masterProductId = String(entry?.relationships?.product?.data?.id || '').trim();
    let merchantCode = '';
    let productName = '';

    if (masterProductId && budget > 0) {
      try {
        const productResponse = await fetch(`https://kaspi.kz/shop/api/v2/masterproducts/${encodeURIComponent(masterProductId)}/merchantProduct`, { headers });
        budget--;
        const productData = await safeJson(productResponse, 'Kaspi merchant product');
        if (productResponse.ok) {
          merchantCode = String(productData?.data?.attributes?.code || '').trim();
          productName = String(productData?.data?.attributes?.name || '').trim();
        }
      } catch (e) {
        console.warn('Kaspi merchant product recovery failed', masterProductId, String(e?.message || e));
      }
    }

    const qty = Math.max(0, Number(attrs?.quantity || 1));
    const totalPrice = Number(attrs?.totalPrice || (Number(attrs?.basePrice || 0) * qty) || 0);
    lines.push({
      entryId: String(entry?.id || ''),
      quantity: qty,
      basePrice: Number(attrs?.basePrice || (qty ? totalPrice / qty : 0) || 0),
      totalPrice,
      merchantCode: merchantCode || masterProductId,
      productName: productName || String(attrs?.category?.title || '')
    });
  }
  return { lines, budget };
}

async function fetchWb(env, market='WB') {
  const token = String((market === 'WB2' ? env.WB_TOKEN_2 : env.WB_TOKEN) || '').trim();
  if (!token) throw new Error((market === 'WB2' ? 'WB_TOKEN_2' : 'WB_TOKEN') + ' is not configured in millioner-api');

  const headers = { 'Accept': 'application/json', 'Authorization': token };
  const dateFrom = Math.floor((Date.now() - 14 * 86400000) / 1000);
  const orders = [];
  let next = 0;

  for (let safety = 0; safety < 10; safety++) {
    const url = `${WB_MARKETPLACE_BASE}/api/v3/orders?limit=1000&next=${next}&dateFrom=${dateFrom}`;
    const r = await fetch(url, { headers });
    const data = await safeJson(r, 'WB Marketplace orders');
    if (!r.ok) throw new Error(wbError('WB Marketplace orders', r.status, data));
    const batch = Array.isArray(data?.orders) ? data.orders : [];
    orders.push(...batch);
    const newNext = Number(data?.next || 0);
    if (!batch.length || !newNext || newNext === next) break;
    next = newNext;
  }

  const statuses = new Map();
  const ids = orders.map(o => Number(o?.id)).filter(Number.isFinite);
  for (let i = 0; i < ids.length; i += 1000) {
    const chunk = ids.slice(i, i + 1000);
    const r = await fetch(`${WB_MARKETPLACE_BASE}/api/v3/orders/status`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ orders: chunk })
    });
    const data = await safeJson(r, 'WB Marketplace statuses');
    if (!r.ok) throw new Error(wbError('WB Marketplace statuses', r.status, data));
    for (const item of data?.orders || []) statuses.set(Number(item.id), item);
  }

  return orders.map((order, oi) => {
    const st = statuses.get(Number(order?.id)) || {};
    const priceMinor = Number(order?.convertedFinalPrice ?? order?.finalPrice ?? order?.convertedPrice ?? order?.price ?? 0) || 0;
    const price = priceMinor / 100; // WB Marketplace API monetary fields are minor currency units
    const sku = String(order?.article ?? order?.nmId ?? order?.skus?.[0] ?? '').trim();
    const orderId = String(order?.id ?? order?.orderUid ?? `wb-${oi}`);
    return {
      orderId, code: String(order?.id ?? order?.orderUid ?? orderId), entryId: orderId,
      status: String(st?.supplierStatus || 'new'),
      state: String(st?.wbStatus || order?.deliveryType || 'fbs'),
      creationDate: toTimestamp(order?.createdAt), sku, productName: '', qty: 1,
      unitPrice: price, totalPrice: price, raw: { order, status: st }
    };
  });
}

function wbError(label, status, data) {
  const detail = String(data?.message || data?.errorText || data?.error || data?.code || '').trim();
  return `${label} HTTP ${status}${detail ? `: ${detail}` : ''}`;
}

function normalizeWb(data) {
  const src = Array.isArray(data) ? data : Array.isArray(data?.orders) ? data.orders : [];
  const result = [];
  src.forEach((order, oi) => {
    const lines = Array.isArray(order?.lines) && order.lines.length ? order.lines : [order];
    lines.forEach((line, li) => {
      const sku = String(line?.merchantCode ?? line?.sku ?? line?.article ?? line?.vendorCode ?? order?.article ?? order?.sku ?? order?.vendorCode ?? order?.nmId ?? '').trim();
      const qty = Math.max(1, Number(line?.quantity ?? line?.qty ?? order?.quantity ?? order?.qty ?? 1) || 1);
      const explicitUnit = Number(line?.unitPrice ?? order?.unitPrice ?? 0) || 0;
      const explicitTotal = Number(line?.totalPrice ?? order?.totalPrice ?? 0) || 0;
      const fallbackPrice = Number(line?.convertedFinalPrice ?? line?.convertedPrice ?? line?.finalPrice ?? line?.price ?? order?.convertedFinalPrice ?? order?.convertedPrice ?? order?.finalPrice ?? order?.price ?? 0) || 0;
      const unitPrice = explicitUnit || (explicitTotal && qty ? explicitTotal / qty : 0) || fallbackPrice;
      const totalPrice = explicitTotal || unitPrice * qty;
      const orderId = String(order?.orderId ?? order?.id ?? order?.orderUid ?? order?.rid ?? line?.orderId ?? `wb-${oi}`);
      const entryId = String(line?.entryId ?? line?.id ?? order?.id ?? `${orderId}-${li}`);
      result.push({
        orderId, code: String(order?.code ?? order?.orderUid ?? order?.id ?? orderId), entryId,
        status: String(order?.status ?? order?.supplierStatus ?? line?.status ?? 'NEW'),
        state: String(order?.state ?? order?.wbStatus ?? order?.deliveryType ?? 'FBS'),
        creationDate: toTimestamp(order?.creationDate ?? order?.createdAt ?? line?.creationDate ?? line?.createdAt),
        sku, productName: String(line?.productName ?? line?.name ?? order?.productName ?? order?.name ?? ''),
        qty, unitPrice, totalPrice, raw: { order, line }
      });
    });
  });
  return result;
}

async function upsertOrderLines(db, market, lines) {
  if (!lines.length) return;
  const sql = `
    INSERT INTO marketplace_order_lines
      (market,order_id,code,entry_id,status,state,creation_date,sku,product_name,qty,unit_price,total_price,raw_json,first_seen_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(market,order_id,entry_id) DO UPDATE SET
      code=excluded.code,status=excluded.status,state=excluded.state,creation_date=excluded.creation_date,
      sku=excluded.sku,product_name=excluded.product_name,qty=excluded.qty,unit_price=excluded.unit_price,
      total_price=excluded.total_price,raw_json=excluded.raw_json,updated_at=excluded.updated_at
  `;
  for (let i = 0; i < lines.length; i += 50) {
    const now = Date.now();
    const batch = lines.slice(i, i + 50).map(o => envlessOrderStatement(db, sql, market, o, now));
    await db.batch(batch);
  }
  if (market === 'Kaspi') {
    await db.prepare(`
      DELETE FROM marketplace_order_lines
      WHERE market='Kaspi' AND entry_id='__pending__'
        AND order_id IN (
          SELECT order_id FROM marketplace_order_lines
          WHERE market='Kaspi' AND entry_id<>'__pending__'
        )
    `).run();
  }
}

function envlessOrderStatement(db, sql, market, o, now) {
  return db.prepare(sql).bind(market,o.orderId,o.code,o.entryId,o.status,o.state,o.creationDate,o.sku,o.productName,o.qty,o.unitPrice,o.totalPrice,JSON.stringify(o.raw || {}),now,now);
}

async function upsertOrderLine(db, market, o) {
  const now = Date.now();
  await db.prepare(`
    INSERT INTO marketplace_order_lines
      (market,order_id,code,entry_id,status,state,creation_date,sku,product_name,qty,unit_price,total_price,raw_json,first_seen_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(market,order_id,entry_id) DO UPDATE SET
      code=excluded.code,status=excluded.status,state=excluded.state,creation_date=excluded.creation_date,
      sku=excluded.sku,product_name=excluded.product_name,qty=excluded.qty,unit_price=excluded.unit_price,
      total_price=excluded.total_price,raw_json=excluded.raw_json,updated_at=excluded.updated_at
  `).bind(market,o.orderId,o.code,o.entryId,o.status,o.state,o.creationDate,o.sku,o.productName,o.qty,o.unitPrice,o.totalPrice,JSON.stringify(o.raw || {}),now,now).run();
}

function sanitizeWarehouseState(input) {
  const x = input && typeof input === 'object' ? input : {};
  const arr = key => Array.isArray(x[key]) ? x[key] : [];
  const obj = key => x[key] && typeof x[key] === 'object' && !Array.isArray(x[key]) ? x[key] : {};
  const settings = { ...obj('settings') };
  delete settings.serverMarketStatus; delete settings.wbToken; delete settings.kaspiToken;
  return { products:arr('products').slice(0,20000), movements:arr('movements').slice(0,5000), sales:arr('sales').slice(0,20000), purchases:arr('purchases').slice(0,20000), reservations:arr('reservations').slice(0,20000), settings, marketOrderState:obj('marketOrderState'), marketplaceLiveSince:obj('marketplaceLiveSince'), kaspiBaselineAt:x.kaspiBaselineAt||null };
}
function isTrustedBrowserOrigin(origin, env) {
  const allowed = String(env.CORS_ORIGIN || DEFAULT_CORS_ORIGIN).replace(/\/$/, '');
  return String(origin || '').replace(/\/$/, '') === allowed;
}

async function importProducts(db, products) {
  let count = 0;
  const now = Date.now();
  for (const p of products) {
    if (!p?.id || !String(p?.name || '').trim()) continue;
    await db.prepare(`
      INSERT INTO products(id,name,category,photo,min_stock,stock,cost,total_profit,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,category=excluded.category,photo=excluded.photo,
      min_stock=excluded.min_stock,stock=excluded.stock,cost=excluded.cost,total_profit=excluded.total_profit,updated_at=excluded.updated_at
    `).bind(String(p.id),String(p.name),String(p.category || ''),String(p.photo || ''),Number(p.min || 0),Number(p.stock || 0),Number(p.cost || 0),Number(p.totalProfit || 0),now,now).run();

    for (const [market, field] of [['Kaspi','kaspi'],['WB','wb'],['WB2','wb2'],['Ozon','ozon']]) {
      const sku = String(p[field] || '').trim();
      if (!sku) continue;
      await db.prepare(`
        INSERT INTO product_links(product_id,market,sku,created_at,updated_at) VALUES(?,?,?,?,?)
        ON CONFLICT(market,sku) DO UPDATE SET product_id=excluded.product_id,updated_at=excluded.updated_at
      `).bind(String(p.id),market,sku,now,now).run();
    }
    count++;
  }
  return { imported: count };
}

function requireAdmin(request, env) {
  if (!env.APP_ADMIN_TOKEN) throw Object.assign(new Error('APP_ADMIN_TOKEN is not configured'), { status: 503 });
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (token !== env.APP_ADMIN_TOKEN) throw Object.assign(new Error('Unauthorized'), { status: 401 });
}

function normalizeMarket(v) {
  const x = String(v || '').toLowerCase();
  if (!x) return '';
  if (x === 'kaspi') return 'Kaspi';
  if (x === 'wb' || x === 'wildberries' || x === 'wb1') return 'WB';
  if (x === 'wb2' || x === 'wildberries2') return 'WB2';
  if (x === 'ozon') return 'Ozon';
  throw Object.assign(new Error('Unknown market'), { status: 400 });
}

function corsHeaders(origin, env) {
  const allowed = String(env.CORS_ORIGIN || DEFAULT_CORS_ORIGIN).replace(/\/$/, '');
  const normalized = String(origin || '').replace(/\/$/, '');
  return {
    'Access-Control-Allow-Origin': normalized === allowed ? origin : allowed,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function json(body, status, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}
function cleanUrl(v) { return String(v || '').trim().replace(/\/+$/, ''); }
function clamp(n, min, max) { return Math.max(min, Math.min(max, Number.isFinite(n) ? n : min)); }
function toTimestamp(v) {
  if (v == null || v === '') return Date.now();
  const n = Number(v); if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n;
  const t = Date.parse(v); return Number.isFinite(t) ? t : Date.now();
}
async function safeJson(r, label) {
  try { return await r.json(); }
  catch { throw new Error(`${label} returned non-JSON (HTTP ${r.status})`); }
}
