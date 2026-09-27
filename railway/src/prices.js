import express from 'express';
import { config } from './config.js';
import { pool } from './db.js';
import { credentialFor } from './connections.js';
import { asyncRoute, requireTrustedOrigin, requireWritesEnabled } from './http.js';
import { readWarehouseProducts } from './warehouse-products.js';

const WB_PRICE_API = 'https://discounts-prices-api.wildberries.ru';
const OZON_API = 'https://api-seller.ozon.ru';
const CACHE_TTL_MS = 2 * 60 * 1000;
const cache = new Map();

export const pricesRouter = express.Router();
pricesRouter.use(requireTrustedOrigin);

function number(...values) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function cleanText(value) {
  return String(value ?? '').trim();
}

function clampDiscount(value) {
  const parsed = Math.round(number(value));
  return Math.max(0, Math.min(99, parsed));
}

function cached(key, force) {
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  return null;
}

function remember(key, value) {
  cache.set(key, { at: Date.now(), value });
  return value;
}

function invalidateMarket(market) {
  for (const key of [...cache.keys()]) if (key === market || key.startsWith(market + ':')) cache.delete(key);
}

async function productLinks(market) {
  const result = await pool.query(`
    SELECT pl.sku,pl.product_id AS "productId",COALESCE(p.name,'') AS name
    FROM product_links pl
    LEFT JOIN products p ON p.id=pl.product_id
    WHERE pl.market=$1
  `, [market]);
  const bySku = new Map();
  for (const row of result.rows) {
    const sku = cleanText(row.sku);
    if (sku && !bySku.has(sku)) bySku.set(sku, row);
  }
  return bySku;
}

function xmlDecode(value) {
  return String(value || '')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function kaspiTemplatePrices(rawXml) {
  const map = new Map();
  const raw = String(rawXml || '');
  const offerRe = /<offer\b[^>]*\bsku\s*=\s*(["'])([^"']+)\1[^>]*>([\s\S]*?)<\/offer>/gi;
  let match;
  while ((match = offerRe.exec(raw))) {
    const sku = xmlDecode(match[2]).trim();
    const body = match[3] || '';
    const priceMatch = body.match(/<price\b[^>]*>\s*([^<]+?)\s*<\/price>/i)
      || body.match(/<cityprice\b[^>]*>\s*([^<]+?)\s*<\/cityprice>/i);
    const price = priceMatch ? number(String(priceMatch[1]).replace(/\s+/g, '')) : 0;
    if (sku && price > 0) map.set(sku, price);
  }
  return map;
}

async function listKaspiPrices() {
  const [products, template] = await Promise.all([
    readWarehouseProducts(pool),
    pool.query('SELECT raw_xml AS "rawXml",updated_at AS "updatedAt" FROM kaspi_price_template WHERE id=1')
      .catch(() => ({ rows: [] }))
  ]);
  const templatePrices = kaspiTemplatePrices(template.rows[0]?.rawXml);
  const rows = [];
  for (const product of products) {
    const primary = cleanText(product?.kaspi);
    const aliases = Array.isArray(product?.kaspiAliases) ? product.kaspiAliases.map(cleanText).filter(Boolean) : [];
    const sku = primary || aliases[0] || '';
    if (!sku) continue;
    const warehousePrice = Math.max(0, number(product?.kaspiPrice));
    const templatePrice = Math.max(0, number(templatePrices.get(sku)));
    const price = warehousePrice || templatePrice;
    rows.push({
      id: 'Kaspi:' + product.id,
      market: 'Kaspi',
      account: 'Kaspi',
      productId: String(product.id),
      name: cleanText(product.name) || sku,
      sku,
      remoteId: sku,
      linked: true,
      price,
      finalPrice: price,
      oldPrice: 0,
      minPrice: 0,
      discount: null,
      clubDiscount: null,
      currency: 'KZT',
      source: warehousePrice ? 'warehouse' : templatePrice ? 'xml' : 'none',
      canEditPrice: true,
      canEditDiscount: false
    });
  }
  return {
    ok: true,
    market: 'Kaspi',
    source: 'Kaspi XML price list',
    fetchedAt: Date.now(),
    templateUpdatedAt: number(template.rows[0]?.updatedAt),
    rows: rows.sort((a, b) => a.name.localeCompare(b.name, 'ru'))
  };
}

async function requestWb(token, path, options = {}) {
  const response = await fetch(WB_PRICE_API + path, {
    ...options,
    headers: { Accept: 'application/json', Authorization: token, ...(options.headers || {}) },
    signal: AbortSignal.timeout(30_000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.error === true) {
    const detail = cleanText(data?.errorText || data?.message || data?.detail);
    const error = new Error('WB цены: HTTP ' + response.status + (detail ? ' · ' + detail : ''));
    error.status = response.status === 401 || response.status === 403 ? 403 : 502;
    throw error;
  }
  return data;
}

async function wbToken(market) {
  const fallback = market === 'WB2' ? config.wbToken2 : market === 'WB' ? config.wbToken : '';
  return credentialFor(market, fallback);
}

async function listWbPrices(market, force = false) {
  const key = market;
  const hit = cached(key, force);
  if (hit) return hit;
  const token = await wbToken(market);
  if (!token) {
    const error = new Error(market + ': токен не настроен');
    error.status = 400;
    throw error;
  }
  const rows = [];
  for (let offset = 0, page = 0; page < 100; page++, offset += 1000) {
    const data = await requestWb(token, '/api/v2/list/goods/filter?limit=1000&offset=' + offset);
    const batch = Array.isArray(data?.data?.listGoods) ? data.data.listGoods : [];
    rows.push(...batch);
    if (batch.length < 1000) break;
  }
  const links = await productLinks(market);
  const normalized = rows.map(row => {
    const vendorCode = cleanText(row?.vendorCode);
    const nmId = cleanText(row?.nmID);
    const link = links.get(vendorCode) || links.get(nmId) || null;
    const sizes = Array.isArray(row?.sizes) ? row.sizes : [];
    const prices = sizes.map(size => number(size?.price)).filter(value => value > 0);
    const discounted = sizes.map(size => number(size?.discountedPrice)).filter(value => value > 0);
    const club = sizes.map(size => number(size?.clubDiscountedPrice)).filter(value => value > 0);
    const uniquePrices = [...new Set(prices.map(value => String(value)))].map(Number);
    const price = prices.length ? Math.min(...prices) : 0;
    const priceMax = prices.length ? Math.max(...prices) : price;
    const finalPrice = discounted.length ? Math.min(...discounted) : price > 0 ? price * (1 - clampDiscount(row?.discount) / 100) : 0;
    const finalPriceMax = discounted.length ? Math.max(...discounted) : priceMax > 0 ? priceMax * (1 - clampDiscount(row?.discount) / 100) : 0;
    return {
      id: market + ':' + nmId,
      market,
      account: market === 'WB' ? 'WB 1' : market === 'WB2' ? 'WB 2' : market,
      productId: cleanText(link?.productId),
      name: cleanText(link?.name) || vendorCode || ('WB ' + nmId),
      sku: vendorCode,
      remoteId: nmId,
      linked: Boolean(link),
      price,
      priceMax,
      finalPrice,
      finalPriceMax,
      oldPrice: 0,
      minPrice: 0,
      discount: clampDiscount(row?.discount),
      clubDiscount: clampDiscount(row?.clubDiscount),
      clubFinalPrice: club.length ? Math.min(...club) : 0,
      currency: cleanText(row?.currencyIsoCode4217) || 'RUB',
      source: 'wb-api',
      editableSizePrice: Boolean(row?.editableSizePrice),
      canEditPrice: uniquePrices.length <= 1,
      canEditDiscount: true,
      sizes: sizes.length
    };
  }).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  return remember(key, {
    ok: true,
    market,
    source: 'Wildberries Prices & Discounts API',
    fetchedAt: Date.now(),
    rows: normalized
  });
}

async function requestOzon(credentials, path, body) {
  const response = await fetch(OZON_API + path, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Client-Id': credentials.clientId,
      'Api-Key': credentials.apiKey
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = cleanText(data?.message || data?.error?.message || data?.error || data?.detail)
      .replaceAll(cleanText(credentials.apiKey), '[hidden]')
      .replaceAll(cleanText(credentials.clientId), '[hidden]')
      .slice(0, 400);
    const error = new Error('Ozon цены: HTTP ' + response.status + (detail ? ' · ' + detail : ''));
    error.status = response.status === 401 || response.status === 403 ? 403 : 502;
    throw error;
  }
  return data;
}

async function ozonAccounts() {
  return (await pool.query("SELECT id,label FROM marketplace_credentials WHERE provider='OZON' AND enabled=1 AND encrypted_token IS NOT NULL AND encrypted_token<>'' ORDER BY created_at,id")).rows;
}

function ozonPriceObject(item) {
  const price = item?.price && typeof item.price === 'object' ? item.price : {};
  const current = Math.max(0, number(price.price, item?.price, price.marketing_seller_price, item?.marketing_seller_price));
  const oldPrice = Math.max(0, number(price.old_price, item?.old_price));
  const minPrice = Math.max(0, number(price.min_price, price.min_ozon_price, item?.min_price, item?.min_ozon_price));
  const currency = cleanText(price.currency_code || price.currency || item?.currency_code || item?.currency) || 'RUB';
  return { current, oldPrice, minPrice, currency };
}

async function listOzonPrices(force = false) {
  const key = 'Ozon';
  const hit = cached(key, force);
  if (hit) return hit;
  const configured = await ozonAccounts();
  if (!configured.length) {
    const error = new Error('Ozon: нет подключённого кабинета');
    error.status = 400;
    throw error;
  }
  const links = await productLinks('Ozon');
  const all = [];
  for (const account of configured) {
    let credentials;
    try {
      credentials = JSON.parse(await credentialFor(account.id));
      if (!credentials?.clientId || !credentials?.apiKey) throw new Error('missing credentials');
    } catch {
      all.push({
        id: 'Ozon:' + account.id + ':error',
        market: 'Ozon',
        account: cleanText(account.label) || account.id,
        accountId: account.id,
        error: 'Проверьте Client ID и API-ключ Ozon'
      });
      continue;
    }
    let cursor = '';
    for (let page = 0; page < 100; page++) {
      const data = await requestOzon(credentials, '/v5/product/info/prices', {
        cursor,
        filter: { visibility: 'ALL' },
        limit: 1000
      });
      const result = data?.result || data || {};
      const items = Array.isArray(result?.items) ? result.items : Array.isArray(data?.items) ? data.items : [];
      for (const item of items) {
        const offerId = cleanText(item?.offer_id);
        const productId = cleanText(item?.product_id);
        const link = links.get(offerId) || null;
        const p = ozonPriceObject(item);
        const discount = p.oldPrice > p.current && p.current > 0
          ? Math.max(0, Math.min(99, Math.round((1 - p.current / p.oldPrice) * 100)))
          : 0;
        all.push({
          id: 'Ozon:' + account.id + ':' + (offerId || productId),
          market: 'Ozon',
          account: cleanText(account.label) || account.id,
          accountId: account.id,
          productId: cleanText(link?.productId),
          name: cleanText(link?.name) || offerId || ('Ozon ' + productId),
          sku: offerId,
          remoteId: productId,
          linked: Boolean(link),
          price: p.current,
          finalPrice: p.current,
          oldPrice: p.oldPrice,
          minPrice: p.minPrice,
          discount,
          clubDiscount: null,
          currency: p.currency,
          source: 'ozon-api',
          canEditPrice: true,
          canEditDiscount: true
        });
      }
      const next = cleanText(result?.cursor || data?.cursor);
      if (items.length < 1000 || !next) break;
      if (next === cursor) throw new Error('Ozon цены: повтор курсора');
      cursor = next;
    }
  }
  return remember(key, {
    ok: true,
    market: 'Ozon',
    source: 'Ozon Seller API',
    fetchedAt: Date.now(),
    rows: all.sort((a, b) => (a.account + ' ' + a.name).localeCompare(b.account + ' ' + b.name, 'ru'))
  });
}

async function setWbPrice(market, input) {
  const token = await wbToken(market);
  if (!token) {
    const error = new Error(market + ': токен не настроен');
    error.status = 400;
    throw error;
  }
  const nmID = Number(input?.remoteId);
  if (!Number.isInteger(nmID) || nmID <= 0) {
    const error = new Error('Не найден корректный nmID WB');
    error.status = 400;
    throw error;
  }
  const item = { nmID };
  if (input?.price !== null && input?.price !== undefined && input?.price !== '') {
    const price = number(input.price);
    if (!(price > 0)) {
      const error = new Error('Цена WB должна быть больше 0');
      error.status = 400;
      throw error;
    }
    item.price = price;
  }
  if (input?.discount !== null && input?.discount !== undefined && input?.discount !== '') {
    const discount = Number(input.discount);
    if (!Number.isInteger(discount) || discount < 0 || discount > 99) {
      const error = new Error('Скидка WB должна быть целым числом от 0 до 99');
      error.status = 400;
      throw error;
    }
    item.discount = discount;
  }
  if (item.price === undefined && item.discount === undefined) {
    const error = new Error('Укажите новую цену или скидку');
    error.status = 400;
    throw error;
  }
  const data = await requestWb(token, '/api/v2/upload/task', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: [item] })
  });
  invalidateMarket(market);
  return {
    ok: true,
    market,
    accepted: true,
    uploadId: number(data?.data?.id || data?.data?.uploadID),
    alreadyExists: Boolean(data?.data?.alreadyExists)
  };
}

async function setOzonPrice(input) {
  const accountId = cleanText(input?.accountId);
  const account = (await ozonAccounts()).find(row => cleanText(row.id) === accountId);
  if (!account) {
    const error = new Error('Ozon кабинет не найден');
    error.status = 404;
    throw error;
  }
  let credentials;
  try {
    credentials = JSON.parse(await credentialFor(account.id));
  } catch {
    const error = new Error('Не удалось прочитать ключ Ozon');
    error.status = 400;
    throw error;
  }
  const offerId = cleanText(input?.sku);
  if (!offerId) {
    const error = new Error('Не найден offer_id Ozon');
    error.status = 400;
    throw error;
  }
  const price = number(input?.price);
  const oldPrice = Math.max(0, number(input?.oldPrice));
  const minPrice = Math.max(0, number(input?.minPrice));
  if (!(price > 0)) {
    const error = new Error('Цена Ozon должна быть больше 0');
    error.status = 400;
    throw error;
  }
  if (oldPrice > 0 && oldPrice <= price) {
    const error = new Error('Цена до скидки Ozon должна быть выше текущей цены или равна 0');
    error.status = 400;
    throw error;
  }
  const currency = cleanText(input?.currency) || 'RUB';
  const data = await requestOzon(credentials, '/v1/product/import/prices', {
    prices: [{
      offer_id: offerId,
      price: String(price),
      old_price: String(oldPrice || 0),
      min_price: String(minPrice || 0),
      currency_code: currency,
      auto_action_enabled: 'UNKNOWN'
    }]
  });
  const result = Array.isArray(data?.result) ? data.result[0] : null;
  const errors = Array.isArray(result?.errors) ? result.errors : [];
  if (result && result.updated === false) {
    const message = errors.map(error => cleanText(error?.message || error?.code || error)).filter(Boolean).join('; ');
    const failure = new Error(message || 'Ozon не обновил цену');
    failure.status = 400;
    throw failure;
  }
  invalidateMarket('Ozon');
  return { ok: true, market: 'Ozon', updated: result ? result.updated !== false : true, result };
}

pricesRouter.get('/market-prices', asyncRoute(async (req, res) => {
  const market = cleanText(req.query.market || 'Kaspi');
  const force = req.query.force === '1';
  if (market === 'Kaspi') return res.json(await listKaspiPrices());
  if (market === 'WB' || market === 'WB2') return res.json(await listWbPrices(market, force));
  if (market === 'Ozon') return res.json(await listOzonPrices(force));
  return res.status(400).json({ ok: false, error: 'Неизвестный магазин цен' });
}));

pricesRouter.post('/market-prices/update', requireWritesEnabled, asyncRoute(async (req, res) => {
  if (req.body?.confirm !== true) return res.status(400).json({ ok: false, error: 'Подтвердите изменение цены' });
  const market = cleanText(req.body?.market);
  if (market === 'WB' || market === 'WB2') return res.json(await setWbPrice(market, req.body));
  if (market === 'Ozon') return res.json(await setOzonPrice(req.body));
  return res.status(400).json({ ok: false, error: 'Этот магазин обновляется другим способом' });
}));
