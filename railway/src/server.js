import { ozonRouter, startOzonSyncLoop } from './ozon-fbo.js';
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
import { syncWbStockMarket, validateWbStockLinks } from './wb-stock-sync.js';
import { authConfig, login, requireAppSession } from './auth.js';
import { configuredWbConnectionIds, connectionsRouter } from './connections.js';
import { wbVariantsRouter } from './wb-variants.js';
import { wbAdsRouter, startWbAdsLimitLoop } from './wb-ads.js';
import { aiAssistantRouter } from './ai-assistant.js';

assertRuntimeConfig();
const app = express();
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const frontendFiles = Object.freeze([
  'ozon-fbo-v1.js',
  'ozon-supplies-v1.js',
  'warehouse-insights.js',
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
      ok:true,
      configured:Boolean(config.kaspiToken),
      latestRun:latest.rows[0]||null,
      lastSuccessAt:Number(success.rows[0]?.last_success_at||0)||0,
      orderLines:Number(count.rows[0]?.n||0)||0
    });
  } catch (error) { next(error); }
});

app.use('/api', warehouseRouter);
app.use('/api', ordersRouter);
app.use('/api', reportsRouter);
app.use('/api', stockRouter);
app.use('/api', connectionsRouter);
app.use('/api', wbVariantsRouter);
app.use('/api', wbAdsRouter);
app.use('/api', aiAssistantRouter);
app.use('/api', ozonRouter);

app.use((error, _req, res, _next) => {
  const status = Number(error?.status)||500;
  const message = status >= 500 ? 'Внутренняя ошибка сервера' : String(error?.message||'Ошибка');
  if (status >= 500) console.error(error);
  res.status(status).json({ ok:false, error:message });
});

const server=app.listen(config.port, () => {
  console.log(`millioner Railway API listening on ${config.port}`);
});

if(config.marketSyncEnabled){
  startKaspiSyncLoop();
  startWbSyncLoop();
  startWbAdsLimitLoop();
  startOzonSyncLoop();
  setTimeout(()=>syncWbStockMarket().catch(error=>console.error('WB stock sync failed',error)),10000).unref();
  setTimeout(()=>validateWbStockLinks().catch(error=>console.error('WB link validation failed',error)),15000).unref();
  setInterval(()=>syncWbStockMarket().catch(error=>console.error('WB stock sync failed',error)),5*60*1000).unref();
  setInterval(()=>validateWbStockLinks().catch(error=>console.error('WB link validation failed',error)),30*60*1000).unref();
}

process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
process.on('SIGINT',()=>server.close(()=>process.exit(0)));
