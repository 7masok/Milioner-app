import express from 'express';
import helmet from 'helmet';
import { config, assertRuntimeConfig } from './config.js';
import { pool } from './db.js';
import { exactCors, noStore } from './http.js';
import { warehouseRouter } from './warehouse.js';
import { reportsRouter } from './reports.js';
import { stockRouter, kaspiFeedHandler } from './stock.js';

assertRuntimeConfig();
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(exactCors);
app.use(noStore);
app.use(express.json({ limit: '7mb', strict: true }));

app.get('/health', async (_req, res, next) => {
  try {
    const db = await pool.query('SELECT 1 AS ok');
    const migrations = await pool.query("SELECT to_regclass('public.schema_migrations') AS name");
    res.json({ ok: db.rows[0]?.ok === 1, service: 'millioner-railway-api', postgres: true,
      writesEnabled: config.writesEnabled, marketSyncEnabled: config.marketSyncEnabled, migrationsReady: Boolean(migrations.rows[0]?.name) });
  } catch (error) { next(error); }
});

app.use('/api', warehouseRouter);
app.use('/api', reportsRouter);
app.use('/api', stockRouter);
app.get('/kaspi/price-list.xml', kaspiFeedHandler);

app.use((req, res) => res.status(404).json({ ok: false, error: 'Not found', path: req.path }));
app.use((error, _req, res, _next) => {
  console.error(error);
  const status = Number(error?.status || 500);
  res.status(status).json({ ok: false, error: status >= 500 ? 'Internal server error' : String(error.message || error) });
});

const server = app.listen(config.port, '0.0.0.0', () => console.log(`millioner Railway API listening on ${config.port}`));

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

