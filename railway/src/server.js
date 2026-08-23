import express from 'express';
import helmet from 'helmet';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, assertRuntimeConfig } from './config.js';
import { pool } from './db.js';
import { exactCors, noStore, requireTrustedOrigin } from './http.js';
import { warehouseRouter } from './warehouse.js';
import { ordersRouter } from './orders.js';
import { reportsRouter } from './reports.js';
import { stockRouter, kaspiFeedHandler } from './stock.js';
import { startKaspiSyncLoop, syncKaspiOrders } from './kaspi-sync.js';
import { startWbSyncLoop, syncWbOrders } from './wb-sync.js';
import { authConfig, login, requireAppSession } from './auth.js';
import { configuredWbConnectionIds, connectionsRouter } from './connections.js';
import { wbVariantsRouter } from './wb-variants.js';
import { wbAdsRouter, startWbAdsLimitLoop } from './wb-ads.js';

assertRuntimeConfig();
const app = express();
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const frontendFiles = Object.freeze([
  'cloud-sync-v3.js',
  'wb-variants-v1.js',
  'kaspi-report-v2.js',
  'kaspi-ads-v2.js',
  'save-conflict-v1.js',
  'purchase-delete-v1.js',
  'purchase-plan-ignore-v1.js',
  'kaspi-status-compat-v1.js',
  'kaspi-ads-v2-original.js',
  'reservation-compat-v1.js',
  'stock-alerts-rescue-v1.js',
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
for (const file of frontendFiles) {
  app.get(`/${file}`, (_req, res) => res.sendFile(path.join(repositoryRoot, file)));
}

app.get('/api/auth/config', requireTrustedOrigin, authConfig);
app.post('/api/auth/login', requireTrustedOrigin, login);
app.get('/api/auth/session', requireTrustedOrigin, requireAppSession, (_req,res) => res.json({ ok:true }));
app.use('/api', requireAppSession);

app.get('/health', async (_req, res, next) => {
  try {
    const db = await pool.query('SELECT 1 AS ok');
    const migrations = await pool.query("SELECT to_regclass('public.schema_migrations') AS name");
    res.json({ ok: db.rows[0]?.ok === 1, service: 'millioner-railway-api', postgres: true,
      writesEnabled: config.writesEnabled, marketSyncEnabled: true, migrationsReady: Boolean(migrations.rows[0]?.name) });
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
    res.json({ ok: Object.values(results).some(result => result?.ok), results });
  } catch (error) { next(error); }
});


// Compatibility route for older browser builds. Railway keeps order data
// server-side; an ordinary warehouse save must not trigger an unverified
// external stock write.
app.post('/api/stock-sync-now', requireTrustedOrigin, (req, res) => {
  const requested = Array.isArray(req.body?.markets) ? req.body.markets : ['WB', 'WB2'];
  const markets = [...new Set(requested.map(value => String(value || '').toUpperCase() === 'WB1' ? 'WB' : String(value || '').toUpperCase()).filter(value => ['WB', 'WB2'].includes(value)))];
  res.json({ ok: true, results: Object.fromEntries((markets.length ? markets : ['WB', 'WB2']).map(market => [market, { ok: true, market, skipped: true, reason: 'server-stock-feed' }])) });
});

app.use('/api', connectionsRouter);
app.use('/api', wbVariantsRouter);
app.use('/api', wbAdsRouter);
app.use('/api', warehouseRouter);
app.use('/api', ordersRouter);
app.use('/api', reportsRouter);
app.use('/api', stockRouter);
// Keep every legacy path used by Kaspi automatic feeds, but serve the XML
// from the live Railway warehouse source instead of a stale migration snapshot.
app.get('/kaspi/price-list.xml', kaspiFeedHandler);
app.get('/kaspi/pricelist.xml', kaspiFeedHandler);
app.get('/kaspi/live-price-list.xml', kaspiFeedHandler);

app.use((req, res) => res.status(404).json({ ok: false, error: 'Not found', path: req.path }));
app.use((error, _req, res, _next) => {
  console.error(error);
  const status = Number(error?.status || 500);
  res.status(status).json({ ok: false, error: status >= 500 ? 'Internal server error' : String(error.message || error) });
});

const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`millioner Railway API listening on ${config.port}`);
  startKaspiSyncLoop();
  startWbSyncLoop();
  startWbAdsLimitLoop();
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