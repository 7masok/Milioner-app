const DEFAULT_CORS_ORIGIN = 'https://7masok.github.io';
const KASPI_SCHEDULE_MS = 5 * 60 * 1000;
const KASPI_MAX_BATCHES = 10;
const KASPI_EXTERNAL_BUDGET = 45;
const WB_MIN_SYNC_MS = 10 * 60 * 1000;
const WB_MARKETPLACE_BASE = 'https://marketplace-api.wildberries.ru';
const WB_CONTENT_BASE = 'https://content-api.wildberries.ru';
const WB_FINANCE_BASE = 'https://finance-api.wildberries.ru';
const WB_ADVERT_BASE = 'https://advert-api.wildberries.ru';
const WB_FINANCE_SYNC_MS = 6 * 60 * 60 * 1000;
const WB_STOCK_PREVIEW_MIN_MS = 10 * 60 * 1000;

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

      if (url.pathname === '/api/wb-access-check' && request.method === 'GET') {
        const market = normalizeMarket(url.searchParams.get('market'));
        if (!['WB','WB2'].includes(market)) return json({ok:false,error:'market must be WB or WB2'},400,cors);
        const token=String((market==='WB2'?env.WB_TOKEN_2:env.WB_TOKEN)||'').trim();
        if(!token) return json({ok:true,market,configured:false,finance:false,promotion:false},200,cors);
        const headers={Authorization:token,Accept:'application/json'};
        const check=async(u)=>{try{const r=await fetch(u,{headers});return {ok:r.ok,status:r.status}}catch(e){return {ok:false,status:0,error:String(e?.message||e)}}};
        const [finance,promotion]=await Promise.all([check('https://finance-api.wildberries.ru/api/v1/account/balance'),check('https://advert-api.wildberries.ru/adv/v1/balance')]);
        return json({ok:true,market,configured:true,finance:finance.ok,promotion:promotion.ok,financeStatus:finance.status,promotionStatus:promotion.status},200,cors);
      }

      if (url.pathname === '/api/wb-finance-status' && request.method === 'GET') {
        const market=normalizeMarket(url.searchParams.get('market'));
        if(!['WB','WB2'].includes(market)) return json({ok:false,error:'market must be WB or WB2'},400,cors);
        const latest=await env.DB.prepare('SELECT * FROM wb_finance_sync_runs WHERE market=? ORDER BY id DESC LIMIT 1').bind(market).first();
        const f=await env.DB.prepare('SELECT COUNT(*) n,MAX(rr_date) lastDate FROM wb_finance_rows WHERE market=?').bind(market).first();
        const a=await env.DB.prepare('SELECT COUNT(*) n,MAX(day) lastDay FROM wb_ad_costs WHERE market=?').bind(market).first();
        return json({ok:true,market,latest:latest||null,financeRows:Number(f?.n||0),financeLastDate:Number(f?.lastDate||0)||null,adRows:Number(a?.n||0),adLastDay:a?.lastDay||null},200,cors);
      }

      if (url.pathname === '/api/wb-finance-operation-debug' && request.method === 'GET') {
        const market=normalizeMarket(url.searchParams.get('market'));
        if(!['WB','WB2'].includes(market)) return json({ok:false,error:'market must be WB or WB2'},400,cors);
        const days=Math.max(1,Math.min(365,Number(url.searchParams.get('days')||30)));
        const since=Date.now()-days*86400000;
        const rows=await env.DB.prepare(`SELECT doc_type AS docType,operation,COUNT(*) rows,SUM(qty) qty,SUM(retail_amount) retailAmount,SUM(for_pay) forPay,SUM(acquiring_fee) acquiring,SUM(delivery_service) delivery,SUM(paid_storage) storage,SUM(paid_acceptance) acceptance,SUM(deduction) deduction,SUM(penalty) penalty,SUM(additional_payment) additionalPayment,SUM(rebill_logistic_cost) rebill FROM wb_finance_rows WHERE market=? AND rr_date>=? GROUP BY doc_type,operation ORDER BY ABS(SUM(for_pay))+ABS(SUM(delivery_service))+ABS(SUM(deduction))+ABS(SUM(penalty)) DESC`).bind(market,since).all();
        return json({ok:true,market,days,groups:rows.results||[]},200,cors);
      }

      if (url.pathname === '/api/wb-finance-summary' && request.method === 'GET') {
        const market=normalizeMarket(url.searchParams.get('market'));
        if(!['WB','WB2'].includes(market)) return json({ok:false,error:'market must be WB or WB2'},400,cors);
        const daysRaw=Number(url.searchParams.get('days')||30);
        const days=daysRaw===-1?-1:Math.max(1,Math.min(3660,daysRaw));
        const {since,until}=wbFinancePeriodBounds(days);
        const f=await env.DB.prepare(`SELECT SUM(retail_amount) retailAmount,SUM(for_pay) forPay,SUM(acquiring_fee) acquiring,SUM(delivery_service) delivery,SUM(paid_storage) storage,SUM(paid_acceptance) acceptance,SUM(deduction) deduction,SUM(penalty) penalty,SUM(additional_payment) additionalPayment,SUM(rebill_logistic_cost) rebill FROM wb_finance_rows WHERE market=? AND COALESCE(NULLIF(sale_date,0),rr_date)>=? AND COALESCE(NULLIF(sale_date,0),rr_date)<?`).bind(market,since,until).first();
        const day=new Date(since).toISOString().slice(0,10),untilDay=new Date(until).toISOString().slice(0,10);
        const a=await env.DB.prepare(`SELECT SUM(amount) allAds,SUM(CASE WHEN lower(payment_type) LIKE '%счет%' OR lower(payment_type) LIKE '%account%' THEN amount ELSE 0 END) accountAds FROM wb_ad_costs WHERE market=? AND day>=? AND day<?`).bind(market,day,untilDay).first();
        const n=x=>Number(x||0);
        const countRow=await env.DB.prepare(`SELECT COUNT(*) n FROM wb_finance_rows WHERE market=? AND COALESCE(NULLIF(sale_date,0),rr_date)>=? AND COALESCE(NULLIF(sale_date,0),rr_date)<?`).bind(market,since,until).first();
        const wbCharges=n(f?.acquiring)+n(f?.delivery)+n(f?.storage)+n(f?.acceptance)+n(f?.deduction)+n(f?.penalty)+n(f?.rebill);
        const accountAdvertising=n(a?.accountAds);
        const netBeforeCost=n(f?.forPay)-wbCharges+n(f?.additionalPayment)-accountAdvertising;
        return json({ok:true,market,days,rowCount:Number(countRow?.n||0),retailAmount:n(f?.retailAmount),forPay:n(f?.forPay),acquiring:n(f?.acquiring),delivery:n(f?.delivery),storage:n(f?.storage),acceptance:n(f?.acceptance),deduction:n(f?.deduction),penalty:n(f?.penalty),additionalPayment:n(f?.additionalPayment),rebill:n(f?.rebill),advertising:n(a?.allAds),accountAdvertising,wbCharges,netBeforeCost},200,cors);
      }

      if (url.pathname === '/api/wb-finance-products' && request.method === 'GET') {
        const market=normalizeMarket(url.searchParams.get('market'));
        if(!['WB','WB2'].includes(market)) return json({ok:false,error:'market must be WB or WB2'},400,cors);
        const daysRaw=Number(url.searchParams.get('days')||30);
        const days=daysRaw===-1?-1:Math.max(1,Math.min(3660,daysRaw));
        const {since,until}=wbFinancePeriodBounds(days);
        const rows=await env.DB.prepare(`
          SELECT f.vendor_code AS vendorCode,f.nm_id AS nmId,MAX(f.title) AS title,l.product_id AS productId,
                 SUM(CASE WHEN trim(f.doc_type)='Продажа' THEN f.qty WHEN trim(f.doc_type)='Возврат' THEN -f.qty ELSE 0 END) AS qty,SUM(f.retail_amount) AS retailAmount,SUM(f.for_pay) AS forPay,
                 SUM(f.acquiring_fee) AS acquiring,SUM(f.delivery_service) AS delivery,
                 SUM(f.paid_storage) AS storage,SUM(f.paid_acceptance) AS acceptance,
                 SUM(f.deduction) AS deduction,SUM(f.penalty) AS penalty,
                 SUM(f.additional_payment) AS additionalPayment,SUM(f.rebill_logistic_cost) AS rebill
          FROM wb_finance_rows f
          LEFT JOIN product_links l ON l.market=f.market AND (l.sku=f.vendor_code OR l.sku=f.nm_id)
          WHERE f.market=? AND COALESCE(NULLIF(f.sale_date,0),f.rr_date)>=? AND COALESCE(NULLIF(f.sale_date,0),f.rr_date)<?
          GROUP BY f.vendor_code,f.nm_id,l.product_id
          ORDER BY SUM(f.for_pay) DESC`).bind(market,since,until).all();
        const n=x=>Number(x||0);
        const products=(rows.results||[]).map(x=>{const wbCharges=n(x.acquiring)+n(x.delivery)+n(x.storage)+n(x.acceptance)+n(x.deduction)+n(x.penalty)+n(x.rebill);return {...x,qty:n(x.qty),retailAmount:n(x.retailAmount),forPay:n(x.forPay),acquiring:n(x.acquiring),delivery:n(x.delivery),storage:n(x.storage),acceptance:n(x.acceptance),deduction:n(x.deduction),penalty:n(x.penalty),additionalPayment:n(x.additionalPayment),rebill:n(x.rebill),wbCharges,netBeforeCost:n(x.forPay)-wbCharges+n(x.additionalPayment)}});
        const day=new Date(since).toISOString().slice(0,10),untilDay=new Date(until).toISOString().slice(0,10);
        const ad=await env.DB.prepare(`SELECT SUM(amount) allAds,SUM(CASE WHEN lower(payment_type) LIKE '%счет%' OR lower(payment_type) LIKE '%account%' THEN amount ELSE 0 END) accountAds FROM wb_ad_costs WHERE market=? AND day>=? AND day<?`).bind(market,day,untilDay).first();
        return json({ok:true,market,days,products,advertising:n(ad?.allAds),accountAdvertising:n(ad?.accountAds)},200,cors);
      }

      if (url.pathname === '/api/orders' && request.method === 'GET') {
        const market = normalizeMarket(url.searchParams.get('market'));
        const limit = clamp(Number(url.searchParams.get('limit') || 500), 1, 1000);
        const where = market ? 'WHERE o.market = ?' : '';
        const args = market ? [market, limit] : [limit];
        const sql = `
          SELECT o.market,o.order_id AS orderId,o.code,o.entry_id AS entryId,o.status,o.state,
                 o.creation_date AS creationDate,o.sku,o.product_name AS productName,o.qty,
                 o.unit_price AS unitPrice,o.total_price AS totalPrice,o.seller_delivery_cost AS sellerDeliveryCost,
                 o.marketplace_fee AS marketplaceFee,o.fee_source AS feeSource,l.product_id AS productId
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
        await applyKaspiSkuAliases(env.DB, warehouse);
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

      if (url.pathname === '/api/stock-sync-status' && request.method === 'GET') {
        const stocks = await getStockSyncStatus(env.DB);
        return json({ ok: true, serverTime: Date.now(), mode: 'active', markets: stocks }, 200, cors);
      }

      if (url.pathname === '/api/kaspi-stock-feed-status' && request.method === 'GET') {
        if (!isTrustedBrowserOrigin(origin, env)) return json({ ok: false, error: 'Forbidden origin' }, 403, cors);
        const status = await getKaspiStockFeedStatus(env, request.url);
        return json({ ok: true, feature: 'kaspi-xml-stock-v1', fetchTracking: 'kaspi-xml-access-v1', ...status }, 200, cors);
      }

      if (url.pathname === '/api/kaspi-price-template' && request.method === 'PUT') {
        if (!isTrustedBrowserOrigin(origin, env)) return json({ ok: false, error: 'Forbidden origin' }, 403, cors);
        const body = await request.json();
        const status = await saveKaspiPriceTemplate(env, body, request.url);
        return json({ ok: true, feature: 'kaspi-xml-stock-v1', ...status }, 200, cors);
      }

      if (url.pathname === '/kaspi/price-list.xml' && request.method === 'GET') {
        const built = await buildKaspiPriceListXml(env, url);
        if (url.searchParams.get('check') !== '1') await recordKaspiPriceFeedFetch(env.DB, request);
        return new Response(built.xml, { status: 200, headers: {
          'Content-Type': 'application/xml; charset=utf-8',
          'Cache-Control': 'no-store, max-age=0',
          'X-Robots-Tag': 'noindex, nofollow'
        }});
      }

      if (url.pathname === '/api/stock-sync-preview' && request.method === 'GET') {
        const market = normalizeMarket(url.searchParams.get('market'));
        if (!['WB','WB2'].includes(market)) return json({ ok: false, error: 'market must be WB or WB2' }, 400, cors);
        const result = await previewWbStockMarket(env, market, { force: false });
        return json({ ok: true, result }, 200, cors);
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
      const orders = await syncAll(env, { scheduled: true });
      const stocks = {};
      for (const market of ['WB','WB2']) {
        try { stocks[market] = await syncWbStockMarket(env, market, { force: false }); }
        catch (e) { stocks[market] = { ok: false, error: String(e?.message || e) }; }
      }
      const finance={};
      for (const market of ['WB','WB2']) {
        try { finance[market]=await syncWbFinance(env,market,{force:false}); }
        catch(e){ finance[market]={ok:false,error:String(e?.message||e)}; }
      }
      return { orders, stocks, finance };
    })());
  }
};


function wbFinancePeriodBounds(days=30){
  const offset=5*60*60*1000;
  const nowLocal=Date.now()+offset;
  const d=new Date(nowLocal);
  const localMidnightUtc=Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate())-offset;
  if(Number(days)===-1)return {since:localMidnightUtc-86400000,until:localMidnightUtc};
  const n=Math.max(1,Number(days)||1);
  return {since:localMidnightUtc-(n-1)*86400000,until:localMidnightUtc+86400000};
}

async function ensureSchema(db) {
  if (!db) throw new Error('D1 binding DB is not configured');
  const statements = [
    `CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY,name TEXT NOT NULL,category TEXT NOT NULL DEFAULT '',photo TEXT NOT NULL DEFAULT '',min_stock INTEGER NOT NULL DEFAULT 0,stock INTEGER NOT NULL DEFAULT 0,cost REAL NOT NULL DEFAULT 0,total_profit REAL NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS product_links (id INTEGER PRIMARY KEY AUTOINCREMENT,product_id TEXT NOT NULL,market TEXT NOT NULL,sku TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE,UNIQUE(market,sku))`,
    `CREATE TABLE IF NOT EXISTS marketplace_order_lines (id INTEGER PRIMARY KEY AUTOINCREMENT,market TEXT NOT NULL,order_id TEXT NOT NULL,code TEXT NOT NULL DEFAULT '',entry_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT '',state TEXT NOT NULL DEFAULT '',creation_date INTEGER NOT NULL DEFAULT 0,sku TEXT NOT NULL DEFAULT '',product_name TEXT NOT NULL DEFAULT '',qty REAL NOT NULL DEFAULT 0,unit_price REAL NOT NULL DEFAULT 0,total_price REAL NOT NULL DEFAULT 0,seller_delivery_cost REAL NOT NULL DEFAULT 0,marketplace_fee REAL NOT NULL DEFAULT 0,fee_source TEXT NOT NULL DEFAULT '',raw_json TEXT NOT NULL DEFAULT '',first_seen_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(market,order_id,entry_id))`,
    `CREATE TABLE IF NOT EXISTS sync_runs (id INTEGER PRIMARY KEY AUTOINCREMENT,market TEXT NOT NULL,started_at INTEGER NOT NULL,finished_at INTEGER,ok INTEGER NOT NULL DEFAULT 0,items INTEGER NOT NULL DEFAULT 0,error TEXT NOT NULL DEFAULT '')`,
    `CREATE TABLE IF NOT EXISTS wb_finance_rows (market TEXT NOT NULL,rrd_id TEXT NOT NULL,report_id TEXT NOT NULL DEFAULT '',rr_date INTEGER NOT NULL DEFAULT 0,sale_date INTEGER NOT NULL DEFAULT 0,vendor_code TEXT NOT NULL DEFAULT '',nm_id TEXT NOT NULL DEFAULT '',title TEXT NOT NULL DEFAULT '',doc_type TEXT NOT NULL DEFAULT '',operation TEXT NOT NULL DEFAULT '',qty REAL NOT NULL DEFAULT 0,retail_amount REAL NOT NULL DEFAULT 0,for_pay REAL NOT NULL DEFAULT 0,acquiring_fee REAL NOT NULL DEFAULT 0,delivery_service REAL NOT NULL DEFAULT 0,paid_storage REAL NOT NULL DEFAULT 0,paid_acceptance REAL NOT NULL DEFAULT 0,deduction REAL NOT NULL DEFAULT 0,penalty REAL NOT NULL DEFAULT 0,additional_payment REAL NOT NULL DEFAULT 0,rebill_logistic_cost REAL NOT NULL DEFAULT 0,raw_json TEXT NOT NULL DEFAULT '',updated_at INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(market,rrd_id))`,
    `CREATE TABLE IF NOT EXISTS wb_ad_costs (market TEXT NOT NULL,day TEXT NOT NULL,advert_id TEXT NOT NULL,upd_num TEXT NOT NULL DEFAULT '',amount REAL NOT NULL DEFAULT 0,campaign TEXT NOT NULL DEFAULT '',payment_type TEXT NOT NULL DEFAULT '',raw_json TEXT NOT NULL DEFAULT '',updated_at INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(market,day,advert_id,upd_num))`,
    `CREATE TABLE IF NOT EXISTS wb_finance_sync_runs (id INTEGER PRIMARY KEY AUTOINCREMENT,market TEXT NOT NULL,started_at INTEGER NOT NULL,finished_at INTEGER,ok INTEGER NOT NULL DEFAULT 0,finance_ok INTEGER NOT NULL DEFAULT 0,promotion_ok INTEGER NOT NULL DEFAULT 0,finance_items INTEGER NOT NULL DEFAULT 0,ad_items INTEGER NOT NULL DEFAULT 0,error TEXT NOT NULL DEFAULT '')`,
    `CREATE TABLE IF NOT EXISTS warehouse_state (id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL DEFAULT '{}',revision INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS stock_sync_runs (id INTEGER PRIMARY KEY AUTOINCREMENT,market TEXT NOT NULL,mode TEXT NOT NULL DEFAULT 'preview',started_at INTEGER NOT NULL,finished_at INTEGER,ok INTEGER NOT NULL DEFAULT 0,warehouse_id TEXT NOT NULL DEFAULT '',linked INTEGER NOT NULL DEFAULT 0,mapped INTEGER NOT NULL DEFAULT 0,missing INTEGER NOT NULL DEFAULT 0,items INTEGER NOT NULL DEFAULT 0,error TEXT NOT NULL DEFAULT '')`,
    `CREATE TABLE IF NOT EXISTS wb_stock_links (market TEXT NOT NULL,sku TEXT NOT NULL,chrt_id INTEGER NOT NULL,source TEXT NOT NULL DEFAULT '',updated_at INTEGER NOT NULL,PRIMARY KEY(market,sku))`,
    `CREATE TABLE IF NOT EXISTS wb_stock_state (market TEXT PRIMARY KEY,warehouse_id TEXT NOT NULL DEFAULT '',payload_hash TEXT NOT NULL DEFAULT '',last_sent_at INTEGER NOT NULL DEFAULT 0,last_items INTEGER NOT NULL DEFAULT 0,last_error TEXT NOT NULL DEFAULT '',updated_at INTEGER NOT NULL DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS kaspi_price_template (id INTEGER PRIMARY KEY CHECK(id=1),raw_xml TEXT NOT NULL DEFAULT '',feed_key TEXT NOT NULL DEFAULT '',primary_store_id TEXT NOT NULL DEFAULT '',offer_count INTEGER NOT NULL DEFAULT 0,store_ids TEXT NOT NULL DEFAULT '[]',merchant_id TEXT NOT NULL DEFAULT '',updated_at INTEGER NOT NULL DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS kaspi_sku_aliases (old_sku TEXT PRIMARY KEY,seller_sku TEXT NOT NULL,updated_at INTEGER NOT NULL DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS kaspi_price_feed_access (id INTEGER PRIMARY KEY CHECK(id=1),last_fetched_at INTEGER NOT NULL DEFAULT 0,fetch_count INTEGER NOT NULL DEFAULT 0,last_user_agent TEXT NOT NULL DEFAULT '')`,
    `CREATE INDEX IF NOT EXISTS idx_stock_sync_runs_market_started ON stock_sync_runs(market,started_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_product_links_product ON product_links(product_id)`,
    `CREATE INDEX IF NOT EXISTS idx_order_lines_market_date ON marketplace_order_lines(market,creation_date DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_order_lines_market_sku ON marketplace_order_lines(market,sku)`,
    `CREATE INDEX IF NOT EXISTS idx_sync_runs_market_started ON sync_runs(market,started_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_wb_finance_market_date ON wb_finance_rows(market,rr_date DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_wb_ads_market_day ON wb_ad_costs(market,day DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_wb_finance_runs_market ON wb_finance_sync_runs(market,started_at DESC)`
  ];
  for (const sql of statements) await db.prepare(sql).run();
  await ensureColumn(db,'marketplace_order_lines','seller_delivery_cost','REAL NOT NULL DEFAULT 0');
  await ensureColumn(db,'marketplace_order_lines','marketplace_fee','REAL NOT NULL DEFAULT 0');
  await ensureColumn(db,'marketplace_order_lines','fee_source',"TEXT NOT NULL DEFAULT ''");
  await ensureColumn(db,'wb_finance_rows','sale_date','INTEGER NOT NULL DEFAULT 0');
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_wb_finance_market_sale_date ON wb_finance_rows(market,sale_date DESC)`).run();
  await db.prepare(`UPDATE wb_finance_rows SET sale_date=COALESCE(CAST(strftime('%s',json_extract(raw_json,'$.saleDt')) AS INTEGER)*1000,CAST(strftime('%s',json_extract(raw_json,'$.sale_dt')) AS INTEGER)*1000,rr_date) WHERE sale_date=0`).run();
}
async function ensureColumn(db,table,column,definition){const info=await db.prepare(`PRAGMA table_info(${table})`).all();if((info.results||[]).some(x=>String(x.name)===column))return;await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();}

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

async function rememberKaspiSkuAlias(db, oldSku, sellerSku) {
  const oldValue = String(oldSku || '').trim();
  const sellerValue = String(sellerSku || '').trim();
  if (!oldValue || !sellerValue || oldValue === sellerValue) return false;
  await db.prepare(`INSERT INTO kaspi_sku_aliases(old_sku,seller_sku,updated_at) VALUES(?,?,?)
    ON CONFLICT(old_sku) DO UPDATE SET seller_sku=excluded.seller_sku,updated_at=excluded.updated_at`)
    .bind(oldValue,sellerValue,Date.now()).run();
  return true;
}

async function canonicalKaspiSkusByProduct(db) {
  let info = null;
  try {
    const template = await readKaspiTemplateRow(db);
    if (template?.rawXml) info = kaspiTemplateInfo(template.rawXml);
  } catch {}
  if (!info?.offerSkus?.size) return { offerSkus:new Set(), byProduct:new Map() };
  const rows = await db.prepare("SELECT product_id AS productId,sku FROM product_links WHERE market='Kaspi'").all();
  const byProduct = new Map();
  for (const row of (rows.results || [])) {
    const productId = String(row.productId || '');
    const sku = String(row.sku || '').trim();
    if (!productId || !info.offerSkus.has(sku)) continue;
    const values = byProduct.get(productId) || [];
    if (!values.includes(sku)) values.push(sku);
    byProduct.set(productId, values);
  }
  return { offerSkus:info.offerSkus, byProduct };
}

async function applyKaspiSkuAliases(db, warehouse) {
  if (!Array.isArray(warehouse?.products) || !warehouse.products.length) return 0;
  const rows = await db.prepare('SELECT old_sku AS oldSku,seller_sku AS sellerSku FROM kaspi_sku_aliases').all();
  const aliases = new Map((rows.results || []).map(x => [String(x.oldSku || '').trim(), String(x.sellerSku || '').trim()]));
  const canonical = await canonicalKaspiSkusByProduct(db);
  let changed = 0;
  for (const product of warehouse.products) {
    const current = String(product?.kaspi || '').trim();
    let sellerSku = aliases.get(current) || '';
    if (!sellerSku && current && !canonical.offerSkus.has(current)) {
      const candidates = canonical.byProduct.get(String(product?.id || '')) || [];
      if (candidates.length === 1) sellerSku = candidates[0];
    }
    if (!sellerSku || sellerSku === current) continue;
    product.kaspi = sellerSku;
    await rememberKaspiSkuAlias(db, current, sellerSku);
    changed++;
  }
  return changed;
}

async function normalizeKaspiLineSkusAgainstTemplate(db, lines) {
  let info = null;
  try {
    const row = await readKaspiTemplateRow(db);
    if (row?.rawXml) info = kaspiTemplateInfo(row.rawXml);
  } catch {}
  if (!info?.offerSkus?.size) return lines || [];
  const result = [];
  for (const item of (lines || [])) {
    const rawLine = item?.raw?.line || {};
    const candidates = [rawLine?.sku, rawLine?.merchantCode, item?.sku]
      .map(x => String(x || '').trim()).filter((x,i,a) => x && a.indexOf(x) === i);
    const matched = candidates.find(x => info.offerSkus.has(x));
    if (matched) {
      for (const candidate of candidates) {
        if (candidate !== matched && !info.offerSkus.has(candidate)) await rememberKaspiSkuAlias(db, candidate, matched);
      }
    }
    result.push(matched && matched !== String(item?.sku || '').trim() ? { ...item, sku: matched } : item);
  }
  return result;
}

async function repairLegacyKaspiSkus(env) {
  const token = String(env.KASPI_TOKEN || '').trim();
  if (!token) return { checked:0, repaired:0 };
  let template = null, info = null;
  try {
    template = await readKaspiTemplateRow(env.DB);
    if (!template?.rawXml) return { checked:0, repaired:0 };
    info = kaspiTemplateInfo(template.rawXml);
  } catch { return { checked:0, repaired:0 }; }
  const row = await env.DB.prepare('SELECT payload,revision FROM warehouse_state WHERE id=1').first();
  if (!row?.payload) return { checked:0, repaired:0 };
  let warehouse = null;
  try { warehouse = JSON.parse(row.payload || '{}'); } catch { return { checked:0, repaired:0 }; }
  const candidates = (warehouse.products || []).filter(product => {
    const sku = String(product?.kaspi || '').trim();
    return sku && !info.offerSkus.has(sku);
  }).slice(0,20);
  if (!candidates.length) return { checked:0, repaired:0 };
  const headers = { 'Accept':'application/vnd.api+json', 'Content-Type':'application/vnd.api+json', 'X-Auth-Token':token };
  const fixes = [];
  for (const product of candidates) {
    const oldSku = String(product.kaspi || '').trim();
    try {
      const response = await fetch(`https://kaspi.kz/shop/api/v2/masterproducts/${encodeURIComponent(oldSku)}/merchantProduct`, { headers });
      const data = await safeJson(response, 'Kaspi merchant product SKU repair');
      if (!response.ok) continue;
      const sellerSku = String(data?.data?.attributes?.code || '').trim();
      if (!sellerSku || sellerSku === oldSku || !info.offerSkus.has(sellerSku)) continue;
      const conflict = await env.DB.prepare("SELECT product_id AS productId FROM product_links WHERE market='Kaspi' AND sku=? LIMIT 1").bind(sellerSku).first();
      if (conflict?.productId && String(conflict.productId) !== String(product.id)) continue;
      fixes.push({ productId:String(product.id), oldSku, sellerSku });
    } catch (e) {
      console.warn('Kaspi legacy SKU repair failed', oldSku, String(e?.message || e));
    }
  }
  if (!fixes.length) return { checked:candidates.length, repaired:0 };
  const latest = await env.DB.prepare('SELECT payload,revision FROM warehouse_state WHERE id=1').first();
  if (Number(latest?.revision || 0) !== Number(row.revision || 0)) return { checked:candidates.length, repaired:0, skipped:'revision-changed' };
  let current = null;
  try { current = JSON.parse(latest.payload || '{}'); } catch { return { checked:candidates.length, repaired:0 }; }
  const applied = [];
  for (const fix of fixes) {
    const product = (current.products || []).find(x => String(x?.id) === fix.productId);
    if (!product || String(product.kaspi || '').trim() !== fix.oldSku) continue;
    product.kaspi = fix.sellerSku;
    applied.push(fix);
  }
  if (!applied.length) return { checked:candidates.length, repaired:0 };
  const nextRevision = Number(latest.revision || 0) + 1;
  const now = Date.now();
  await env.DB.prepare('UPDATE warehouse_state SET payload=?,revision=?,updated_at=? WHERE id=1 AND revision=?')
    .bind(JSON.stringify(current), nextRevision, now, Number(latest.revision || 0)).run();
  for (const fix of applied) {
    await rememberKaspiSkuAlias(env.DB, fix.oldSku, fix.sellerSku);
    await env.DB.prepare("DELETE FROM product_links WHERE market='Kaspi' AND product_id=? AND sku=?").bind(fix.productId,fix.oldSku).run();
  }
  await importProducts(env.DB, current.products || []);
  console.log('Kaspi seller SKU repaired', applied.map(x => `${x.oldSku}->${x.sellerSku}`).join(', '));
  return { checked:candidates.length, repaired:applied.length };
}

async function syncMarket(env, market) {
  const startedAt = Date.now();
  const run = await env.DB.prepare('INSERT INTO sync_runs(market,started_at) VALUES(?,?) RETURNING id').bind(market, startedAt).first();
  try {
    let lines = [];
    if (market === 'Kaspi') {
      await repairLegacyKaspiSkus(env);
      lines = await fetchKaspi(env);
      lines = await normalizeKaspiLineSkusAgainstTemplate(env.DB, lines);
    }
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
    await updateKaspiOrderFinancials(env.DB,order);
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

async function updateKaspiOrderFinancials(db,order){const orderId=String(order?.id||'').trim();if(!orderId)return;const rows=await db.prepare(`SELECT id,total_price AS totalPrice FROM marketplace_order_lines WHERE market='Kaspi' AND order_id=? AND entry_id<>'__pending__'`).bind(orderId).all(),items=rows.results||[];if(!items.length)return;const revenue=items.reduce((sum,x)=>sum+Math.max(0,Number(x.totalPrice)||0),0),delivery=Math.max(0,Number(order?.deliveryCostForSeller)||0),commission=kaspiExplicitCommission(order);if(delivery<=0&&commission<=0)return;await db.batch(items.map(x=>{const weight=revenue>0?Math.max(0,Number(x.totalPrice)||0)/revenue:1/items.length,d=delivery*weight,c=commission*weight,source=[d>0?'Kaspi API доставка':'',c>0?'Kaspi API комиссия':''].filter(Boolean).join(' + ');return db.prepare('UPDATE marketplace_order_lines SET seller_delivery_cost=?,marketplace_fee=?,fee_source=?,updated_at=? WHERE id=?').bind(d,c,source,Date.now(),x.id)}))}

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

function firstMoney(obj,keys){for(const key of keys){const value=Number(obj?.[key]);if(Number.isFinite(value)&&value>0)return value}return 0}
function kaspiExplicitCommission(obj){return firstMoney(obj,['commissionAmount','commissionForSeller','sellerCommission','marketplaceFee','serviceFee','serviceCostForSeller','commission'])}
function appendKaspiLines(result,order,lines){const prepared=(lines||[]).map(line=>{const qty=Math.max(0,Number(line?.quantity||1)),total=Number(line?.totalPrice||(Number(line?.basePrice||0)*qty)||0);return {line,qty,total}}),revenue=prepared.reduce((sum,x)=>sum+Math.max(0,x.total),0),orderDelivery=Math.max(0,Number(order?.deliveryCostForSeller)||0),orderCommission=kaspiExplicitCommission(order);for(const {line,qty,total} of prepared){const weight=revenue>0?Math.max(0,total)/revenue:(prepared.length?1/prepared.length:0),lineCommission=kaspiExplicitCommission(line),sellerDeliveryCost=orderDelivery*weight,marketplaceFee=lineCommission||orderCommission*weight,sources=[];if(sellerDeliveryCost>0)sources.push('Kaspi API доставка');if(marketplaceFee>0)sources.push('Kaspi API комиссия');result.push({orderId:String(order?.id||''),code:String(order?.code||''),entryId:String(line?.entryId||line?.id||''),status:String(order?.status||''),state:String(order?.state||''),creationDate:toTimestamp(order?.creationDate),sku:String(line?.merchantCode||line?.sku||'').trim(),productName:String(line?.productName||line?.name||''),qty,unitPrice:qty?total/qty:Number(line?.basePrice||0),totalPrice:total,sellerDeliveryCost,marketplaceFee,feeSource:sources.join(' + '),raw:{order,line}})}}

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
    sellerDeliveryCost:Math.max(0,Number(order?.deliveryCostForSeller)||0),marketplaceFee:kaspiExplicitCommission(order),feeSource:Math.max(0,Number(order?.deliveryCostForSeller)||0)>0?'Kaspi API доставка':'',
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
      merchantCode,
      masterProductId,
      productName: productName || String(attrs?.category?.title || '')
    });
  }
  return { lines, budget };
}


function kaspiStockHttpError(message, status = 400) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function kaspiXmlDecode(value) {
  return String(value || '').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
}

function kaspiXmlEscapeAttr(value) {
  return String(value ?? '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function kaspiXmlAttr(tag, name) {
  const re = new RegExp('\\b' + name + '\\s*=\\s*(["\\\'])([^"\\\']*)\\1', 'i');
  const m = re.exec(String(tag || ''));
  return m ? kaspiXmlDecode(m[2]) : '';
}

function setKaspiXmlAttr(tag, name, value) {
  const src = String(tag || '');
  const safe = kaspiXmlEscapeAttr(value);
  const re = new RegExp('(\\s' + name + '\\s*=\\s*)(["\\\'])([^"\\\']*)\\2', 'i');
  if (re.test(src)) return src.replace(re, (_m, prefix) => prefix + '"' + safe + '"');
  return src.replace(/\s*\/?>$/, tail => ' ' + name + '="' + safe + '"' + (tail.trim().startsWith('/') ? '/>' : '>'));
}

function kaspiTemplateInfo(xml) {
  const raw = String(xml || '').trim();
  if (!raw || !/<kaspi_catalog\b/i.test(raw) || !/<\/kaspi_catalog>/i.test(raw)) throw kaspiStockHttpError('Нужен полный XML-прайс Kaspi с тегом kaspi_catalog.');
  const merchantMatch = raw.match(/<merchantid\b[^>]*>([\s\S]*?)<\/merchantid>/i);
  const merchantId = merchantMatch ? String(merchantMatch[1] || '').replace(/<[^>]+>/g,'').trim() : '';
  if (!merchantId) throw kaspiStockHttpError('В XML не найден merchantid Kaspi.');
  const offerSkus = new Set();
  const stores = new Set();
  const skuStores = new Map();
  const offerRe = /<offer\b[^>]*\bsku\s*=\s*(["'])([^"']+)\1[^>]*>[\s\S]*?<\/offer>/gi;
  let m;
  while ((m = offerRe.exec(raw))) {
    const sku = kaspiXmlDecode(String(m[2] || '').trim());
    if (!sku) continue;
    offerSkus.add(sku);
    const set = new Set();
    const avRe = /<availability\b[^>]*\bstoreId\s*=\s*(["'])([^"']+)\1[^>]*\/?>/gi;
    let a;
    while ((a = avRe.exec(m[0]))) {
      const store = kaspiXmlDecode(String(a[2] || '').trim());
      if (!store) continue;
      stores.add(store);
      set.add(store);
    }
    skuStores.set(sku, set);
  }
  if (!offerSkus.size) throw kaspiStockHttpError('В XML не найдено ни одного offer sku.');
  if (!stores.size) throw kaspiStockHttpError('В XML не найдены склады availability storeId.');
  return { raw, merchantId, offerSkus, storeIds:[...stores], skuStores };
}

function kaspiLinkedProducts(warehouse) {
  const seen = new Set(), out = [];
  for (const product of warehouse.products || []) {
    const sku = String(product?.kaspi || '').trim();
    if (!sku || seen.has(sku)) continue;
    seen.add(sku);
    out.push({ sku, product });
  }
  return out;
}

function kaspiFeedUrl(requestUrl, key) {
  if (!key) return '';
  const u = new URL(requestUrl);
  const feed = new URL('/kaspi/price-list.xml', u.origin);
  feed.searchParams.set('key', key);
  return feed.toString();
}

async function readKaspiTemplateRow(db) {
  return await db.prepare('SELECT raw_xml AS rawXml,feed_key AS feedKey,primary_store_id AS primaryStoreId,offer_count AS offerCount,store_ids AS storeIds,merchant_id AS merchantId,updated_at AS updatedAt FROM kaspi_price_template WHERE id=1').first();
}

async function readKaspiPriceFeedAccess(db) {
  return await db.prepare('SELECT last_fetched_at AS lastFetchedAt,fetch_count AS fetchCount,last_user_agent AS lastUserAgent FROM kaspi_price_feed_access WHERE id=1').first();
}

function kaspiFeedAccessFields(row) {
  return { lastFetchedAt:Number(row?.lastFetchedAt||0), fetchCount:Number(row?.fetchCount||0), lastFetchUserAgent:String(row?.lastUserAgent||'') };
}

async function recordKaspiPriceFeedFetch(db, request) {
  const now=Date.now();
  const userAgent=String(request.headers.get('User-Agent')||'').slice(0,300);
  await db.prepare(`INSERT INTO kaspi_price_feed_access(id,last_fetched_at,fetch_count,last_user_agent) VALUES(1,?,1,?)
    ON CONFLICT(id) DO UPDATE SET last_fetched_at=excluded.last_fetched_at,fetch_count=kaspi_price_feed_access.fetch_count+1,last_user_agent=excluded.last_user_agent`)
    .bind(now,userAgent).run();
}

async function getKaspiStockFeedStatus(env, requestUrl) {
  const row = await readKaspiTemplateRow(env.DB);
  const accessFields = kaspiFeedAccessFields(await readKaspiPriceFeedAccess(env.DB));
  if (!row?.rawXml) return { configured:false, ready:false, feedUrl:'', offerCount:0, storeIds:[], primaryStoreId:'', linked:0, matched:0, missingSkus:[], missingPrimaryStore:[], ...accessFields };
  let info;
  try { info = kaspiTemplateInfo(row.rawXml); }
  catch (e) { return { configured:true, ready:false, error:String(e?.message || e), feedUrl:'', offerCount:Number(row.offerCount || 0), storeIds:[], primaryStoreId:String(row.primaryStoreId || ''), linked:0, matched:0, missingSkus:[], missingPrimaryStore:[], ...accessFields }; }
  let warehouse;
  try { warehouse = await loadWarehouseSnapshotForStock(env.DB); }
  catch (e) { return { configured:true, ready:false, error:String(e?.message || e), feedUrl:kaspiFeedUrl(requestUrl,row.feedKey), offerCount:info.offerSkus.size, storeIds:info.storeIds, primaryStoreId:String(row.primaryStoreId || ''), linked:0, matched:0, missingSkus:[], missingPrimaryStore:[], ...accessFields }; }
  const linked = kaspiLinkedProducts(warehouse);
  const matchedRows = linked.filter(x => info.offerSkus.has(x.sku));
  const missingSkus = linked.filter(x => !info.offerSkus.has(x.sku)).map(x => x.sku);
  const selected = String(row.primaryStoreId || '').trim() || (info.storeIds.length === 1 ? info.storeIds[0] : '');
  const missingPrimaryStore = selected ? matchedRows.filter(x => !info.skuStores.get(x.sku)?.has(selected)).map(x => x.sku) : [];
  const ready = Boolean(selected && info.storeIds.includes(selected) && matchedRows.length && !missingPrimaryStore.length && (warehouse.products || []).length);
  return {
    configured:true, ready, feedUrl:kaspiFeedUrl(requestUrl,row.feedKey), merchantId:info.merchantId,
    offerCount:info.offerSkus.size, storeIds:info.storeIds, primaryStoreId:selected,
    linked:linked.length, matched:matchedRows.length, missingSkus:missingSkus.slice(0,200),
    missingPrimaryStore:missingPrimaryStore.slice(0,200), updatedAt:Number(row.updatedAt || 0),
    multiStoreMode:info.storeIds.length > 1 ? 'primary-store-only-for-managed-skus' : 'single-store', ...accessFields
  };
}

async function saveKaspiPriceTemplate(env, body, requestUrl) {
  const xml = typeof body?.xml === 'string' ? body.xml : '';
  const requestedStore = String(body?.primaryStoreId || '').trim();
  const existing = await readKaspiTemplateRow(env.DB);
  if (!xml && !existing?.rawXml) throw kaspiStockHttpError('Сначала загрузите текущий XML-прайс Kaspi.');
  const raw = xml || existing.rawXml;
  if (raw.length > 6_000_000) throw kaspiStockHttpError('XML-прайс слишком большой для этого импорта (лимит 6 МБ).', 413);
  const info = kaspiTemplateInfo(raw);
  let primaryStoreId = requestedStore || String(existing?.primaryStoreId || '').trim();
  if (primaryStoreId && !info.storeIds.includes(primaryStoreId)) throw kaspiStockHttpError('Выбранного склада нет в загруженном XML Kaspi.');
  if (!primaryStoreId && info.storeIds.length === 1) primaryStoreId = info.storeIds[0];
  const feedKey = String(existing?.feedKey || '').trim() || crypto.randomUUID().replace(/-/g,'');
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO kaspi_price_template(id,raw_xml,feed_key,primary_store_id,offer_count,store_ids,merchant_id,updated_at)
    VALUES(1,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET raw_xml=excluded.raw_xml,feed_key=excluded.feed_key,primary_store_id=excluded.primary_store_id,offer_count=excluded.offer_count,store_ids=excluded.store_ids,merchant_id=excluded.merchant_id,updated_at=excluded.updated_at`)
    .bind(raw,feedKey,primaryStoreId,info.offerSkus.size,JSON.stringify(info.storeIds),info.merchantId,now).run();
  return await getKaspiStockFeedStatus(env, requestUrl);
}

async function buildKaspiPriceListXml(env, url) {
  const row = await readKaspiTemplateRow(env.DB);
  const suppliedKey = String(url.searchParams.get('key') || '');
  if (!row?.rawXml || !row?.feedKey || suppliedKey !== String(row.feedKey)) throw kaspiStockHttpError('Not found', 404);
  const warehouse = await loadWarehouseSnapshotForStock(env.DB);
  if (!(warehouse.products || []).length) throw kaspiStockHttpError('Warehouse is empty; Kaspi feed blocked by safety gate.', 503);
  const linked = kaspiLinkedProducts(warehouse);
  if (!linked.length) throw kaspiStockHttpError('No Kaspi-linked products; feed blocked by safety gate.', 409);
  const info = kaspiTemplateInfo(row.rawXml);
  const primaryStoreId = String(row.primaryStoreId || '').trim() || (info.storeIds.length === 1 ? info.storeIds[0] : '');
  if (!primaryStoreId || !info.storeIds.includes(primaryStoreId)) throw kaspiStockHttpError('Primary Kaspi store is not selected.', 409);
  const orderRows = await env.DB.prepare("SELECT market,order_id AS orderId,entry_id AS entryId,status,state,creation_date AS creationDate,sku,qty FROM marketplace_order_lines WHERE market IN ('Kaspi','WB','WB2')").all();
  const amounts = computeSharedAvailableStocks(warehouse, orderRows.results || []);
  const managed = new Map(linked.map(x => [x.sku, x.product]));
  const matched = new Set();
  const missingPrimary = [];
  const offerRe = /(<offer\b[^>]*\bsku\s*=\s*(["'])([^"']+)\2[^>]*>)([\s\S]*?)(<\/offer>)/gi;
  const xml = String(row.rawXml).replace(offerRe, (whole, open, _q, encodedSku, body, close) => {
    const sku = kaspiXmlDecode(encodedSku).trim();
    const product = managed.get(sku);
    if (!product) return whole;
    matched.add(sku);
    const storeSet = info.skuStores.get(sku) || new Set();
    if (!storeSet.has(primaryStoreId)) {
      missingPrimary.push(sku);
      return whole;
    }
    const amount = Math.max(0, Math.floor(Number(amounts.get(String(product.id))) || 0));
    let foundPrimary = false;
    const updatedBody = body.replace(/<availability\b[^>]*\/?>/gi, tag => {
      const storeId = kaspiXmlAttr(tag, 'storeId');
      if (!storeId) return tag;
      let next = tag;
      if (storeId === primaryStoreId) {
        foundPrimary = true;
        next = setKaspiXmlAttr(next, 'available', amount > 0 ? 'yes' : 'no');
        next = setKaspiXmlAttr(next, 'stockCount', String(amount));
        return next;
      }
      if (info.storeIds.length > 1) {
        next = setKaspiXmlAttr(next, 'available', 'no');
        next = setKaspiXmlAttr(next, 'stockCount', '0');
      }
      return next;
    });
    if (!foundPrimary) {
      missingPrimary.push(sku);
      return whole;
    }
    return open + updatedBody + close;
  });
  if (!matched.size) throw kaspiStockHttpError('No linked Kaspi SKU matched the uploaded XML; feed blocked by safety gate.', 409);
  if (missingPrimary.length) throw kaspiStockHttpError('Selected Kaspi store is missing for linked SKU: ' + missingPrimary.slice(0,12).join(', '), 409);
  return { xml, matched:matched.size, primaryStoreId };
}

async function getStockSyncStatus(db) {
  const rows = [];
  for (const market of ['WB','WB2']) {
    const latest = await db.prepare('SELECT * FROM stock_sync_runs WHERE market=? ORDER BY id DESC LIMIT 1').bind(market).first();
    const preview = await db.prepare("SELECT * FROM stock_sync_runs WHERE market=? AND mode='preview' AND ok=1 ORDER BY id DESC LIMIT 1").bind(market).first();
    const write = await db.prepare("SELECT * FROM stock_sync_runs WHERE market=? AND mode='write' ORDER BY id DESC LIMIT 1").bind(market).first();
    const state = await db.prepare('SELECT * FROM wb_stock_state WHERE market=?').bind(market).first();
    rows.push({ market, latest: latest || null, preview: preview || null, lastWrite: write || null, state: state || null, ready: Boolean(preview?.ok && Number(preview?.linked || 0) > 0 && Number(preview?.missing || 0) === 0 && String(preview?.warehouse_id || '')), active: Boolean(write?.ok && Number(state?.last_sent_at || 0) > 0) });
  }
  return rows;
}

async function stockPayloadHash(items) {
  const text = (items || []).slice().sort((a,b)=>Number(a.chrtId)-Number(b.chrtId)).map(x => String(Number(x.chrtId)) + ':' + String(Math.max(0,Math.floor(Number(x.amount)||0)))).join('|');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');
}

async function readWbCachedStockLinks(db, market, linked) {
  const rows = await db.prepare('SELECT sku,chrt_id AS chrtId FROM wb_stock_links WHERE market=?').bind(market).all();
  const map = new Map((rows.results || []).map(x => [String(x.sku || ''), Number(x.chrtId || 0)]));
  return (linked || []).map(x => ({ product:x.product, sku:x.sku, chrtId:Number(map.get(String(x.sku)) || 0) }));
}

async function readWbActualStocks(token, warehouseId, items) {
  const ids=[...new Set((items||[]).map(x=>Number(x.chrtId)||0).filter(Boolean))];
  const actual=new Map();
  const headers={ 'Accept':'application/json', 'Content-Type':'application/json', 'Authorization':token };
  for(let i=0;i<ids.length;i+=1000){
    const chunk=ids.slice(i,i+1000);
    const r=await fetch(WB_MARKETPLACE_BASE + '/api/v3/stocks/' + encodeURIComponent(warehouseId), { method:'POST', headers, body:JSON.stringify({ chrtIds:chunk }) });
    const text=await r.text();
    let data=null; if(text){ try{data=JSON.parse(text)}catch{data={message:text.slice(0,500)}} }
    if(!r.ok) throw new Error(wbError('WB stocks read',r.status,data||{}));
    for(const row of Array.isArray(data?.stocks)?data.stocks:[]){
      const chrtId=Number(row?.chrtId)||0;
      if(chrtId) actual.set(chrtId,Math.max(0,Math.floor(Number(row?.amount)||0)));
    }
  }
  return actual;
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
    let actual;
    try {
      actual=await readWbActualStocks(token,warehouseId,items);
    } catch(e) {
      return { ok:true, market, skipped:true, reason:'verify-failed-safety', sent:false, warehouseId, items:items.length, lastSentAt:Number(previous.last_sent_at || 0), error:String(e?.message||e).slice(0,500) };
    }
    const drift=items.filter(x=>{
      const chrtId=Number(x.chrtId)||0;
      const current=actual.has(chrtId)?Number(actual.get(chrtId)||0):0;
      return current!==Math.max(0,Math.floor(Number(x.amount)||0));
    });
    if(!drift.length) return { ok:true, market, skipped:true, reason:'unchanged', verified:true, sent:false, warehouseId, items:items.length, lastSentAt:Number(previous.last_sent_at || 0) };
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

function wbToken(env,market){return String((market==='WB2'?env.WB_TOKEN_2:env.WB_TOKEN)||'').trim()}
function wbMoney(v){const n=Number(v);return Number.isFinite(n)?n:0}
function wbDateMs(v){const t=Date.parse(String(v||''));return Number.isFinite(t)?t:0}
async function wbApiFetch(url,token,opts={}){const r=await fetch(url,{...opts,headers:{Accept:'application/json',Authorization:token,'Content-Type':'application/json',...(opts.headers||{})}});if(r.status===204)return [];let data=null;try{data=await r.json()}catch{}if(!r.ok){const e=new Error('WB API HTTP '+r.status+(data?.detail?' · '+data.detail:''));e.status=r.status;throw e}return data}
async function syncWbFinance(env,market='WB',{force=false}={}){if(!['WB','WB2'].includes(market))throw new Error('Unsupported WB finance market');const token=wbToken(env,market);if(!token)throw new Error((market==='WB2'?'WB_TOKEN_2':'WB_TOKEN')+' is not configured');const last=await env.DB.prepare('SELECT * FROM wb_finance_sync_runs WHERE market=? ORDER BY id DESC LIMIT 1').bind(market).first();if(!force&&last&&Date.now()-Number(last.started_at||0)<WB_FINANCE_SYNC_MS)return {ok:Boolean(last.ok),skipped:true,nextSyncAt:Number(last.started_at)+WB_FINANCE_SYNC_MS,financeOk:Boolean(last.finance_ok),promotionOk:Boolean(last.promotion_ok)};const now=Date.now(),run=await env.DB.prepare('INSERT INTO wb_finance_sync_runs(market,started_at) VALUES(?,?) RETURNING id').bind(market,now).first();let financeOk=false,promotionOk=false,financeItems=0,adItems=0,errors=[];const to=new Date(),from=new Date(Date.now()-30*86400000),fromDay=from.toISOString().slice(0,10),toDay=to.toISOString().slice(0,10);try{const rows=await wbApiFetch(WB_FINANCE_BASE+'/api/finance/v1/sales-reports/detailed',token,{method:'POST',body:JSON.stringify({dateFrom:fromDay,dateTo:toDay,limit:100000,rrdId:0,period:'daily'})});for(const x of(Array.isArray(rows)?rows:[])){const rrd=String(x.rrdId??'');if(!rrd)continue;await env.DB.prepare(`INSERT INTO wb_finance_rows(market,rrd_id,report_id,rr_date,sale_date,vendor_code,nm_id,title,doc_type,operation,qty,retail_amount,for_pay,acquiring_fee,delivery_service,paid_storage,paid_acceptance,deduction,penalty,additional_payment,rebill_logistic_cost,raw_json,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(market,rrd_id) DO UPDATE SET report_id=excluded.report_id,rr_date=excluded.rr_date,sale_date=excluded.sale_date,vendor_code=excluded.vendor_code,nm_id=excluded.nm_id,title=excluded.title,doc_type=excluded.doc_type,operation=excluded.operation,qty=excluded.qty,retail_amount=excluded.retail_amount,for_pay=excluded.for_pay,acquiring_fee=excluded.acquiring_fee,delivery_service=excluded.delivery_service,paid_storage=excluded.paid_storage,paid_acceptance=excluded.paid_acceptance,deduction=excluded.deduction,penalty=excluded.penalty,additional_payment=excluded.additional_payment,rebill_logistic_cost=excluded.rebill_logistic_cost,raw_json=excluded.raw_json,updated_at=excluded.updated_at`).bind(market,rrd,String(x.reportId??''),wbDateMs(x.rrDate||x.createDate),wbDateMs(x.saleDt||x.rrDate||x.createDate),String(x.vendorCode??''),String(x.nmId??''),String(x.title??''),String(x.docTypeName??''),String(x.sellerOperName??''),wbMoney(x.quantity),wbMoney(x.retailAmount),wbMoney(x.forPay),wbMoney(x.acquiringFee),wbMoney(x.deliveryService),wbMoney(x.paidStorage),wbMoney(x.paidAcceptance),wbMoney(x.deduction),wbMoney(x.penalty),wbMoney(x.additionalPayment),wbMoney(x.rebillLogisticCost),JSON.stringify(x),now).run();financeItems++}financeOk=true}catch(e){errors.push('finance: '+String(e?.message||e))}try{const rows=await wbApiFetch(WB_ADVERT_BASE+'/adv/v1/upd?from='+encodeURIComponent(fromDay)+'&to='+encodeURIComponent(toDay),token);for(const x of(Array.isArray(rows)?rows:[])){const ts=String(x.updTime||''),day=(ts?ts.slice(0,10):toDay),advert=String(x.advertId??''),num=String(x.updNum??'');await env.DB.prepare(`INSERT INTO wb_ad_costs(market,day,advert_id,upd_num,amount,campaign,payment_type,raw_json,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(market,day,advert_id,upd_num) DO UPDATE SET amount=excluded.amount,campaign=excluded.campaign,payment_type=excluded.payment_type,raw_json=excluded.raw_json,updated_at=excluded.updated_at`).bind(market,day,advert,num,wbMoney(x.updSum),String(x.campName??''),String(x.paymentType??''),JSON.stringify(x),now).run();adItems++}promotionOk=true}catch(e){errors.push('promotion: '+String(e?.message||e))}const ok=financeOk||promotionOk;await env.DB.prepare('UPDATE wb_finance_sync_runs SET finished_at=?,ok=?,finance_ok=?,promotion_ok=?,finance_items=?,ad_items=?,error=? WHERE id=?').bind(Date.now(),ok?1:0,financeOk?1:0,promotionOk?1:0,financeItems,adItems,errors.join('; '),run.id).run();return {ok,market,financeOk,promotionOk,financeItems,adItems,error:errors.join('; ')}}

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
      (market,order_id,code,entry_id,status,state,creation_date,sku,product_name,qty,unit_price,total_price,seller_delivery_cost,marketplace_fee,fee_source,raw_json,first_seen_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(market,order_id,entry_id) DO UPDATE SET
      code=excluded.code,status=excluded.status,state=excluded.state,creation_date=excluded.creation_date,
      sku=excluded.sku,product_name=excluded.product_name,qty=excluded.qty,unit_price=excluded.unit_price,
      total_price=excluded.total_price,seller_delivery_cost=excluded.seller_delivery_cost,marketplace_fee=excluded.marketplace_fee,fee_source=excluded.fee_source,raw_json=excluded.raw_json,updated_at=excluded.updated_at
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
  return db.prepare(sql).bind(market,o.orderId,o.code,o.entryId,o.status,o.state,o.creationDate,o.sku,o.productName,o.qty,o.unitPrice,o.totalPrice,Number(o.sellerDeliveryCost)||0,Number(o.marketplaceFee)||0,String(o.feeSource||''),JSON.stringify(o.raw || {}),now,now);
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
  return { products:arr('products').slice(0,20000), movements:arr('movements').slice(0,5000), sales:arr('sales').slice(0,20000), purchases:arr('purchases').slice(0,20000), reservations:arr('reservations').slice(0,20000), kaspiAdExpenses:arr('kaspiAdExpenses').slice(0,5000), settings, marketOrderState:obj('marketOrderState'), marketplaceLiveSince:obj('marketplaceLiveSince'), kaspiBaselineAt:x.kaspiBaselineAt||null };
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
