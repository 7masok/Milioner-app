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

async function auditWbExpenseBreakdownOnce() {
  try {
    const now=Date.now();
    const result={};
    for(const market of ['WB','WB2']){
      const periods={};
      for(const [name,from] of [['7d',now-7*86_400_000],['30d',now-30*86_400_000]]){
        const finance=(await pool.query(`
          SELECT COUNT(*)::bigint AS rows,COUNT(DISTINCT report_id)::bigint AS reports,
            COALESCE(SUM(retail_amount),0) AS revenue,COALESCE(SUM(for_pay),0) AS for_pay,
            COALESCE(SUM(acquiring_fee),0) AS acquiring,
            COALESCE(SUM(delivery_service),0) AS delivery,
            COALESCE(SUM(paid_storage),0) AS storage,
            COALESCE(SUM(paid_acceptance),0) AS acceptance,
            COALESCE(SUM(deduction),0) AS deduction,
            COALESCE(SUM(penalty),0) AS penalty,
            COALESCE(SUM(rebill_logistic_cost),0) AS rebill,
            COALESCE(SUM(additional_payment),0) AS additional_payment
          FROM wb_finance_rows WHERE market=$1 AND rr_date >= $2`,[market,from])).rows[0];
        const ads=(await pool.query(`
          SELECT COALESCE(SUM(amount),0) AS advertising
          FROM wb_ad_costs
          WHERE market=$1 AND day >= to_char((to_timestamp($2/1000.0) AT TIME ZONE 'Asia/Almaty')::date,'YYYY-MM-DD')`,
          [market,from])).rows[0];
        periods[name]={...finance,...ads};
      }
      const stale=(await pool.query(`
        WITH mx AS (SELECT MAX(updated_at) AS u FROM wb_finance_rows WHERE market=$1)
        SELECT
          COUNT(*) FILTER(WHERE rr_date >= $2 AND updated_at < (SELECT u FROM mx)-60000)::bigint AS stale_30d,
          COALESCE(SUM(retail_amount) FILTER(WHERE rr_date >= $2 AND updated_at < (SELECT u FROM mx)-60000),0) AS stale_revenue_30d,
          COALESCE(SUM(for_pay) FILTER(WHERE rr_date >= $2 AND updated_at < (SELECT u FROM mx)-60000),0) AS stale_forpay_30d
        FROM wb_finance_rows WHERE market=$1`,[market,now-30*86_400_000])).rows[0];
      const exactDup=(await pool.query(`
        SELECT COUNT(*)::bigint AS groups,COALESCE(SUM(c-1),0)::bigint AS extra
        FROM (SELECT raw_json,COUNT(*) c FROM wb_finance_rows
          WHERE market=$1 AND raw_json<>'' GROUP BY raw_json HAVING COUNT(*)>1)x`,[market])).rows[0];
      const businessDup=(await pool.query(`
        WITH x AS (
          SELECT
            COALESCE(NULLIF(raw_json::jsonb->>'srid',''),'') srid,
            COALESCE(NULLIF(raw_json::jsonb->>'docTypeName',''),NULLIF(raw_json::jsonb->>'doc_type_name',''),doc_type) doc,
            COALESCE(NULLIF(raw_json::jsonb->>'saleDt',''),NULLIF(raw_json::jsonb->>'sale_dt',''),'') sale_dt,
            COALESCE(NULLIF(raw_json::jsonb->>'retailAmount',''),NULLIF(raw_json::jsonb->>'retail_amount',''),retail_amount::text) retail,
            COALESCE(NULLIF(raw_json::jsonb->>'forPay',''),NULLIF(raw_json::jsonb->>'ppvzForPay',''),NULLIF(raw_json::jsonb->>'ppvz_for_pay',''),for_pay::text) pay,
            COUNT(*) c,COUNT(DISTINCT report_id) rc
          FROM wb_finance_rows WHERE market=$1
            AND COALESCE(NULLIF(raw_json::jsonb->>'srid',''),'')<>''
          GROUP BY 1,2,3,4,5 HAVING COUNT(*)>1
        )
        SELECT COUNT(*)::bigint AS groups,COALESCE(SUM(c-1),0)::bigint AS extra,
          COALESCE(SUM(CASE WHEN rc>1 THEN c-1 ELSE 0 END),0)::bigint AS cross_report_extra
        FROM x`,[market])).rows[0];
      const deductionGroups=(await pool.query(`
        SELECT
          COALESCE(NULLIF(raw_json::jsonb->>'sellerOperName',''),
                   NULLIF(raw_json::jsonb->>'supplierOperName',''),
                   NULLIF(raw_json::jsonb->>'supplier_oper_name',''),
                   operation,'') AS operation,
          COALESCE(NULLIF(raw_json::jsonb->>'bonusTypeName',''),
                   NULLIF(raw_json::jsonb->>'bonus_type_name',''),'') AS bonus,
          COUNT(*)::bigint AS rows,
          COALESCE(SUM(deduction),0) AS deduction,
          COALESCE(SUM(penalty),0) AS penalty
        FROM wb_finance_rows
        WHERE market=$1 AND rr_date >= $2 AND (deduction<>0 OR penalty<>0)
        GROUP BY 1,2
        ORDER BY ABS(COALESCE(SUM(deduction),0))+ABS(COALESCE(SUM(penalty),0)) DESC
        LIMIT 30`,[market,now-7*86_400_000])).rows;
      const adGroups=(await pool.query(`
        SELECT payment_type AS "paymentType",COUNT(*)::bigint AS rows,COALESCE(SUM(amount),0) AS amount
        FROM wb_ad_costs
        WHERE market=$1 AND day >= to_char((to_timestamp($2/1000.0) AT TIME ZONE 'Asia/Almaty')::date,'YYYY-MM-DD')
        GROUP BY payment_type ORDER BY SUM(amount) DESC`,[market,now-7*86_400_000])).rows;
      result[market]={periods,stale,exactDup,businessDup,deductionGroups,adGroups};
    }
    const movements=await pool.query(`SELECT COUNT(*)::bigint AS rows,COUNT(DISTINCT id)::bigint AS distinct_ids FROM warehouse_movements`);
    console.info('WB_EXPENSE_AUDIT',JSON.stringify({result,movements:movements.rows[0]}));
  } catch (error) {
    console.warn('WB_EXPENSE_AUDIT_FAILED',String(error?.stack||error));
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
  setTimeout(auditWbExpenseBreakdownOnce, 5000).unref();
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
