import { ozonRouter, startOzonSyncLoop } from './ozon-fbo.js';
import express from 'express';
import helmet from 'helmet';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { config, assertRuntimeConfig } from './config.js';
import { pool } from './db.js';
import { exactCors, noStore, requireTrustedOrigin } from './http.js';
import { warehouseRouter } from './warehouse.js';
import { financeRouter } from './finance.js';
import { financeLedgerRouter } from './finance-ledger.js';
import { ordersRouter } from './orders.js';
import { reportsRouter } from './reports.js';
import { stockRouter, kaspiFeedHandler } from './stock.js';
import { hydrateWarehouseProducts } from './warehouse-products.js';
import { startKaspiSyncLoop, syncKaspiOrders } from './kaspi-sync.js';
import { startWbSyncLoop, syncWbOrders } from './wb-sync.js';
import { syncWbStockMarket, validateWbStockLinks } from './wb-stock-sync.js';
import { authConfig, login, requireAppSession, webauthnLoginOptions, webauthnLoginVerify, webauthnRegisterOptions, webauthnRegisterVerify, listWebauthnCredentials, deleteWebauthnCredential } from './auth.js';
import { configuredWbConnectionIds, connectionsRouter } from './connections.js';
import { wbVariantsRouter } from './wb-variants.js';
import { wbReturnsRouter } from './wb-returns.js';
import { wbAdsRouter, startWbAdsLimitLoop } from './wb-ads.js';
import { aiAssistantRouter } from './ai-assistant.js';

assertRuntimeConfig();

const app = express();
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const frontendFiles = Object.freeze([
  'manifest.webmanifest',
  'sw.js',
  'app-icon.svg',
  'ozon-fbo-v1.js',
  'business-dashboard-v1.js',
  'ozon-supplies-v1.js',
  'warehouse-insights.js',
  'cloud-sync-v3.js',
  'wb-variants-v1.js',
  'kaspi-report-v2.js',
  'kaspi-ads-v2.js',
  'save-conflict-v1.js',
  'purchase-delete-v1.js',
  'purchase-plan-ignore-v1.js',
  'purchase-arrival-sort-v1.js',
  'kaspi-status-compat-v1.js',
  'kaspi-ads-v2-original.js',
  'reservation-compat-v1.js',
  'stock-alerts-rescue-v1.js',
  'ai-assistant-v1.js',
]);
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({
  crossOriginResourcePolicy: false,
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://accounts.google.com', 'https://cdn.jsdelivr.net'],
      // The existing single-page UI deliberately uses inline onclick/onsubmit
      // handlers. Keep those handlers enabled when the UI is served by Railway;
      // otherwise the browser submits forms normally and buttons appear inert.
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
      connectSrc: ["'self'", 'https://accounts.google.com', 'https://oauth2.googleapis.com', 'https://www.googleapis.com'],
      frameSrc: ['https://accounts.google.com'],
      objectSrc: ["'none'"]
    }
  }
}));
app.use(exactCors);
app.use(noStore);
app.use(express.json({ limit: '7mb', strict: true }));

app.get(['/', '/index.html'], (_req, res) => res.sendFile(path.join(repositoryRoot, 'index.html')));
app.get('/ozon-fbo-v1.js', async (_req,res,next)=>{
  try{
    const [rawBase,supplies]=await Promise.all([
      readFile(path.join(repositoryRoot,'ozon-fbo-v1.js'),'utf8'),
      readFile(path.join(repositoryRoot,'ozon-supplies-v1.js'),'utf8')
    ]);
    const syncTimeCode="const complete=(data.accounts||[]).map(a=>[a.postings?.updatedAt,a.stocks?.updatedAt,a.finance?.updatedAt,a.supplies?.updatedAt].map(Number)).filter(x=>x.every(Boolean)).map(x=>Math.min(...x));text=complete.length===(data.accounts||[]).length&&complete.length?new Date(Math.min(...complete)).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'}):'—';";
    const base=rawBase.replace("text='работает';",syncTimeCode);
    res.type('application/javascript').send(base+'\n'+supplies);
  }catch(error){next(error);}
});
for (const file of frontendFiles) {
  app.get(`/${file}`, (_req, res) => res.sendFile(path.join(repositoryRoot, file)));
}

app.get('/api/auth/config', requireTrustedOrigin, authConfig);
app.post('/api/auth/login', requireTrustedOrigin, login);
app.get('/api/auth/session', requireTrustedOrigin, requireAppSession, (_req,res) => res.json({ ok:true }));
app.post('/api/auth/webauthn/register-options', requireTrustedOrigin, webauthnRegisterOptions);
app.post('/api/auth/webauthn/register-verify', requireTrustedOrigin, webauthnRegisterVerify);
app.post('/api/auth/webauthn/login-options', requireTrustedOrigin, webauthnLoginOptions);
app.post('/api/auth/webauthn/login-verify', requireTrustedOrigin, webauthnLoginVerify);
app.use('/api', requireAppSession);
app.get('/api/auth/webauthn/credentials', requireTrustedOrigin, listWebauthnCredentials);
app.delete('/api/auth/webauthn/credentials/:id', requireTrustedOrigin, deleteWebauthnCredential);

app.get('/health', async (_req, res, next) => {
  try {
    const db = await pool.query('SELECT 1 AS ok');
    const migrations = await pool.query("SELECT to_regclass('public.schema_migrations') AS name");
    res.json({ ok: db.rows[0]?.ok === 1, service: 'millioner-railway-api', postgres: true,
      writesEnabled: config.writesEnabled, marketSyncEnabled: true, migrationsReady: Boolean(migrations.rows[0]?.name) });
  } catch (error) { next(error); }
});

app.get('/api/system/storage-status', requireTrustedOrigin, async (_req, res, next) => {
  try {
    const capacityGb = Math.max(0.5, Number(process.env.POSTGRES_VOLUME_GB || 5) || 5);
    const capacityBytes = Math.round(capacityGb * 1_000_000_000);
    let databaseBytes = 0, tablespaceBytes = 0, walBytes = 0;
    const db = await pool.query('SELECT pg_database_size(current_database())::bigint AS bytes');
    databaseBytes = Number(db.rows[0]?.bytes || 0);
    try {
      const storage = await pool.query(`
        SELECT
          pg_tablespace_size('pg_default')::bigint AS tablespace_bytes,
          COALESCE((SELECT SUM(size)::bigint FROM pg_ls_waldir()),0)::bigint AS wal_bytes
      `);
      tablespaceBytes = Number(storage.rows[0]?.tablespace_bytes || 0);
      walBytes = Number(storage.rows[0]?.wal_bytes || 0);
    } catch (error) {
      console.warn('storage detail query unavailable:', String(error?.message || error));
    }
    const usedBytes = Math.max(databaseBytes, tablespaceBytes + walBytes);
    const percent = capacityBytes > 0 ? Math.min(100, usedBytes / capacityBytes * 100) : 0;
    const level = percent >= 85 ? 'critical' : percent >= 70 ? 'warning' : 'ok';
    const file = await pool.query(`SELECT octet_length(payload::text)::bigint AS bytes,
      (payload::jsonb ? 'products') AS products,
      (payload::jsonb ? 'sales') AS sales,
      (payload::jsonb ? 'purchases') AS purchases,
      (payload::jsonb ? 'reservations') AS reservations,
      (payload::jsonb ? 'kaspiAdExpenses') AS ads,
      (payload::jsonb ? 'movements') AS movements
      FROM warehouse_state WHERE id=1`);
    const parts = await pool.query(`
      SELECT 'products' AS name, count(*)::int AS rows, coalesce(sum(pg_column_size(payload)),0)::bigint AS bytes FROM warehouse_products
      UNION ALL SELECT 'purchases', count(*)::int, coalesce(sum(pg_column_size(payload)),0)::bigint FROM warehouse_purchases
      UNION ALL SELECT 'sales', count(*)::int, coalesce(sum(pg_column_size(payload)),0)::bigint FROM warehouse_sales
      UNION ALL SELECT 'reservations', count(*)::int, coalesce(sum(pg_column_size(payload)),0)::bigint FROM warehouse_reservations
      UNION ALL SELECT 'kaspiAds', count(*)::int, coalesce(sum(pg_column_size(payload)),0)::bigint FROM warehouse_kaspi_ad_expenses
      UNION ALL SELECT 'movements', count(*)::int, coalesce(sum(pg_column_size(payload)),0)::bigint FROM warehouse_movements
    `);
    res.json({ ok:true, usedBytes, databaseBytes, tablespaceBytes, walBytes, capacityBytes, capacityGb, percent, level, checkedAt:Date.now(),
      warehouseFileBytes: Number(file.rows[0]?.bytes || 0),
      warehouseFileStillHas: {
        products: file.rows[0]?.products === true,
        sales: file.rows[0]?.sales === true,
        purchases: file.rows[0]?.purchases === true,
        reservations: file.rows[0]?.reservations === true,
        ads: file.rows[0]?.ads === true,
        movements: file.rows[0]?.movements === true
      },
      warehouseParts: parts.rows.map(row => ({ name: row.name, rows: Number(row.rows), bytes: Number(row.bytes) }))
    });
  } catch (error) { next(error); }
});

app.get('/api/kaspi-sync-status', requireTrustedOrigin, async (_req, res, next) => {
  try {
    const latest = await pool.query("SELECT id,started_at,finished_at,ok,items,error FROM sync_runs WHERE market='Kaspi' ORDER BY id DESC LIMIT 1");
    const success = await pool.query("SELECT MAX(finished_at) AS last_success_at FROM sync_runs WHERE market='Kaspi' AND ok=1");
    const count = await pool.query("SELECT COUNT(*)::bigint AS n FROM marketplace_order_lines WHERE market='Kaspi'");
    res.json({
      ok: true,
      architecture: 'GitHub Pages -> Railway API -> PostgreSQL; marketplace sync: Railway -> marketplace APIs direct',
      directTokenConfigured: Boolean(String(config.kaspiToken || '').trim()),
      latest: latest.rows[0] || null,
      lastSuccessAt: Number(success.rows[0]?.last_success_at || 0) || null,
      orderLines: Number(count.rows[0]?.n || 0),
      serverTime: Date.now()
    });
  } catch (error) { next(error); }
});

app.post('/api/kaspi-sync-now', requireTrustedOrigin, async (req, res, next) => {
  try { res.json(await syncKaspiOrders({ days: Math.max(1, Math.min(14, Number(req.body?.days || 2) || 2)) })); }
  catch (error) { next(error); }
});

app.post('/api/wb-sync-now', requireTrustedOrigin, async (req, res, next) => {
  try {
    const available = await configuredWbConnectionIds();
    const requested = Array.isArray(req.body?.markets) ? req.body.markets : available;
    const markets = [...new Set(requested.map(value => String(value || '').toUpperCase() === 'WB1' ? 'WB' : String(value || '').toUpperCase()).filter(value => available.includes(value)))];
    const results = {};
    for (const market of markets.length ? markets : available) {
      try { results[market] = await syncWbOrders(market, { force: true }); }
      catch (error) { results[market] = { ok: false, market, error: String(error?.message || error) }; }
    }
    const ok = Object.values(results).some(result => result?.ok);
    console.log('WB order sync:', JSON.stringify({ ok, results }));
    res.json({ ok, results });
  } catch (error) { next(error); }
});


// The warehouse is the only source of truth. A stock update is allowed only
// after every linked article has a unique WB characteristic mapping; otherwise
// the function returns diagnostics and writes nothing to WB.
app.post('/api/stock-sync-now', requireTrustedOrigin, async (req, res, next) => {
  try {
    const requested = Array.isArray(req.body?.markets) ? req.body.markets : ['WB', 'WB2'];
    const markets = [...new Set(requested.map(value => String(value || '').toUpperCase() === 'WB1' ? 'WB' : String(value || '').toUpperCase()).filter(value => ['WB', 'WB2'].includes(value)))];
    const results = {};
    for (const market of markets.length ? markets : ['WB', 'WB2']) {
      try { results[market] = await syncWbStockMarket(market, { write: true }); }
      catch (error) { results[market] = { ok: false, market, error: String(error?.message || error) }; }
    }
    const ok = Object.values(results).some(result => result?.ok);
    console.log('WB stock sync:', JSON.stringify({ ok, results }));
    res.json({ ok, results });
  } catch (error) { next(error); }
});

app.use('/api', ozonRouter);
app.use('/api', connectionsRouter);
app.use('/api', wbVariantsRouter);
app.use('/api', wbReturnsRouter);
app.use('/api', wbAdsRouter);
app.use('/api', warehouseRouter);
app.use('/api', financeLedgerRouter);
app.use('/api', financeRouter);
app.use('/api', ordersRouter);
app.use('/api', reportsRouter);
app.use('/api', stockRouter);
app.use('/api', aiAssistantRouter);
// Keep every legacy path used by Kaspi automatic feeds, but serve the XML
// from the live Railway warehouse source instead of a stale migration snapshot.
app.get('/kaspi/price-list.xml', kaspiFeedHandler);
app.get('/kaspi/pricelist.xml', kaspiFeedHandler);
app.get('/kaspi/live-price-list.xml', kaspiFeedHandler);

app.use((req, res) => res.status(404).json({ ok: false, error: 'Not found', path: req.path }));
app.use((error, _req, res, _next) => {
  const status = Number(error?.status || 500);
  const clientAbort=error?.code==='ECONNABORTED'||error?.type==='request.aborted'||status===400&&/aborted/i.test(String(error?.message||''));
  if(!clientAbort)console.error(error);
  res.status(status).json({ ok: false, error: status >= 500 ? 'Internal server error' : String(error.message || error) });
});

async function verifyBackupRestoreReadiness() {
  try {
    const [warehouse, accounts, categories, transactions, imports] = await Promise.all([
      pool.query('SELECT payload,revision FROM warehouse_state WHERE id=1'),
      pool.query('SELECT payload FROM finance_accounts ORDER BY sort_order,id'),
      pool.query('SELECT payload FROM finance_categories ORDER BY sort_order,id'),
      pool.query('SELECT payload FROM finance_transactions ORDER BY sort_order,id'),
      pool.query('SELECT backup_hash,payload FROM finance_imports ORDER BY imported_at,backup_hash')
    ]);
    if (!warehouse.rowCount) return console.warn('BACKUP_RESTORE_DRY_RUN', JSON.stringify({ ok:false, error:'warehouse_state_missing' }));
    const raw = warehouse.rows[0].payload;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const state = await hydrateWarehouseProducts(pool, parsed && typeof parsed === 'object' ? parsed : {});
    const backupState = JSON.parse(JSON.stringify(state || {}));
    backupState.settings ||= {};
    for (const key of ['personalFinanceAccounts','personalFinanceTransactions','personalFinanceCategories','personalFinanceLegacyImports']) delete backupState.settings[key];
    const finance = {
      accounts: accounts.rows.map(row => row.payload),
      categories: categories.rows.map(row => row.payload),
      transactions: transactions.rows.map(row => row.payload),
      imports: Object.fromEntries(imports.rows.map(row => [String(row.backup_hash), row.payload]))
    };
    const encoded = JSON.stringify({ format:'millioner-warehouse-backup',version:6,createdAt:Date.now(),state:backupState,finance });
    const decoded = JSON.parse(encoded);
    const ok = Array.isArray(decoded.state?.products)
      && Array.isArray(decoded.finance?.accounts)
      && Array.isArray(decoded.finance?.categories)
      && Array.isArray(decoded.finance?.transactions)
      && decoded.finance.accounts.length === finance.accounts.length
      && decoded.finance.categories.length === finance.categories.length
      && decoded.finance.transactions.length === finance.transactions.length;
    console.info('BACKUP_RESTORE_DRY_RUN', JSON.stringify({
      ok,
      bytes:Buffer.byteLength(encoded,'utf8'),
      warehouseRevision:Number(warehouse.rows[0].revision||0),
      products:decoded.state?.products?.length||0,
      purchases:decoded.state?.purchases?.length||0,
      accounts:decoded.finance.accounts.length,
      categories:decoded.finance.categories.length,
      transactions:decoded.finance.transactions.length,
      imports:Object.keys(decoded.finance.imports||{}).length
    }));
  } catch (error) {
    console.warn('BACKUP_RESTORE_DRY_RUN', JSON.stringify({ ok:false,error:String(error?.message||error) }));
  }
}

const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`millioner Railway API listening on ${config.port}`);
  setTimeout(()=>verifyBackupRestoreReadiness(),4000).unref();
  startOzonSyncLoop();
  startKaspiSyncLoop();
  startWbSyncLoop();
  startWbAdsLimitLoop();
  let checkingLinks=false;
  const checkLinks=async()=>{
    if(checkingLinks)return;checkingLinks=true;
    try{for(const market of ['WB','WB2']){
      try{const result=await validateWbStockLinks(market);if(Number(result?.detached||0)>0)console.info('WB link validation',JSON.stringify(result));}
      catch(error){console.warn('WB link validation failed',market,String(error.message||error));}
    }}finally{checkingLinks=false;}
  };
  setTimeout(checkLinks,15000).unref();
  setInterval(checkLinks,10*60*1000).unref();
});

async function shutdown(signal) {
  console.log(`received ${signal}, shutting down`);
  server.close(async () => {
    await pool.end().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
