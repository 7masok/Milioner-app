import express from 'express';
import helmet from 'helmet';
import { config, assertRuntimeConfig } from './config.js';
import { pool } from './db.js';
import { exactCors, noStore, requireTrustedOrigin } from './http.js';
import { warehouseRouter } from './warehouse.js';
import { ordersRouter } from './orders.js';
import { reportsRouter } from './reports.js';
import { stockRouter, kaspiFeedHandler } from './stock.js';
import { startKaspiSyncLoop, syncKaspiOrders } from './kaspi-sync.js';
import { startWbSyncLoop, syncWbOrders, importWbPayload } from './wb-sync.js';

assertRuntimeConfig();
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(exactCors);
app.use(noStore);
app.use(express.json({ limit: '10mb', strict: true }));

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
      architecture: 'GitHub Pages -> Railway API -> PostgreSQL; Kaspi sync: Railway -> Kaspi API direct; Cloudflare Worker fallback only',
      directTokenConfigured: Boolean(String(config.kaspiToken || '').trim()),
      fallbackWorkerConfigured: Boolean(String(config.kaspiWorkerUrl || '').trim()),
      latest: latest.rows[0] || null,
      lastSuccessAt: Number(success.rows[0]?.last_success_at || 0) || null,
      orderLines: Number(count.rows[0]?.n || 0),
      serverTime: Date.now()
    });
  } catch (error) { next(error); }
});

app.get('/api/wb-sync-status', requireTrustedOrigin, async (_req, res, next) => {
  try {
    const rows = await pool.query(`SELECT market,
      MAX(finished_at) FILTER (WHERE ok=1) AS last_success_at,
      MAX(started_at) AS last_attempt_at
      FROM sync_runs WHERE market IN ('WB','WB2') GROUP BY market ORDER BY market`);
    const latest = await pool.query(`SELECT DISTINCT ON (market) market,id,started_at,finished_at,ok,items,error
      FROM sync_runs WHERE market IN ('WB','WB2') ORDER BY market,id DESC`);
    const newest = await pool.query(`SELECT market,MAX(creation_date) AS newest_order_at,COUNT(*)::bigint AS lines
      FROM marketplace_order_lines WHERE market IN ('WB','WB2') GROUP BY market ORDER BY market`);
    res.json({
      ok: true,
      architecture: 'Railway -> WB Worker -> PostgreSQL; browser fallback -> Railway import if server-to-worker fails',
      worker: String(config.wbWorkerUrl || 'https://wb-sync.7masok.workers.dev'),
      status: rows.rows,
      latest: latest.rows,
      newestOrders: newest.rows,
      serverTime: Date.now()
    });
  } catch (error) { next(error); }
});

app.post('/api/kaspi-sync-now', requireTrustedOrigin, async (req, res, next) => {
  try { res.json(await syncKaspiOrders({ days: Math.max(1, Math.min(14, Number(req.body?.days || 2) || 2)) })); }
  catch (error) { next(error); }
});

app.post('/api/wb-sync-now', requireTrustedOrigin, async (req, res, next) => {
  try { res.json(await syncWbOrders({ days: Math.max(1, Math.min(14, Number(req.body?.days || 2) || 2)) })); }
  catch (error) { next(error); }
});

app.post('/api/wb-sync-import', requireTrustedOrigin, async (req, res, next) => {
  try {
    const payload = req.body?.payload;
    if (!payload || typeof payload !== 'object') return res.status(400).json({ ok: false, error: 'payload is required' });
    res.json(await importWbPayload(payload));
  } catch (error) { next(error); }
});

app.use('/api', warehouseRouter);
app.use('/api', ordersRouter);
app.use('/api', reportsRouter);
app.use('/api', stockRouter);
app.get('/kaspi/price-list.xml', kaspiFeedHandler);

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
