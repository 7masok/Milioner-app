from pathlib import Path

worker=Path('cloudflare/millioner-api/src/index.js')
s=worker.read_text(encoding='utf-8')

# Add persistent return-event storage next to the exact Kaspi report cache.
state_stmt="    `CREATE TABLE IF NOT EXISTS kaspi_report_cache_state (id INTEGER PRIMARY KEY CHECK(id=1),last_refresh_at INTEGER NOT NULL DEFAULT 0,last_items INTEGER NOT NULL DEFAULT 0,last_error TEXT NOT NULL DEFAULT '')`,\n"
return_schema="""    `CREATE TABLE IF NOT EXISTS kaspi_report_cache_state (id INTEGER PRIMARY KEY CHECK(id=1),last_refresh_at INTEGER NOT NULL DEFAULT 0,last_items INTEGER NOT NULL DEFAULT 0,last_error TEXT NOT NULL DEFAULT '')`,
    `CREATE TABLE IF NOT EXISTS kaspi_report_returns (order_id TEXT PRIMARY KEY,code TEXT NOT NULL DEFAULT '',amount REAL NOT NULL DEFAULT 0,return_date INTEGER NOT NULL DEFAULT 0,original_completion_date INTEGER NOT NULL DEFAULT 0,detected_at INTEGER NOT NULL DEFAULT 0,date_source TEXT NOT NULL DEFAULT '')`,
    `CREATE INDEX IF NOT EXISTS idx_kaspi_report_return_date ON kaspi_report_returns(return_date DESC)`,
"""
if 'CREATE TABLE IF NOT EXISTS kaspi_report_returns' not in s:
    if state_stmt not in s: raise SystemExit('Kaspi report cache schema marker missing')
    s=s.replace(state_stmt,return_schema,1)

# Replace refresh so RETURNED orders are persisted as financial return events.
start=s.index('async function refreshKaspiReportHistory(env,{days=14}={}){')
end=s.index('\nasync function kaspiReportCacheState(db){',start)
refresh=r'''async function refreshKaspiReportHistory(env,{days=14}={}){
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

    // Kaspi keeps the original completionDate when an old completed order is later returned.
    // Store the first moment we observe RETURNED as a separate financial event so rolling
    // reports can subtract it from the period in which the return happened.
    for(const o of rows){
      if(String(o.status||'').toUpperCase()!=='RETURNED')continue;
      // This return predates return-event tracking. The supplied Kaspi reports prove it was
      // absent on 13 Aug and present in the report through 14 Aug, so backfill it to 14 Aug.
      const historical=o.code==='1008824537';
      const returnDate=historical?1786647600000:now; // 2026-08-14 00:00 Asia/Almaty for the known legacy return
      const source=historical?'kaspi_pdf_backfill_2026-08-14':'status_transition_observed';
      await env.DB.prepare(`INSERT INTO kaspi_report_returns(order_id,code,amount,return_date,original_completion_date,detected_at,date_source) VALUES(?,?,?,?,?,?,?) ON CONFLICT(order_id) DO UPDATE SET code=excluded.code,amount=excluded.amount,original_completion_date=excluded.original_completion_date,detected_at=excluded.detected_at`).bind(o.id,o.code,Math.abs(Number(o.totalPrice)||0),returnDate,o.completionDate,now,source).run();
    }

    await env.DB.prepare(`INSERT INTO kaspi_report_cache_state(id,last_refresh_at,last_items,last_error) VALUES(1,?,?, '') ON CONFLICT(id) DO UPDATE SET last_refresh_at=excluded.last_refresh_at,last_items=excluded.last_items,last_error=''`).bind(now,rows.length).run();
    return {ok:true,items:rows.length,pages:pageCount,startedAt:started,finishedAt:Date.now()};
  }catch(e){
    await env.DB.prepare(`INSERT INTO kaspi_report_cache_state(id,last_refresh_at,last_items,last_error) VALUES(1,0,0,?) ON CONFLICT(id) DO UPDATE SET last_error=excluded.last_error`).bind(String(e?.message||e)).run();
    throw e;
  }
}
'''
s=s[:start]+refresh+s[end:]

# Add return query helper.
orders_helper='''async function kaspiReportOrdersFromDb(db,start,end){
  const rows=await db.prepare(`SELECT order_id AS id,code,status,state,creation_date AS creationDate,completion_date AS completionDate,approved_by_bank_date AS approvedByBankDate,total_price AS totalPrice,delivery_cost_for_seller AS deliveryCostForSeller FROM kaspi_report_orders WHERE completion_date>=? AND completion_date<? ORDER BY completion_date ASC`).bind(Number(start)||0,Number(end)||Date.now()+86400000).all();
  return (rows.results||[]).map(x=>({...x,lines:[]}));
}
'''
returns_helper=orders_helper+'''\nasync function kaspiReportReturnsFromDb(db,start,end){
  const rows=await db.prepare(`SELECT order_id AS id,code,amount,return_date AS returnDate,original_completion_date AS originalCompletionDate,detected_at AS detectedAt,date_source AS dateSource FROM kaspi_report_returns WHERE return_date>=? AND return_date<? ORDER BY return_date ASC`).bind(Number(start)||0,Number(end)||Date.now()+86400000).all();
  return rows.results||[];
}
'''
if 'async function kaspiReportReturnsFromDb' not in s:
    if orders_helper not in s: raise SystemExit('Kaspi report DB helper marker missing')
    s=s.replace(orders_helper,returns_helper,1)

# Return both completed sales and financial return events from the same period endpoint.
route_old='''          const orders = await kaspiReportOrdersFromDb(env.DB, bounds.start, bounds.end);
          const coverage = await kaspiReportCacheState(env.DB);'''
route_new='''          const orders = await kaspiReportOrdersFromDb(env.DB, bounds.start, bounds.end);
          const returns = await kaspiReportReturnsFromDb(env.DB, bounds.start, bounds.end);
          const coverage = await kaspiReportCacheState(env.DB);'''
if route_old in s:
    s=s.replace(route_old,route_new,1)
elif route_new not in s:
    raise SystemExit('Kaspi report route query marker missing')

json_old='''            warnings,
            orders
          }, 200, cors);'''
json_new='''            warnings,
            orders,
            returns
          }, 200, cors);'''
if json_old in s:
    s=s.replace(json_old,json_new,1)
elif json_new not in s:
    raise SystemExit('Kaspi report route response marker missing')

worker.write_text(s,encoding='utf-8')

# Frontend: include return events in the same unified period model.
front=Path('kaspi-report-v2.js')
f=front.read_text(encoding='utf-8')
old="const snap={orders,source:data.source||'',warnings:data.warnings||[],fetchedAt:Number(data.fetchedAt)||Date.now()};"
new="const snap={orders,returns:Array.isArray(data.returns)?data.returns:[],source:data.source||'',warnings:data.warnings||[],fetchedAt:Number(data.fetchedAt)||Date.now()};"
if old in f:f=f.replace(old,new,1)
elif new not in f:raise SystemExit('frontend snapshot marker missing')

old="x.unknownCost=x.unknownCost||!!patch.unknownCost;x.unknownOrders+=Number(patch.unknownOrders)||0;return x}"
new="x.unknownCost=x.unknownCost||!!patch.unknownCost;x.unknownOrders+=Number(patch.unknownOrders)||0;x.isReturn=x.isReturn||!!patch.isReturn;return x}"
if old in f:f=f.replace(old,new,1)
elif new not in f:raise SystemExit('frontend addRow marker missing')

# Insert returns before advertising so headline revenue is net of returns.
marker=" const ads=kaspiAdsBreakdown(days);"
retblock=""" for(const r of(snapshot.returns||[])){const amount=Math.abs(Number(r.amount)||0);if(!amount)continue;addRow(map,'__return__:'+String(r.id||r.code||r.returnDate||''),{name:'Возврат Kaspi'+(r.code?' · '+String(r.code):''),qty:-1,revenue:-amount,cost:0,deliveryExplicit:0,unknownCost:true,unknownOrders:1,isReturn:true})}
 const ads=kaspiAdsBreakdown(days);"""
if retblock not in f:
    if marker not in f:raise SystemExit('frontend ads insertion marker missing')
    f=f.replace(marker,retblock,1)

old="const pct=rateForName(x.name),commission=x.revenue*pct/100,kaspiPay=x.revenue*.0095,delivery=x.deliveryExplicit>0?x.deliveryExplicit:(x.revenue>0?Math.max(1,x.qty||x.unknownOrders||1)*57:0),otherFees=x.revenue*.0008,fees=commission+kaspiPay+delivery+otherFees,profit=x.revenue-x.cost-fees-x.ads;"
new="const pct=rateForName(x.name),commission=x.revenue*pct/100,kaspiPay=x.revenue*.0095,delivery=x.isReturn?0:(x.deliveryExplicit>0?x.deliveryExplicit:(x.revenue>0?Math.max(1,x.qty||x.unknownOrders||1)*57:0)),otherFees=x.isReturn?0:x.revenue*.0008,fees=commission+kaspiPay+delivery+otherFees,profit=x.revenue-x.cost-fees-x.ads;"
if old in f:f=f.replace(old,new,1)
elif new not in f:raise SystemExit('frontend fee marker missing')

old="if(x.unknownCost&&x.revenue>0){a.unknownRevenue+=x.revenue;a.unknownOrders+=Math.max(1,Number(x.unknownOrders)||0)}"
new="if(x.unknownCost&&x.revenue!==0){a.unknownRevenue+=Math.abs(x.revenue);a.unknownOrders+=Math.max(1,Number(x.unknownOrders)||0)}"
if old in f:f=f.replace(old,new,1)
elif new not in f:raise SystemExit('frontend unknown marker missing')

# Fallback snapshots must have an explicit empty returns list.
f=f.replace("return buildModel({orders,source:'D1 cache'},days)","return buildModel({orders,returns:[],source:'D1 cache'},days)")
front.write_text(f,encoding='utf-8')

# Cache-bust the report script on GitHub Pages.
idx=Path('index.html')
i=idx.read_text(encoding='utf-8')
i=i.replace('./kaspi-report-v2.js?v=20260814g','./kaspi-report-v2.js?v=20260814h')
idx.write_text(i,encoding='utf-8')

print('Kaspi return-event accounting patched')
