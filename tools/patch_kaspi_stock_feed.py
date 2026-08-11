from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 occurrence, found {count}')
    return text.replace(old, new, 1)

worker_path = Path('cloudflare/millioner-api/src/index.js')
index_path = Path('index.html')
worker = worker_path.read_text(encoding='utf-8')
html = index_path.read_text(encoding='utf-8')

# --- Worker routes ---
route_anchor = """      if (url.pathname === '/api/stock-sync-preview' && request.method === 'GET') {
"""
route_block = """      if (url.pathname === '/api/kaspi-stock-feed-status' && request.method === 'GET') {
        if (!isTrustedBrowserOrigin(origin, env)) return json({ ok: false, error: 'Forbidden origin' }, 403, cors);
        const status = await getKaspiStockFeedStatus(env, request.url);
        return json({ ok: true, feature: 'kaspi-xml-stock-v1', ...status }, 200, cors);
      }

      if (url.pathname === '/api/kaspi-price-template' && request.method === 'PUT') {
        if (!isTrustedBrowserOrigin(origin, env)) return json({ ok: false, error: 'Forbidden origin' }, 403, cors);
        const body = await request.json();
        const status = await saveKaspiPriceTemplate(env, body, request.url);
        return json({ ok: true, feature: 'kaspi-xml-stock-v1', ...status }, 200, cors);
      }

      if (url.pathname === '/kaspi/price-list.xml' && request.method === 'GET') {
        const built = await buildKaspiPriceListXml(env, url);
        return new Response(built.xml, { status: 200, headers: {
          'Content-Type': 'application/xml; charset=utf-8',
          'Cache-Control': 'no-store, max-age=0',
          'X-Robots-Tag': 'noindex, nofollow'
        }});
      }

""" + route_anchor
worker = replace_once(worker, route_anchor, route_block, 'Kaspi stock routes')

# --- D1 schema ---
schema_anchor = """    `CREATE TABLE IF NOT EXISTS wb_stock_state (market TEXT PRIMARY KEY,warehouse_id TEXT NOT NULL DEFAULT '',payload_hash TEXT NOT NULL DEFAULT '',last_sent_at INTEGER NOT NULL DEFAULT 0,last_items INTEGER NOT NULL DEFAULT 0,last_error TEXT NOT NULL DEFAULT '',updated_at INTEGER NOT NULL DEFAULT 0)`,
"""
schema_block = schema_anchor + """    `CREATE TABLE IF NOT EXISTS kaspi_price_template (id INTEGER PRIMARY KEY CHECK(id=1),raw_xml TEXT NOT NULL DEFAULT '',feed_key TEXT NOT NULL DEFAULT '',primary_store_id TEXT NOT NULL DEFAULT '',offer_count INTEGER NOT NULL DEFAULT 0,store_ids TEXT NOT NULL DEFAULT '[]',merchant_id TEXT NOT NULL DEFAULT '',updated_at INTEGER NOT NULL DEFAULT 0)`,
"""
worker = replace_once(worker, schema_anchor, schema_block, 'Kaspi price template schema')

# --- Kaspi XML helpers / status / builder ---
helper_anchor = """async function getStockSyncStatus(db) {
"""
helpers = r'''function kaspiStockHttpError(message, status = 400) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function kaspiXmlDecode(value) {
  return String(value || '').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
}

function kaspiXmlEscapeAttr(value) {
  return String(value ?? '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function kaspiXmlAttr(tag, name) {
  const re = new RegExp('\\b' + name + '\\s*=\\s*(["\\\'])([^"\\\']*)\\1', 'i');
  const m = re.exec(String(tag || ''));
  return m ? kaspiXmlDecode(m[2]) : '';
}

function setKaspiXmlAttr(tag, name, value) {
  const src = String(tag || '');
  const safe = kaspiXmlEscapeAttr(value);
  const re = new RegExp('(\\s' + name + '\\s*=\\s*)(["\\\'])([^"\\\']*)\\2', 'i');
  if (re.test(src)) return src.replace(re, (_m, prefix) => prefix + '"' + safe + '"');
  return src.replace(/\s*\/?>$/, tail => ' ' + name + '="' + safe + '"' + (tail.trim().startsWith('/') ? '/>' : '>'));
}

function kaspiTemplateInfo(xml) {
  const raw = String(xml || '').trim();
  if (!raw || !/<kaspi_catalog\b/i.test(raw) || !/<\/kaspi_catalog>/i.test(raw)) throw kaspiStockHttpError('Нужен полный XML-прайс Kaspi с тегом kaspi_catalog.');
  const merchantMatch = raw.match(/<merchantid\b[^>]*>([\s\S]*?)<\/merchantid>/i);
  const merchantId = merchantMatch ? String(merchantMatch[1] || '').replace(/<[^>]+>/g,'').trim() : '';
  if (!merchantId) throw kaspiStockHttpError('В XML не найден merchantid Kaspi.');
  const offerSkus = new Set();
  const stores = new Set();
  const skuStores = new Map();
  const offerRe = /<offer\b[^>]*\bsku\s*=\s*(["'])([^"']+)\1[^>]*>[\s\S]*?<\/offer>/gi;
  let m;
  while ((m = offerRe.exec(raw))) {
    const sku = kaspiXmlDecode(String(m[2] || '').trim());
    if (!sku) continue;
    offerSkus.add(sku);
    const set = new Set();
    const avRe = /<availability\b[^>]*\bstoreId\s*=\s*(["'])([^"']+)\1[^>]*\/?>/gi;
    let a;
    while ((a = avRe.exec(m[0]))) {
      const store = kaspiXmlDecode(String(a[2] || '').trim());
      if (!store) continue;
      stores.add(store);
      set.add(store);
    }
    skuStores.set(sku, set);
  }
  if (!offerSkus.size) throw kaspiStockHttpError('В XML не найдено ни одного offer sku.');
  if (!stores.size) throw kaspiStockHttpError('В XML не найдены склады availability storeId.');
  return { raw, merchantId, offerSkus, storeIds:[...stores], skuStores };
}

function kaspiLinkedProducts(warehouse) {
  const seen = new Set(), out = [];
  for (const product of warehouse.products || []) {
    const sku = String(product?.kaspi || '').trim();
    if (!sku || seen.has(sku)) continue;
    seen.add(sku);
    out.push({ sku, product });
  }
  return out;
}

function kaspiFeedUrl(requestUrl, key) {
  if (!key) return '';
  const u = new URL(requestUrl);
  const feed = new URL('/kaspi/price-list.xml', u.origin);
  feed.searchParams.set('key', key);
  return feed.toString();
}

async function readKaspiTemplateRow(db) {
  return await db.prepare('SELECT raw_xml AS rawXml,feed_key AS feedKey,primary_store_id AS primaryStoreId,offer_count AS offerCount,store_ids AS storeIds,merchant_id AS merchantId,updated_at AS updatedAt FROM kaspi_price_template WHERE id=1').first();
}

async function getKaspiStockFeedStatus(env, requestUrl) {
  const row = await readKaspiTemplateRow(env.DB);
  if (!row?.rawXml) return { configured:false, ready:false, feedUrl:'', offerCount:0, storeIds:[], primaryStoreId:'', linked:0, matched:0, missingSkus:[], missingPrimaryStore:[] };
  let info;
  try { info = kaspiTemplateInfo(row.rawXml); }
  catch (e) { return { configured:true, ready:false, error:String(e?.message || e), feedUrl:'', offerCount:Number(row.offerCount || 0), storeIds:[], primaryStoreId:String(row.primaryStoreId || ''), linked:0, matched:0, missingSkus:[], missingPrimaryStore:[] }; }
  let warehouse;
  try { warehouse = await loadWarehouseSnapshotForStock(env.DB); }
  catch (e) { return { configured:true, ready:false, error:String(e?.message || e), feedUrl:kaspiFeedUrl(requestUrl,row.feedKey), offerCount:info.offerSkus.size, storeIds:info.storeIds, primaryStoreId:String(row.primaryStoreId || ''), linked:0, matched:0, missingSkus:[], missingPrimaryStore:[] }; }
  const linked = kaspiLinkedProducts(warehouse);
  const matchedRows = linked.filter(x => info.offerSkus.has(x.sku));
  const missingSkus = linked.filter(x => !info.offerSkus.has(x.sku)).map(x => x.sku);
  const selected = String(row.primaryStoreId || '').trim() || (info.storeIds.length === 1 ? info.storeIds[0] : '');
  const missingPrimaryStore = selected ? matchedRows.filter(x => !info.skuStores.get(x.sku)?.has(selected)).map(x => x.sku) : [];
  const ready = Boolean(selected && info.storeIds.includes(selected) && matchedRows.length && !missingPrimaryStore.length && (warehouse.products || []).length);
  return {
    configured:true, ready, feedUrl:kaspiFeedUrl(requestUrl,row.feedKey), merchantId:info.merchantId,
    offerCount:info.offerSkus.size, storeIds:info.storeIds, primaryStoreId:selected,
    linked:linked.length, matched:matchedRows.length, missingSkus:missingSkus.slice(0,200),
    missingPrimaryStore:missingPrimaryStore.slice(0,200), updatedAt:Number(row.updatedAt || 0),
    multiStoreMode:info.storeIds.length > 1 ? 'primary-store-only-for-managed-skus' : 'single-store'
  };
}

async function saveKaspiPriceTemplate(env, body, requestUrl) {
  const xml = typeof body?.xml === 'string' ? body.xml : '';
  const requestedStore = String(body?.primaryStoreId || '').trim();
  const existing = await readKaspiTemplateRow(env.DB);
  if (!xml && !existing?.rawXml) throw kaspiStockHttpError('Сначала загрузите текущий XML-прайс Kaspi.');
  const raw = xml || existing.rawXml;
  if (raw.length > 6_000_000) throw kaspiStockHttpError('XML-прайс слишком большой для этого импорта (лимит 6 МБ).', 413);
  const info = kaspiTemplateInfo(raw);
  let primaryStoreId = requestedStore || String(existing?.primaryStoreId || '').trim();
  if (primaryStoreId && !info.storeIds.includes(primaryStoreId)) throw kaspiStockHttpError('Выбранного склада нет в загруженном XML Kaspi.');
  if (!primaryStoreId && info.storeIds.length === 1) primaryStoreId = info.storeIds[0];
  const feedKey = String(existing?.feedKey || '').trim() || crypto.randomUUID().replace(/-/g,'');
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO kaspi_price_template(id,raw_xml,feed_key,primary_store_id,offer_count,store_ids,merchant_id,updated_at)
    VALUES(1,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET raw_xml=excluded.raw_xml,feed_key=excluded.feed_key,primary_store_id=excluded.primary_store_id,offer_count=excluded.offer_count,store_ids=excluded.store_ids,merchant_id=excluded.merchant_id,updated_at=excluded.updated_at`)
    .bind(raw,feedKey,primaryStoreId,info.offerSkus.size,JSON.stringify(info.storeIds),info.merchantId,now).run();
  return await getKaspiStockFeedStatus(env, requestUrl);
}

async function buildKaspiPriceListXml(env, url) {
  const row = await readKaspiTemplateRow(env.DB);
  const suppliedKey = String(url.searchParams.get('key') || '');
  if (!row?.rawXml || !row?.feedKey || suppliedKey !== String(row.feedKey)) throw kaspiStockHttpError('Not found', 404);
  const warehouse = await loadWarehouseSnapshotForStock(env.DB);
  if (!(warehouse.products || []).length) throw kaspiStockHttpError('Warehouse is empty; Kaspi feed blocked by safety gate.', 503);
  const linked = kaspiLinkedProducts(warehouse);
  if (!linked.length) throw kaspiStockHttpError('No Kaspi-linked products; feed blocked by safety gate.', 409);
  const info = kaspiTemplateInfo(row.rawXml);
  const primaryStoreId = String(row.primaryStoreId || '').trim() || (info.storeIds.length === 1 ? info.storeIds[0] : '');
  if (!primaryStoreId || !info.storeIds.includes(primaryStoreId)) throw kaspiStockHttpError('Primary Kaspi store is not selected.', 409);
  const orderRows = await env.DB.prepare("SELECT market,order_id AS orderId,entry_id AS entryId,status,state,creation_date AS creationDate,sku,qty FROM marketplace_order_lines WHERE market IN ('Kaspi','WB','WB2')").all();
  const amounts = computeSharedAvailableStocks(warehouse, orderRows.results || []);
  const managed = new Map(linked.map(x => [x.sku, x.product]));
  const matched = new Set();
  const missingPrimary = [];
  const offerRe = /(<offer\b[^>]*\bsku\s*=\s*(["'])([^"']+)\2[^>]*>)([\s\S]*?)(<\/offer>)/gi;
  const xml = String(row.rawXml).replace(offerRe, (whole, open, _q, encodedSku, body, close) => {
    const sku = kaspiXmlDecode(encodedSku).trim();
    const product = managed.get(sku);
    if (!product) return whole;
    matched.add(sku);
    const storeSet = info.skuStores.get(sku) || new Set();
    if (!storeSet.has(primaryStoreId)) {
      missingPrimary.push(sku);
      return whole;
    }
    const amount = Math.max(0, Math.floor(Number(amounts.get(String(product.id))) || 0));
    let foundPrimary = false;
    const updatedBody = body.replace(/<availability\b[^>]*\/?>/gi, tag => {
      const storeId = kaspiXmlAttr(tag, 'storeId');
      if (!storeId) return tag;
      let next = tag;
      if (storeId === primaryStoreId) {
        foundPrimary = true;
        next = setKaspiXmlAttr(next, 'available', amount > 0 ? 'yes' : 'no');
        next = setKaspiXmlAttr(next, 'stockCount', String(amount));
        return next;
      }
      if (info.storeIds.length > 1) {
        next = setKaspiXmlAttr(next, 'available', 'no');
        next = setKaspiXmlAttr(next, 'stockCount', '0');
      }
      return next;
    });
    if (!foundPrimary) {
      missingPrimary.push(sku);
      return whole;
    }
    return open + updatedBody + close;
  });
  if (!matched.size) throw kaspiStockHttpError('No linked Kaspi SKU matched the uploaded XML; feed blocked by safety gate.', 409);
  if (missingPrimary.length) throw kaspiStockHttpError('Selected Kaspi store is missing for linked SKU: ' + missingPrimary.slice(0,12).join(', '), 409);
  return { xml, matched:matched.size, primaryStoreId };
}

''' + helper_anchor
worker = replace_once(worker, helper_anchor, helpers, 'Kaspi XML helpers')

# --- Browser UI button ---
settings_anchor = """  <div class=\"integration-actions\"><button class=\"btn\" onclick=\"checkMarketStatus('Kaspi')\">Проверить</button><button class=\"btn dark\" onclick=\"syncNow()\">Обновить Kaspi</button></div>
</div>
"""
settings_block = """  <div class=\"integration-actions\"><button class=\"btn\" onclick=\"checkMarketStatus('Kaspi')\">Проверить</button><button class=\"btn dark\" onclick=\"syncNow()\">Обновить Kaspi</button></div>
  <button class=\"btn full\" onclick=\"openKaspiStockSetup()\">Настроить остатки Kaspi</button>
</div>
"""
html = replace_once(html, settings_anchor, settings_block, 'Kaspi stock settings button')

# --- Browser UI functions ---
ui_anchor = """async function testKaspiWorker(){
"""
ui = r'''async function kaspiStockRequest(path, options={}) {
  const r = await fetch(MILLIONER_API + path, { cache:'no-store', ...options, headers:{ ...(options.headers||{}) } });
  let data = null;
  try { data = await r.json(); } catch { data = {}; }
  if (!r.ok || data?.ok === false) throw new Error(data?.error || ('HTTP ' + r.status));
  return data;
}

async function openKaspiStockSetup() {
  showSheet('<h3>Остатки Kaspi</h3><div class="empty">Проверяю настройку…</div>');
  try { renderKaspiStockSetup(await kaspiStockRequest('/api/kaspi-stock-feed-status')); }
  catch (e) { showSheet(`<h3>Остатки Kaspi</h3><div class="empty">${esc(String(e.message||e))}</div><button class="btn full" onclick="openKaspiStockSetup()">Повторить</button>`); }
}

function renderKaspiStockSetup(status={}) {
  const stores = Array.isArray(status.storeIds) ? status.storeIds : [];
  const selected = String(status.primaryStoreId || '');
  const storeControl = stores.length > 1 ? `<div class="field"><label>Основной склад Kaspi для общего остатка</label><select id="kaspiPrimaryStore">${stores.map(x=>`<option value="${esc(x)}" ${x===selected?'selected':''}>${esc(x)}</option>`).join('')}</select></div><div class="link-note">У нас один общий физический остаток. Для привязанных товаров полное доступное количество будет передаваться на выбранный склад, а остальные склады в XML получат 0 — так один и тот же товар не будет продаваться дважды.</div><button class="btn full" onclick="saveKaspiPrimaryStore()">Сохранить склад</button>` : stores.length===1 ? `<div class="link-note">Склад Kaspi: <b>${esc(stores[0])}</b></div>` : '';
  const missing = Array.isArray(status.missingSkus) ? status.missingSkus : [];
  const missingStore = Array.isArray(status.missingPrimaryStore) ? status.missingPrimaryStore : [];
  const summary = status.configured ? `<div class="item"><div><b>${status.ready?'XML готов к синхронизации':'XML загружен, нужна настройка'}</b></div><div class="muted" style="margin-top:7px">Товаров в XML: ${Number(status.offerCount||0)} · привязано к Kaspi в складе: ${Number(status.linked||0)} · найдено в XML: ${Number(status.matched||0)}</div>${missing.length?`<div class="muted" style="margin-top:5px">Нет в XML: ${esc(missing.slice(0,12).join(', '))}${missing.length>12?'…':''}. Они останутся в исходном XML без изменений.</div>`:''}${missingStore.length?`<div class="muted" style="margin-top:5px;color:#a40000">У выбранного склада нет availability у SKU: ${esc(missingStore.slice(0,12).join(', '))}</div>`:''}${status.error?`<div class="muted" style="margin-top:5px;color:#a40000">${esc(status.error)}</div>`:''}</div>` : '<div class="link-note">Нужно один раз загрузить <b>полный текущий XML-прайс</b> из Kaspi. Мы сохраняем цены, бренды и остальные товары как есть и автоматически меняем только наличие/остатки привязанных SKU.</div>';
  const feed = status.ready && status.feedUrl ? `<div class="field"><label>Защищённая ссылка для Kaspi</label><input id="kaspiFeedUrl" readonly value="${esc(status.feedUrl)}"></div><button class="btn dark full" onclick="copyKaspiStockFeed()">Скопировать ссылку</button><div class="link-note">В кабинете Kaspi вставьте её: <b>Товары → Загрузить прайс-лист → Автоматическая загрузка</b>. Kaspi будет забирать актуальный XML с нашего склада автоматически.</div>` : '';
  showSheet(`<h3>Остатки Kaspi</h3>${summary}${storeControl}<div class="field"><label>${status.configured?'Заменить текущий XML-прайс':'Текущий XML-прайс Kaspi'}</label><input id="kaspiStockXmlFile" type="file" accept=".xml,text/xml,application/xml"></div><button class="btn ${status.configured?'':'dark'} full" onclick="uploadKaspiStockTemplate()">${status.configured?'Загрузить новый XML':'Загрузить XML Kaspi'}</button>${feed}<div class="link-note">Скачать файл: веб-кабинет Kaspi → <b>Управление товарами → Прайс-лист → Скачать в XML</b>.</div>`);
}

async function uploadKaspiStockTemplate() {
  const file = document.getElementById('kaspiStockXmlFile')?.files?.[0];
  if (!file) return alert('Выберите XML-прайс Kaspi');
  if (file.size > 6_000_000) return alert('XML больше 6 МБ. Напишите мне — сделаем хранение для большого прайса.');
  const xml = await file.text();
  try {
    const currentStore = document.getElementById('kaspiPrimaryStore')?.value || '';
    const data = await kaspiStockRequest('/api/kaspi-price-template', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({xml,primaryStoreId:currentStore}) });
    renderKaspiStockSetup(data);
    alert(data.ready ? 'XML сохранён. Остатки Kaspi готовы к автоматической загрузке.' : 'XML сохранён. Проверьте выбор склада Kaspi.');
  } catch (e) { alert('Не удалось сохранить XML Kaspi:\n' + String(e.message||e)); }
}

async function saveKaspiPrimaryStore() {
  const primaryStoreId = document.getElementById('kaspiPrimaryStore')?.value || '';
  if (!primaryStoreId) return alert('Выберите склад Kaspi');
  try {
    const data = await kaspiStockRequest('/api/kaspi-price-template', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({primaryStoreId}) });
    renderKaspiStockSetup(data);
  } catch (e) { alert('Не удалось сохранить склад Kaspi:\n' + String(e.message||e)); }
}

async function copyKaspiStockFeed() {
  const input = document.getElementById('kaspiFeedUrl');
  if (!input?.value) return;
  try { await navigator.clipboard.writeText(input.value); alert('Ссылка скопирована. Вставьте её в Kaspi → Автоматическая загрузка.'); }
  catch { input.focus(); input.select(); document.execCommand('copy'); alert('Ссылка скопирована.'); }
}

''' + ui_anchor
html = replace_once(html, ui_anchor, ui, 'Kaspi stock setup UI')

worker_path.write_text(worker, encoding='utf-8')
index_path.write_text(html, encoding='utf-8')
print('Kaspi protected XML stock feed patch applied')
