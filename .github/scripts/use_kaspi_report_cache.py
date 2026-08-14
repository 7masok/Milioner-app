from pathlib import Path

p=Path('cloudflare/millioner-api/src/index.js')
s=p.read_text(encoding='utf-8')

start=s.index("      if (url.pathname === '/api/kaspi-report-orders' && request.method === 'GET') {")
end=s.index("      if (url.pathname === '/api/products' && request.method === 'GET') {",start)
route="""      if (url.pathname === '/api/kaspi-report-orders' && request.method === 'GET') {
        const rawDays = Number(url.searchParams.get('days') || 1);
        const rawFrom = Number(url.searchParams.get('from') || 0);
        const rawTo = Number(url.searchParams.get('to') || 0);
        const bounds = kaspiReportPeriodBounds(rawDays, rawFrom, rawTo);
        try {
          const cached = await kaspiReportCacheState(env.DB);
          const stale = !cached.lastRefreshAt || Date.now() - cached.lastRefreshAt > 2 * 60 * 1000;
          const requestedRows = await kaspiReportOrdersFromDb(env.DB, bounds.start, bounds.end);
          if (!requestedRows.length || !cached.lastRefreshAt) {
            await refreshKaspiReportHistory(env, { days: 14 });
          } else if (stale) {
            ctx.waitUntil(refreshKaspiReportHistory(env, { days: 14 }).catch(()=>null));
          }
          const orders = await kaspiReportOrdersFromDb(env.DB, bounds.start, bounds.end);
          const coverage = await kaspiReportCacheState(env.DB);
          const historyComplete = Boolean(coverage.coverageFrom && coverage.coverageFrom <= bounds.start);
          const warnings = [];
          if (!historyComplete && coverage.coverageFrom) warnings.push(`История Kaspi в автоматическом кеше начинается ${new Date(coverage.coverageFrom).toLocaleDateString('ru-RU',{timeZone:'Asia/Almaty'})}. Более старые дни не подменяются приблизительными данными.`);
          return json({
            ok:true,
            days:rawDays,
            from:rawFrom||null,
            to:rawTo||null,
            fetchedAt:Date.now(),
            source:'Kaspi exact completionDate paged cache',
            historyComplete,
            coverageFrom:coverage.coverageFrom||null,
            coverageTo:coverage.coverageTo||null,
            lastRefreshAt:coverage.lastRefreshAt||null,
            warnings,
            orders
          }, 200, cors);
        } catch (e) {
          return json({ ok:false, error:String(e?.message || e) }, 502, cors);
        }
      }

"""
s=s[:start]+route+s[end:]

needle="""    `CREATE TABLE IF NOT EXISTS kaspi_price_feed_access (id INTEGER PRIMARY KEY CHECK(id=1),last_fetched_at INTEGER NOT NULL DEFAULT 0,fetch_count INTEGER NOT NULL DEFAULT 0,last_user_agent TEXT NOT NULL DEFAULT '')`,
"""
insert="""    `CREATE TABLE IF NOT EXISTS kaspi_price_feed_access (id INTEGER PRIMARY KEY CHECK(id=1),last_fetched_at INTEGER NOT NULL DEFAULT 0,fetch_count INTEGER NOT NULL DEFAULT 0,last_user_agent TEXT NOT NULL DEFAULT '')`,
    `CREATE TABLE IF NOT EXISTS kaspi_report_orders (order_id TEXT PRIMARY KEY,code TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT '',state TEXT NOT NULL DEFAULT '',creation_date INTEGER NOT NULL DEFAULT 0,completion_date INTEGER NOT NULL DEFAULT 0,approved_by_bank_date INTEGER NOT NULL DEFAULT 0,total_price REAL NOT NULL DEFAULT 0,delivery_cost_for_seller REAL NOT NULL DEFAULT 0,raw_json TEXT NOT NULL DEFAULT '',updated_at INTEGER NOT NULL DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS kaspi_report_cache_state (id INTEGER PRIMARY KEY CHECK(id=1),last_refresh_at INTEGER NOT NULL DEFAULT 0,last_items INTEGER NOT NULL DEFAULT 0,last_error TEXT NOT NULL DEFAULT '')`,
    `CREATE INDEX IF NOT EXISTS idx_kaspi_report_completion ON kaspi_report_orders(completion_date DESC)`,
"""
if needle not in s:
    raise SystemExit('schema insertion marker missing')
s=s.replace(needle,insert,1)

helper_marker="async function syncAll(env, { scheduled = false } = {}) {"
helpers=r'''function kaspiReportPeriodBounds(days=1, rawFrom=0, rawTo=0){
  const offset=5*60*60*1000;
  if(Number(rawFrom)>0 && Number(rawTo)>Number(rawFrom)) return {start:Number(rawFrom),end:Number(rawTo)};
  const nowLocal=Date.now()+offset;
  const d=new Date(nowLocal);
  const today=Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate())-offset;
  const raw=Number(days);
  if(raw===-1) return {start:today-86400000,end:today};
  const n=Math.max(1,Math.min(3660,raw||1));
  return {start:today-(n-1)*86400000,end:today+86400000};
}

function normalizeKaspiReportOrder(item){
  const a=item?.attributes||{};
  const id=String(item?.id||a?.code||'').trim();
  if(!id)return null;
  return {
    id,
    code:String(a?.code||''),
    status:String(a?.status||''),
    state:String(a?.state||''),
    creationDate:toTimestamp(a?.creationDate),
    completionDate:toTimestamp(a?.completionDate),
    approvedByBankDate:toTimestamp(a?.approvedByBankDate),
    totalPrice:Number(a?.totalPrice||0),
    deliveryCostForSeller:Number(a?.deliveryCostForSeller||0),
    lines:[]
  };
}

async function fetchKaspiReportPage(env,{days=14,batch=0,size=100}={}){
  const base=cleanUrl(env.KASPI_WORKER_URL)||'https://kaspi-worker.internal';
  const q=new URLSearchParams({days:String(Math.max(1,Math.min(14,Number(days)||14))),state:'ARCHIVE',batch:String(Math.max(0,Number(batch)||0)),size:String(Math.max(1,Math.min(100,Number(size)||100)))});
  const req=new Request(`${base}/kaspi/orders?${q.toString()}`,{headers:{Accept:'application/json'}});
  const response=env.KASPI_WORKER?await env.KASPI_WORKER.fetch(req):await fetch(req);
  const data=await safeJson(response,`Kaspi report page ${batch}`);
  if(!response.ok)throw new Error(data?.error||data?.message||`Kaspi Worker HTTP ${response.status}`);
  return {items:Array.isArray(data?.data)?data.data:[],meta:data?.meta||{}};
}

async function refreshKaspiReportHistory(env,{days=14}={}){
  const started=Date.now();
  try{
    const first=await fetchKaspiReportPage(env,{days,batch:0,size:100});
    const pageCount=Math.max(1,Math.min(KASPI_MAX_BATCHES,Number(first?.meta?.pageCount)||1));
    const rest=pageCount>1?await Promise.all(Array.from({length:pageCount-1},(_,i)=>fetchKaspiReportPage(env,{days,batch:i+1,size:100}))):[];
    const all=[...first.items,...rest.flatMap(x=>x.items)];
    const byId=new Map();
    for(const item of all){const o=normalizeKaspiReportOrder(item);if(o?.id&&o.completionDate>0)byId.set(o.id,o)}
    const rows=[...byId.values()];
    const now=Date.now();
    const statements=rows.map(o=>env.DB.prepare(`INSERT INTO kaspi_report_orders(order_id,code,status,state,creation_date,completion_date,approved_by_bank_date,total_price,delivery_cost_for_seller,raw_json,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(order_id) DO UPDATE SET code=excluded.code,status=excluded.status,state=excluded.state,creation_date=excluded.creation_date,completion_date=excluded.completion_date,approved_by_bank_date=excluded.approved_by_bank_date,total_price=excluded.total_price,delivery_cost_for_seller=excluded.delivery_cost_for_seller,raw_json=excluded.raw_json,updated_at=excluded.updated_at`).bind(o.id,o.code,o.status,o.state,o.creationDate,o.completionDate,o.approvedByBankDate,o.totalPrice,o.deliveryCostForSeller,JSON.stringify(o),now));
    for(let i=0;i<statements.length;i+=75)await env.DB.batch(statements.slice(i,i+75));
    await env.DB.prepare(`INSERT INTO kaspi_report_cache_state(id,last_refresh_at,last_items,last_error) VALUES(1,?,?, '') ON CONFLICT(id) DO UPDATE SET last_refresh_at=excluded.last_refresh_at,last_items=excluded.last_items,last_error=''`).bind(now,rows.length).run();
    return {ok:true,items:rows.length,pages:pageCount,startedAt:started,finishedAt:Date.now()};
  }catch(e){
    await env.DB.prepare(`INSERT INTO kaspi_report_cache_state(id,last_refresh_at,last_items,last_error) VALUES(1,0,0,?) ON CONFLICT(id) DO UPDATE SET last_error=excluded.last_error`).bind(String(e?.message||e)).run();
    throw e;
  }
}

async function kaspiReportCacheState(db){
  const state=await db.prepare(`SELECT last_refresh_at AS lastRefreshAt,last_items AS lastItems,last_error AS lastError FROM kaspi_report_cache_state WHERE id=1`).first();
  const coverage=await db.prepare(`SELECT MIN(completion_date) AS coverageFrom,MAX(completion_date) AS coverageTo,COUNT(*) AS rows FROM kaspi_report_orders WHERE completion_date>0`).first();
  return {lastRefreshAt:Number(state?.lastRefreshAt||0),lastItems:Number(state?.lastItems||0),lastError:String(state?.lastError||''),coverageFrom:Number(coverage?.coverageFrom||0),coverageTo:Number(coverage?.coverageTo||0),rows:Number(coverage?.rows||0)};
}

async function kaspiReportOrdersFromDb(db,start,end){
  const rows=await db.prepare(`SELECT order_id AS id,code,status,state,creation_date AS creationDate,completion_date AS completionDate,approved_by_bank_date AS approvedByBankDate,total_price AS totalPrice,delivery_cost_for_seller AS deliveryCostForSeller FROM kaspi_report_orders WHERE completion_date>=? AND completion_date<? ORDER BY completion_date ASC`).bind(Number(start)||0,Number(end)||Date.now()+86400000).all();
  return (rows.results||[]).map(x=>({...x,lines:[]}));
}

'''
if helper_marker not in s:
    raise SystemExit('helper insertion marker missing')
s=s.replace(helper_marker,helpers+helper_marker,1)

sched="""      await ensureSchema(env.DB);
      const orders = await syncAll(env, { scheduled: true });
"""
sched_new="""      await ensureSchema(env.DB);
      let kaspiReport = null;
      try { kaspiReport = await refreshKaspiReportHistory(env, { days: 14 }); }
      catch (e) { kaspiReport = { ok:false, error:String(e?.message||e) }; }
      const orders = await syncAll(env, { scheduled: true });
"""
if sched not in s:
    raise SystemExit('scheduled insertion marker missing')
s=s.replace(sched,sched_new,1)

p.write_text(s,encoding='utf-8')
print('patched exact paged Kaspi report cache')
