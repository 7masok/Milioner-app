const DEFAULT_CORS_ORIGIN = 'https://7masok.github.io';
const KASPI_SCHEDULE_MS = 10 * 60 * 1000;
const KASPI_MAX_BATCHES = 4;
// WB Statistics API can be limited seller-wide to one request per three hours.
// Keep a small safety margin so background checks do not keep the seller in 429.
const WB_MIN_SYNC_MS = (3 * 60 + 5) * 60 * 1000;

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
                 MAX(CASE WHEN l.market='Ozon' THEN l.sku END) AS ozon
          FROM products p LEFT JOIN product_links l ON l.product_id=p.id
          GROUP BY p.id ORDER BY p.name COLLATE NOCASE`).all();
        return json({ ok: true, products: rows.results || [] }, 200, cors);
      }

      if (url.pathname === '/api/sync-status' && request.method === 'GET') {
        const rows = await env.DB.prepare(`
          SELECT s.* FROM sync_runs s
          JOIN (SELECT market,MAX(id) id FROM sync_runs GROUP BY market) x ON x.id=s.id
          ORDER BY s.market`).all();
        return json({ ok: true, markets: rows.results || [] }, 200, cors);
      }

      if (url.pathname === '/api/market-status' && request.method === 'GET') {
        const markets = await getMarketStatuses(env.DB);
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
    `CREATE INDEX IF NOT EXISTS idx_product_links_product ON product_links(product_id)`,
    `CREATE INDEX IF NOT EXISTS idx_order_lines_market_date ON marketplace_order_lines(market,creation_date DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_order_lines_market_sku ON marketplace_order_lines(market,sku)`,
    `CREATE INDEX IF NOT EXISTS idx_sync_runs_market_started ON sync_runs(market,started_at DESC)`
  ];
  for (const sql of statements) await db.prepare(sql).run();
}

async function syncAll(env, { scheduled = false } = {}) {
  const results = {};
  for (const market of ['Kaspi', 'WB']) {
    try {
      if (scheduled && market === 'WB') {
        const gate = await getWbSyncGate(env.DB);
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

async function getWbSyncGate(db) {
  const row = await db.prepare(`SELECT MAX(started_at) AS lastAttempt FROM sync_runs WHERE market='WB'`).first();
  const lastAttempt = Number(row?.lastAttempt || 0);
  const nextSyncAt = lastAttempt ? lastAttempt + WB_MIN_SYNC_MS : Date.now();
  return { allowed: !lastAttempt || Date.now() >= nextSyncAt, lastAttempt, nextSyncAt };
}

async function getMarketStatuses(db) {
  const result = [];
  for (const market of ['Kaspi', 'WB', 'Ozon']) {
    const latest = await db.prepare('SELECT * FROM sync_runs WHERE market=? ORDER BY id DESC LIMIT 1').bind(market).first();
    const success = await db.prepare('SELECT MAX(finished_at) AS lastSuccessAt FROM sync_runs WHERE market=? AND ok=1').bind(market).first();
    const count = await db.prepare('SELECT COUNT(*) AS n FROM marketplace_order_lines WHERE market=?').bind(market).first();
    const lastAttempt = Number(latest?.started_at || 0);
    let nextSyncAt = null;
    if (market === 'Kaspi') nextSyncAt = lastAttempt ? lastAttempt + KASPI_SCHEDULE_MS : Date.now();
    if (market === 'WB') nextSyncAt = lastAttempt ? lastAttempt + WB_MIN_SYNC_MS : Date.now();
    result.push({
      market,
      configured: market !== 'Ozon',
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
    else if (market === 'WB') lines = await fetchWb(env);
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
  const result = [];
  let batch = 0;
  for (let safety = 0; safety < KASPI_MAX_BATCHES; safety++) {
    const r = await fetch(`${base}/kaspi/sync?days=14&batch=${batch}`, { headers: { 'Accept': 'application/json' } });
    const data = await safeJson(r, 'Kaspi Worker');
    if (!r.ok || data?.ok === false) throw new Error(data?.error || `Kaspi Worker HTTP ${r.status}`);
    for (const order of data.orders || []) {
      for (const line of order.lines || []) {
        const qty = Math.max(0, Number(line.quantity || 1));
        const total = Number(line.totalPrice || (Number(line.basePrice || 0) * qty) || 0);
        result.push({
          orderId: String(order.id || ''), code: String(order.code || ''), entryId: String(line.entryId || ''),
          status: String(order.status || ''), state: String(order.state || ''), creationDate: toTimestamp(order.creationDate),
          sku: String(line.merchantCode || '').trim(), productName: String(line.productName || ''), qty,
          unitPrice: qty ? total / qty : Number(line.basePrice || 0), totalPrice: total, raw: { order, line }
        });
      }
    }
    if (!data.hasMore) break;
    const next = Number(data.nextBatch);
    if (!Number.isFinite(next)) break;
    batch = next;
  }
  return result;
}

async function fetchWb(env) {
  const base = cleanUrl(env.WB_WORKER_URL);
  if (!base) throw new Error('WB_WORKER_URL is not configured');
  const r = await fetch(`${base}/wb/sync?days=14`, { headers: { 'Accept': 'application/json' } });
  const data = await safeJson(r, 'WB Worker');
  if (!r.ok || data?.ok === false) {
    const detail = String(data?.error || data?.message || `WB Worker HTTP ${r.status}`);
    if (r.status === 429 || /\b429\b|too many requests|global limiter/i.test(detail)) {
      throw new Error(`WB rate limited by Statistics API. Automatic sync waits at least 3h05m between attempts. ${detail}`);
    }
    throw new Error(detail);
  }
  return normalizeWb(data);
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

    for (const [market, field] of [['Kaspi','kaspi'],['WB','wb'],['Ozon','ozon']]) {
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
  if (x === 'wb' || x === 'wildberries') return 'WB';
  if (x === 'ozon') return 'Ozon';
  throw Object.assign(new Error('Unknown market'), { status: 400 });
}

function corsHeaders(origin, env) {
  const allowed = String(env.CORS_ORIGIN || DEFAULT_CORS_ORIGIN).replace(/\/$/, '');
  const normalized = String(origin || '').replace(/\/$/, '');
  return {
    'Access-Control-Allow-Origin': normalized === allowed ? origin : allowed,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
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
