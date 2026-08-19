import crypto from 'node:crypto';
import express from 'express';
import { config } from './config.js';
import { pool } from './db.js';
import { asyncRoute, requireTrustedOrigin, requireWritesEnabled } from './http.js';

export const stockRouter = express.Router();

function httpError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function xmlDecode(value) {
  return String(value || '').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function xmlEscape(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function xmlAttr(tag, name) {
  const match = new RegExp(`\\b${name}\\s*=\\s*(["'])([^"']*)\\1`, 'i').exec(String(tag || ''));
  return match ? xmlDecode(match[2]) : '';
}

function setXmlAttr(tag, name, value) {
  const safe = xmlEscape(value);
  const re = new RegExp(`(\\s${name}\\s*=\\s*)(["'])([^"']*)\\2`, 'i');
  if (re.test(tag)) return tag.replace(re, (_match, prefix) => `${prefix}"${safe}"`);
  return tag.replace(/\s*\/?>$/, tail => ` ${name}="${safe}"${tail.trim().startsWith('/') ? '/>' : '>'}`);
}

function templateInfo(xml) {
  const raw = String(xml || '').trim();
  if (!raw || !/<kaspi_catalog\b/i.test(raw) || !/<\/kaspi_catalog>/i.test(raw)) throw httpError('Нужен полный XML-прайс Kaspi с тегом kaspi_catalog.');
  const merchantMatch = raw.match(/<merchantid\b[^>]*>([\s\S]*?)<\/merchantid>/i);
  const merchantId = merchantMatch ? String(merchantMatch[1]).replace(/<[^>]+>/g, '').trim() : '';
  if (!merchantId) throw httpError('В XML не найден merchantid Kaspi.');
  const offerSkus = new Set(), stores = new Set(), skuStores = new Map();
  const offerRe = /<offer\b[^>]*\bsku\s*=\s*(["'])([^"']+)\1[^>]*>[\s\S]*?<\/offer>/gi;
  let offer;
  while ((offer = offerRe.exec(raw))) {
    const sku = xmlDecode(offer[2]).trim();
    if (!sku) continue;
    offerSkus.add(sku);
    const currentStores = new Set();
    const availabilityRe = /<availability\b[^>]*\bstoreId\s*=\s*(["'])([^"']+)\1[^>]*\/?>/gi;
    let availability;
    while ((availability = availabilityRe.exec(offer[0]))) {
      const store = xmlDecode(availability[2]).trim();
      if (store) { stores.add(store); currentStores.add(store); }
    }
    skuStores.set(sku, currentStores);
  }
  if (!offerSkus.size) throw httpError('В XML не найдено ни одного offer sku.');
  if (!stores.size) throw httpError('В XML не найдены склады availability storeId.');
  return { raw, merchantId, offerSkus, storeIds: [...stores], skuStores };
}

async function warehouse() {
  const result = await pool.query('SELECT payload FROM warehouse_state WHERE id=1');
  if (!result.rowCount) return { products: [], reservations: [] };
  try { return JSON.parse(result.rows[0].payload || '{}'); } catch { return { products: [], reservations: [] }; }
}

async function templateRow() {
  const result = await pool.query(`SELECT raw_xml AS "rawXml",feed_key AS "feedKey",primary_store_id AS "primaryStoreId",
    offer_count AS "offerCount",store_ids AS "storeIds",merchant_id AS "merchantId",updated_at AS "updatedAt"
    FROM kaspi_price_template WHERE id=1`);
  return result.rows[0] || null;
}

function feedUrl(req, key) {
  if (!key) return '';
  const protocol = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
  return `${protocol}://${req.get('host')}/kaspi/price-list.xml?key=${encodeURIComponent(key)}`;
}

async function status(req) {
  const [row, access, state] = await Promise.all([
    templateRow(),
    pool.query('SELECT last_fetched_at AS "lastFetchedAt",fetch_count AS "fetchCount",last_user_agent AS "lastFetchUserAgent" FROM kaspi_price_feed_access WHERE id=1'),
    warehouse()
  ]);
  const accessFields = access.rows[0] || { lastFetchedAt: 0, fetchCount: 0, lastFetchUserAgent: '' };
  if (!row?.rawXml) return { configured: false, ready: false, feedUrl: '', offerCount: 0, storeIds: [], primaryStoreId: '', linked: 0, matched: 0, missingSkus: [], missingPrimaryStore: [], ...accessFields };
  const info = templateInfo(row.rawXml);
  const linked = (state.products || []).map(product => ({ sku: String(product?.kaspi || '').trim(), product })).filter(item => item.sku);
  const matched = linked.filter(item => info.offerSkus.has(item.sku));
  const missingSkus = linked.filter(item => !info.offerSkus.has(item.sku)).map(item => item.sku);
  const primaryStoreId = String(row.primaryStoreId || '') || (info.storeIds.length === 1 ? info.storeIds[0] : '');
  const missingPrimaryStore = primaryStoreId ? matched.filter(item => !info.skuStores.get(item.sku)?.has(primaryStoreId)).map(item => item.sku) : [];
  return { configured: true, ready: Boolean(primaryStoreId && matched.length && !missingPrimaryStore.length), feedUrl: feedUrl(req, row.feedKey),
    merchantId: info.merchantId, offerCount: info.offerSkus.size, storeIds: info.storeIds, primaryStoreId, linked: linked.length,
    matched: matched.length, missingSkus, missingPrimaryStore, updatedAt: Number(row.updatedAt || 0), ...accessFields };
}

stockRouter.get('/kaspi-stock-feed-status', asyncRoute(async (req, res) => res.json({ ok: true, ...(await status(req)) })));

stockRouter.put('/kaspi-price-template', requireTrustedOrigin, requireWritesEnabled, asyncRoute(async (req, res) => {
  const existing = await templateRow();
  const raw = typeof req.body?.xml === 'string' && req.body.xml ? req.body.xml : existing?.rawXml;
  if (!raw) throw httpError('Сначала загрузите текущий XML-прайс Kaspi.');
  if (Buffer.byteLength(raw, 'utf8') > 6_000_000) throw httpError('XML-прайс слишком большой для этого импорта (лимит 6 МБ).', 413);
  const info = templateInfo(raw);
  let primaryStoreId = String(req.body?.primaryStoreId || existing?.primaryStoreId || '').trim();
  if (primaryStoreId && !info.storeIds.includes(primaryStoreId)) throw httpError('Выбранного склада нет в загруженном XML Kaspi.');
  if (!primaryStoreId && info.storeIds.length === 1) primaryStoreId = info.storeIds[0];
  const feedKey = String(existing?.feedKey || '') || crypto.randomBytes(24).toString('hex');
  await pool.query(`INSERT INTO kaspi_price_template(id,raw_xml,feed_key,primary_store_id,offer_count,store_ids,merchant_id,updated_at)
    VALUES(1,$1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO UPDATE SET raw_xml=excluded.raw_xml,feed_key=excluded.feed_key,
    primary_store_id=excluded.primary_store_id,offer_count=excluded.offer_count,store_ids=excluded.store_ids,merchant_id=excluded.merchant_id,updated_at=excluded.updated_at`,
  [raw, feedKey, primaryStoreId, info.offerSkus.size, JSON.stringify(info.storeIds), info.merchantId, Date.now()]);
  res.json({ ok: true, ...(await status(req)) });
}));

stockRouter.get('/kaspi-price-template', asyncRoute(async (_req, res) => {
  const row = await templateRow();
  res.json({ ok: true, configured: Boolean(row?.rawXml), ...row, rawXml: undefined });
}));

stockRouter.get('/stock-sync-status', asyncRoute(async (_req, res) => {
  const rows = [];
  for (const selected of ['WB', 'WB2']) {
    const latest = await pool.query('SELECT * FROM stock_sync_runs WHERE market=$1 ORDER BY id DESC LIMIT 1', [selected]);
    rows.push({ market: selected, latest: latest.rows[0] || null });
  }
  res.json({ ok: true, markets: rows });
}));

stockRouter.post('/stock-sync-now', requireTrustedOrigin, requireWritesEnabled, asyncRoute(async (_req, res) => {
  if (!config.marketSyncEnabled) return res.status(503).json({ ok: false, error: 'market-sync-disabled-during-migration' });
  return res.status(501).json({ ok: false, error: 'wb-stock-sync-port-not-enabled' });
}));

export const kaspiFeedHandler = asyncRoute(async (req, res) => {
  const row = await templateRow();
  if (!row?.rawXml || !row?.feedKey || String(req.query.key || '') !== String(row.feedKey)) throw httpError('Not found', 404);
  const state = await warehouse();
  if (!(state.products || []).length) throw httpError('Warehouse is empty; Kaspi feed blocked by safety gate.', 503);
  const info = templateInfo(row.rawXml);
  const primaryStoreId = String(row.primaryStoreId || '') || (info.storeIds.length === 1 ? info.storeIds[0] : '');
  if (!primaryStoreId) throw httpError('Primary Kaspi store is not selected.', 409);
  const managed = new Map((state.products || []).map(product => [String(product?.kaspi || '').trim(), product]).filter(([sku]) => sku));
  const reserved = new Map();
  for (const item of state.reservations || []) if (item?.active) reserved.set(String(item.productId), (reserved.get(String(item.productId)) || 0) + Math.max(0, Number(item.qty) || 0));
  let matched = 0;
  const offerRe = /(<offer\b[^>]*\bsku\s*=\s*(["'])([^"']+)\2[^>]*>)([\s\S]*?)(<\/offer>)/gi;
  const xml = row.rawXml.replace(offerRe, (whole, open, _quote, encodedSku, body, close) => {
    const product = managed.get(xmlDecode(encodedSku).trim());
    if (!product) return whole;
    matched++;
    const amount = Math.max(0, Math.floor((Number(product.stock) || 0) - (reserved.get(String(product.id)) || 0)));
    let foundPrimary = false;
    const updated = body.replace(/<availability\b[^>]*\/?>/gi, tag => {
      const storeId = xmlAttr(tag, 'storeId');
      if (!storeId) return tag;
      if (storeId === primaryStoreId) {
        foundPrimary = true;
        return setXmlAttr(setXmlAttr(tag, 'available', amount > 0 ? 'yes' : 'no'), 'stockCount', String(amount));
      }
      return info.storeIds.length > 1 ? setXmlAttr(setXmlAttr(tag, 'available', 'no'), 'stockCount', '0') : tag;
    });
    return foundPrimary ? open + updated + close : whole;
  });
  if (!matched) throw httpError('No linked Kaspi SKU matched the uploaded XML; feed blocked by safety gate.', 409);
  await pool.query(`INSERT INTO kaspi_price_feed_access(id,last_fetched_at,fetch_count,last_user_agent) VALUES(1,$1,1,$2)
    ON CONFLICT(id) DO UPDATE SET last_fetched_at=excluded.last_fetched_at,fetch_count=kaspi_price_feed_access.fetch_count+1,last_user_agent=excluded.last_user_agent`,
  [Date.now(), String(req.headers['user-agent'] || '').slice(0, 300)]);
  res.type('application/xml').send(xml);
});

