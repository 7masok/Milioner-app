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

const WB_AUDIT_ALMATY_OFFSET_MS = 5 * 60 * 60 * 1000;
function wbAuditBounds(days) {
  const local = new Date(Date.now() + WB_AUDIT_ALMATY_OFFSET_MS);
  const today = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - WB_AUDIT_ALMATY_OFFSET_MS;
  if (days === -1) return { since: today - 86_400_000, until: today };
  return { since: today - (days - 1) * 86_400_000, until: today + 86_400_000 };
}
function wbAuditDayKey(timestamp) {
  return new Date(timestamp + WB_AUDIT_ALMATY_OFFSET_MS).toISOString().slice(0, 10);
}
async function auditWbReportData() {
  try {
    const markets = await configuredWbConnectionIds();
    for (const market of markets) {
      const integrity = await pool.query(`SELECT COUNT(*)::bigint AS rows,
        COALESCE(SUM(ABS(retail_amount - COALESCE(NULLIF(raw_json::jsonb->>'retailAmount','')::double precision,NULLIF(raw_json::jsonb->>'retail_amount','')::double precision,0))),0) AS retail_diff,
        COALESCE(SUM(ABS(for_pay - COALESCE(NULLIF(raw_json::jsonb->>'forPay','')::double precision,NULLIF(raw_json::jsonb->>'ppvzForPay','')::double precision,NULLIF(raw_json::jsonb->>'ppvz_for_pay','')::double precision,0))),0) AS for_pay_diff,
        COALESCE(SUM(ABS(acquiring_fee - COALESCE(NULLIF(raw_json::jsonb->>'acquiringFee','')::double precision,NULLIF(raw_json::jsonb->>'acquiring_fee','')::double precision,0))),0) AS acquiring_diff,
        COALESCE(SUM(ABS(delivery_service - COALESCE(NULLIF(raw_json::jsonb->>'deliveryService','')::double precision,NULLIF(raw_json::jsonb->>'deliveryRub','')::double precision,NULLIF(raw_json::jsonb->>'delivery_rub','')::double precision,0))),0) AS delivery_diff,
        COALESCE(SUM(ABS(paid_storage - COALESCE(NULLIF(raw_json::jsonb->>'paidStorage','')::double precision,NULLIF(raw_json::jsonb->>'storageFee','')::double precision,NULLIF(raw_json::jsonb->>'storage_fee','')::double precision,0))),0) AS storage_diff,
        COALESCE(SUM(ABS(paid_acceptance - COALESCE(NULLIF(raw_json::jsonb->>'paidAcceptance','')::double precision,NULLIF(raw_json::jsonb->>'acceptance','')::double precision,NULLIF(raw_json::jsonb->>'acceptanceFee','')::double precision,NULLIF(raw_json::jsonb->>'acceptance_fee','')::double precision,0))),0) AS acceptance_diff
        FROM wb_finance_rows WHERE market=$1 AND rr_date >= $2`, [market, Date.now() - 45 * 86_400_000]);
      const sourceDiff = integrity.rows[0] || {};
      const differences = ['retail_diff','for_pay_diff','acquiring_diff','delivery_diff','storage_diff','acceptance_diff']
        .map(key => Math.abs(Number(sourceDiff[key] || 0)));
      const periods = {};
      for (const days of [1, -1, 7, 30]) {
        const { since, until } = wbAuditBounds(days);
        const [finance, ads] = await Promise.all([
          pool.query(`SELECT COUNT(*)::bigint AS rows,
            COALESCE(SUM(retail_amount),0) AS revenue,COALESCE(SUM(for_pay),0) AS for_pay,
            COALESCE(SUM(acquiring_fee),0) AS acquiring,COALESCE(SUM(delivery_service),0) AS delivery,
            COALESCE(SUM(paid_storage),0) AS storage,COALESCE(SUM(paid_acceptance),0) AS acceptance,
            COALESCE(SUM(deduction),0) AS deduction,COALESCE(SUM(penalty),0) AS penalty,
            COALESCE(SUM(additional_payment),0) AS additional_payment,
            COALESCE(SUM(rebill_logistic_cost),0) AS rebill
            FROM wb_finance_rows WHERE market=$1 AND rr_date >= $2 AND rr_date < $3`, [market, since, until]),
          pool.query('SELECT COALESCE(SUM(amount),0) AS advertising FROM wb_ad_costs WHERE market=$1 AND day >= $2 AND day <= $3',
            [market, wbAuditDayKey(since), wbAuditDayKey(until - 1)])
        ]);
        const row = finance.rows[0] || {};
        const revenue = Number(row.revenue || 0), forPay = Number(row.for_pay || 0);
        const charges = ['acquiring','delivery','storage','acceptance','deduction','penalty','rebill']
          .reduce((sum,key)=>sum+Number(row[key]||0),0);
        const advertising = Number(ads.rows[0]?.advertising || 0);
        periods[String(days)] = {
          rows: Number(row.rows || 0), revenue, forPay, charges,
          additionalPayment: Number(row.additional_payment || 0), advertising,
          netBeforeCost: forPay + Number(row.additional_payment || 0) - charges - advertising
        };
      }
      const latest = await pool.query(`SELECT started_at AS "startedAt",finished_at AS "finishedAt",finance_ok AS "financeOk",
        promotion_ok AS "promotionOk",finance_items AS "financeItems",ad_items AS "adItems",error
        FROM wb_finance_sync_runs WHERE market=$1 ORDER BY id DESC LIMIT 1`, [market]);
      console.info('WB report audit', JSON.stringify({
        market,
        sourceRows: Number(sourceDiff.rows || 0),
        rawToStoredIntegrity: differences.every(value => value < 0.01),
        rawToStoredDifferences: {
          retailAmount: Number(sourceDiff.retail_diff || 0),
          forPay: Number(sourceDiff.for_pay_diff || 0),
          acquiring: Number(sourceDiff.acquiring_diff || 0),
          delivery: Number(sourceDiff.delivery_diff || 0),
          storage: Number(sourceDiff.storage_diff || 0),
          acceptance: Number(sourceDiff.acceptance_diff || 0)
        },
        maxRawToStoredDifference: differences.length ? Math.max(...differences) : 0,
        periods,
        latestSync: latest.rows[0] || null
      }));
    }
  } catch (error) {
    console.warn('WB report audit failed', String(error?.message || error));
  }
}

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
app.use('/api', wbAdsRouter);
app.use('/api', warehouseRouter);
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
  console.error(error);
  const status = Number(error?.status || 500);
  res.status(status).json({ ok: false, error: status >= 500 ? 'Internal server error' : String(error.message || error) });
});

const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`millioner Railway API listening on ${config.port}`);
  startOzonSyncLoop();
  startKaspiSyncLoop();
  startWbSyncLoop();
  startWbAdsLimitLoop();
  setTimeout(auditWbReportData, 8000).unref();
  let checkingLinks=false;
  const checkLinks=async()=>{
    if(checkingLinks)return;checkingLinks=true;
    try{for(const market of ['WB','WB2']){
      try{const result=await validateWbStockLinks(market);console.info('WB link validation',JSON.stringify(result));}
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
