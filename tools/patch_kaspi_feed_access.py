from pathlib import Path

html_path=Path('index.html')
api_path=Path('cloudflare/millioner-api/src/index.js')
html=html_path.read_text(encoding='utf-8')
api=api_path.read_text(encoding='utf-8')

if 'Последнее обращение Kaspi к XML' in html and 'kaspi_price_feed_access' in api:
    raise SystemExit('Patch already applied')

route_old="""      if (url.pathname === '/api/kaspi-stock-feed-status' && request.method === 'GET') {
        if (!isTrustedBrowserOrigin(origin, env)) return json({ ok: false, error: 'Forbidden origin' }, 403, cors);
        const status = await getKaspiStockFeedStatus(env, request.url);
        return json({ ok: true, feature: 'kaspi-xml-stock-v1', ...status }, 200, cors);
      }
"""
route_new="""      if (url.pathname === '/api/kaspi-stock-feed-status' && request.method === 'GET') {
        if (!isTrustedBrowserOrigin(origin, env)) return json({ ok: false, error: 'Forbidden origin' }, 403, cors);
        const status = await getKaspiStockFeedStatus(env, request.url);
        return json({ ok: true, feature: 'kaspi-xml-stock-v1', fetchTracking: 'kaspi-xml-access-v1', ...status }, 200, cors);
      }
"""
if route_old not in api:
    raise SystemExit('Kaspi status route anchor not found')
api=api.replace(route_old,route_new,1)

feed_old="""      if (url.pathname === '/kaspi/price-list.xml' && request.method === 'GET') {
        const built = await buildKaspiPriceListXml(env, url);
        return new Response(built.xml, { status: 200, headers: {
"""
feed_new="""      if (url.pathname === '/kaspi/price-list.xml' && request.method === 'GET') {
        const built = await buildKaspiPriceListXml(env, url);
        if (url.searchParams.get('check') !== '1') await recordKaspiPriceFeedFetch(env.DB, request);
        return new Response(built.xml, { status: 200, headers: {
"""
if feed_old not in api:
    raise SystemExit('Kaspi feed route anchor not found')
api=api.replace(feed_old,feed_new,1)

table_anchor="""    `CREATE TABLE IF NOT EXISTS kaspi_price_template (id INTEGER PRIMARY KEY CHECK(id=1),raw_xml TEXT NOT NULL DEFAULT '',feed_key TEXT NOT NULL DEFAULT '',primary_store_id TEXT NOT NULL DEFAULT '',offer_count INTEGER NOT NULL DEFAULT 0,store_ids TEXT NOT NULL DEFAULT '[]',merchant_id TEXT NOT NULL DEFAULT '',updated_at INTEGER NOT NULL DEFAULT 0)`,
"""
if table_anchor not in api:
    raise SystemExit('Kaspi template table anchor not found')
api=api.replace(table_anchor,table_anchor+"    `CREATE TABLE IF NOT EXISTS kaspi_price_feed_access (id INTEGER PRIMARY KEY CHECK(id=1),last_fetched_at INTEGER NOT NULL DEFAULT 0,fetch_count INTEGER NOT NULL DEFAULT 0,last_user_agent TEXT NOT NULL DEFAULT '')`,\n",1)

func_anchor="""async function readKaspiTemplateRow(db) {
  return await db.prepare('SELECT raw_xml AS rawXml,feed_key AS feedKey,primary_store_id AS primaryStoreId,offer_count AS offerCount,store_ids AS storeIds,merchant_id AS merchantId,updated_at AS updatedAt FROM kaspi_price_template WHERE id=1').first();
}

"""
if func_anchor not in api:
    raise SystemExit('readKaspiTemplateRow anchor not found')
func_add="""async function readKaspiTemplateRow(db) {
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

"""
api=api.replace(func_anchor,func_add,1)

status_anchor="""async function getKaspiStockFeedStatus(env, requestUrl) {
  const row = await readKaspiTemplateRow(env.DB);
"""
status_new="""async function getKaspiStockFeedStatus(env, requestUrl) {
  const row = await readKaspiTemplateRow(env.DB);
  const accessFields = kaspiFeedAccessFields(await readKaspiPriceFeedAccess(env.DB));
"""
if status_anchor not in api:
    raise SystemExit('Kaspi status function anchor not found')
api=api.replace(status_anchor,status_new,1)

repls={
"if (!row?.rawXml) return { configured:false, ready:false, feedUrl:'', offerCount:0, storeIds:[], primaryStoreId:'', linked:0, matched:0, missingSkus:[], missingPrimaryStore:[] };":"if (!row?.rawXml) return { configured:false, ready:false, feedUrl:'', offerCount:0, storeIds:[], primaryStoreId:'', linked:0, matched:0, missingSkus:[], missingPrimaryStore:[], ...accessFields };",
"catch (e) { return { configured:true, ready:false, error:String(e?.message || e), feedUrl:'', offerCount:Number(row.offerCount || 0), storeIds:[], primaryStoreId:String(row.primaryStoreId || ''), linked:0, matched:0, missingSkus:[], missingPrimaryStore:[] }; }":"catch (e) { return { configured:true, ready:false, error:String(e?.message || e), feedUrl:'', offerCount:Number(row.offerCount || 0), storeIds:[], primaryStoreId:String(row.primaryStoreId || ''), linked:0, matched:0, missingSkus:[], missingPrimaryStore:[], ...accessFields }; }",
"catch (e) { return { configured:true, ready:false, error:String(e?.message || e), feedUrl:kaspiFeedUrl(requestUrl,row.feedKey), offerCount:info.offerSkus.size, storeIds:info.storeIds, primaryStoreId:String(row.primaryStoreId || ''), linked:0, matched:0, missingSkus:[], missingPrimaryStore:[] }; }":"catch (e) { return { configured:true, ready:false, error:String(e?.message || e), feedUrl:kaspiFeedUrl(requestUrl,row.feedKey), offerCount:info.offerSkus.size, storeIds:info.storeIds, primaryStoreId:String(row.primaryStoreId || ''), linked:0, matched:0, missingSkus:[], missingPrimaryStore:[], ...accessFields }; }",
"multiStoreMode:info.storeIds.length > 1 ? 'primary-store-only-for-managed-skus' : 'single-store'":"multiStoreMode:info.storeIds.length > 1 ? 'primary-store-only-for-managed-skus' : 'single-store', ...accessFields"
}
for old,new in repls.items():
    if old not in api:
        raise SystemExit('Kaspi status return anchor not found: '+old[:70])
    api=api.replace(old,new,1)

ui_anchor="""  const missingStore = Array.isArray(status.missingPrimaryStore) ? status.missingPrimaryStore : [];
  const summary = status.configured ? `"""
if ui_anchor not in html:
    raise SystemExit('Kaspi UI anchor not found')
ui_new="""  const missingStore = Array.isArray(status.missingPrimaryStore) ? status.missingPrimaryStore : [];
  const fetchedAt = Number(status.lastFetchedAt||0);
  const fetchInfo = status.configured ? `<div class=\"link-note\">Последнее обращение Kaspi к XML: <b>${fetchedAt?new Date(fetchedAt).toLocaleString('ru-RU'):'ещё не было'}</b>${Number(status.fetchCount||0)?` · загрузок: ${Number(status.fetchCount||0)}`:''}</div>` : '';
  const summary = status.configured ? `"""
html=html.replace(ui_anchor,ui_new,1)

sheet_old="""showSheet(`<h3>Остатки Kaspi</h3>${summary}${storeControl}"""
sheet_new="""showSheet(`<h3>Остатки Kaspi</h3>${summary}${fetchInfo}${storeControl}"""
if sheet_old not in html:
    raise SystemExit('Kaspi showSheet anchor not found')
html=html.replace(sheet_old,sheet_new,1)

html_path.write_text(html,encoding='utf-8')
api_path.write_text(api,encoding='utf-8')
