import express from 'express';
import { createHash } from 'node:crypto';
import { config } from './config.js';
import { pool } from './db.js';
import { credentialFor } from './connections.js';
import { asyncRoute, requireTrustedOrigin, requireWritesEnabled } from './http.js';
import { readWarehouseProducts } from './warehouse-products.js';

const WB_PRICE_API = 'https://discounts-prices-api.wildberries.ru';
const OZON_API = 'https://api-seller.ozon.ru';
const CACHE_TTL_MS = 2 * 60 * 1000;
const WB_MIN_INTERVAL_MS = 650;
const WB_FALLBACK_COOLDOWN_MS = 6_000;
const cache = new Map();
const priceLoads = new Map();
const cacheGeneration = new Map();
let wbPriceLane = Promise.resolve();
let wbNextAllowedAt = 0;
const wbCooldowns = new Map();

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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function tokenFingerprint(token) {
  return createHash('sha256').update(String(token || '')).digest('hex').slice(0, 16);
}

function generationFor(market) {
  return Number(cacheGeneration.get(market) || 0);
}

function cached(key, force) {
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  return null;
}

function remember(key, market, generation, value) {
  if (generationFor(market) === generation) cache.set(key, { at: Date.now(), value });
  return value;
}

function invalidateMarket(market, dropStale = false) {
  cacheGeneration.set(market, generationFor(market) + 1);
  for (const [key, hit] of cache) {
    if (key !== market && !key.startsWith(market + ':')) continue;
    if (dropStale) cache.delete(key);
    else cache.set(key, { ...hit, at: 0 });
  }
}

function retryAtFromValue(raw, now = Date.now()) {
  const value = cleanText(raw);
  if (!value) return 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    if (numeric > 1e12) return Math.floor(numeric);
    if (numeric > 1e9) return Math.floor(numeric * 1000);
    return now + Math.ceil(numeric * 1000);
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > now ? parsed : 0;
}

function retryAtFromHeaders(headers, now = Date.now()) {
  return Math.max(
    retryAtFromValue(headers?.get?.('x-ratelimit-retry'), now),
    retryAtFromValue(headers?.get?.('retry-after'), now)
  );
}

function wbRateLimitError(retryAt = 0) {
  const error = new Error('WB временно ограничил частоту обновления цен');
  error.status = 429;
  error.retryAt = Math.max(Date.now() + 1000, Number(retryAt) || 0);
  return error;
}

function staleSnapshot(key, error) {
  const hit = cache.get(key);
  if (!hit?.value) return null;
  return {
    ...hit.value,
    stale: true,
    warning: cleanText(error?.message) || 'Не удалось обновить цены',
    retryAt: Number(error?.retryAt) || 0
  };
}

function canServeStale(error) {
  const status = Number(error?.status || 0);
  return status === 429 || status >= 500;
}

function withPriceLoad(key, task) {
  const current = priceLoads.get(key);
  if (current) return current;
  const promise = Promise.resolve().then(task);
  priceLoads.set(key, promise);
  return promise.finally(() => {
    if (priceLoads.get(key) === promise) priceLoads.delete(key);
  });
}

function withWbPriceLane(scope, task) {
  const run = wbPriceLane.then(async () => {
    const now = Date.now();
    const cooldown = Number(wbCooldowns.get(scope) || 0);
    if (cooldown > now) throw wbRateLimitError(cooldown);
    const wait = Math.max(0, wbNextAllowedAt - now);
    if (wait) await sleep(wait);
    wbNextAllowedAt = Date.now() + WB_MIN_INTERVAL_MS;
    return task();
  });
  wbPriceLane = run.catch(() => {});
  return run;
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

async function requestWb(token, path, options = {}, meta = {}) {
  const scope = tokenFingerprint(token);
  return withWbPriceLane(scope, async () => {
    const started = Date.now();
    let response;
    try {
      response = await fetch(WB_PRICE_API + path, {
        ...options,
        headers: { Accept: 'application/json', Authorization: token, ...(options.headers || {}) },
        signal: AbortSignal.timeout(30_000)
      });
    } catch (cause) {
      const error = new Error('WB цены: сеть временно недоступна');
      error.status = 502;
      error.cause = cause;
      console.warn('WB prices request failed', JSON.stringify({
        market: meta.market || '', endpoint: path.split('?')[0], offset: meta.offset ?? null,
        force: Boolean(meta.force), durationMs: Date.now() - started, error: cleanText(cause?.message || cause)
      }));
      throw error;
    }
    const text = await response.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); }
      catch {
        const error = new Error('WB цены: некорректный ответ API');
        error.status = 502;
        console.warn('WB prices invalid JSON', JSON.stringify({
          market: meta.market || '', endpoint: path.split('?')[0], offset: meta.offset ?? null,
          force: Boolean(meta.force), status: response.status, durationMs: Date.now() - started
        }));
        throw error;
      }
    }
    const retryAt = response.status === 429
      ? (retryAtFromHeaders(response.headers) || Date.now() + WB_FALLBACK_COOLDOWN_MS)
      : 0;
    if (retryAt) wbCooldowns.set(scope, Math.max(Number(wbCooldowns.get(scope) || 0), retryAt));
    console.info('WB prices request', JSON.stringify({
      market: meta.market || '', endpoint: path.split('?')[0],
      method: cleanText(options.method || 'GET').toUpperCase(),
      offset: meta.offset ?? null, force: Boolean(meta.force), status: response.status,
      durationMs: Date.now() - started, retryAt
    }));
    if (!response.ok || data?.error === true) {
      const detail = cleanText(data?.errorText || data?.message || data?.detail);
      const error = new Error('WB цены: HTTP ' + response.status + (detail ? ' · ' + detail : ''));
      error.status = response.status === 429 ? 429
        : response.status === 401 || response.status === 403 ? 403
        : data?.error === true || (response.status >= 400 && response.status < 500) ? 400 : 502;
      error.retryAt = retryAt;
      throw error;
    }
    if (!data || typeof data !== 'object') {
      const error = new Error('WB цены: пустой ответ API');
      error.status = 502;
      throw error;
    }
    return data;
  });
}

async function wbToken(market) {
  const fallback = market === 'WB2' ? config.wbToken2 : market === 'WB' ? config.wbToken : '';
  return credentialFor(market, fallback);
}

async function normalizeWbPriceRows(market, rows) {
  const links = await productLinks(market);
  return rows.map(row => {
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
  }).sort((x, y) => x.name.localeCompare(y.name, 'ru'));
}

async function listWbPrices(market, force = false) {
  const token = await wbToken(market);
  if (!token) {
    const error = new Error(market + ': токен не настроен');
    error.status = 400;
    throw error;
  }
  const key = market + ':' + tokenFingerprint(token);
  const hit = cached(key, force);
  if (hit) {
    console.info('WB prices cache', JSON.stringify({ market, force: false, result: 'hit' }));
    return hit;
  }
  const cooldown = Number(wbCooldowns.get(tokenFingerprint(token)) || 0);
  if (cooldown > Date.now()) {
    const limited = wbRateLimitError(cooldown);
    const fallback = staleSnapshot(key, limited);
    if (fallback) return fallback;
    throw limited;
  }
  return withPriceLoad(key, async () => {
    const secondHit = cached(key, force);
    if (secondHit) return secondHit;
    const generation = generationFor(market);
    const rows = [];
    console.info('WB prices cache', JSON.stringify({ market, force: Boolean(force), result: 'miss' }));
    try {
      let complete = false;
      for (let offset = 0, page = 0; page < 100; page++, offset += 1000) {
        const data = await requestWb(
          token,
          '/api/v2/list/goods/filter?limit=1000&offset=' + offset,
          {},
          { market, offset, force }
        );
        const batch = Array.isArray(data?.data?.listGoods) ? data.data.listGoods : [];
        if (!batch.length) {
          complete = true;
          break;
        }
        rows.push(...batch);
        if (batch.length < 1000) {
          complete = true;
          break;
        }
      }
      if (!complete) {
        const error = new Error('WB цены: выгрузка превысила безопасный предел 100 страниц');
        error.status = 502;
        throw error;
      }
      const normalized = await normalizeWbPriceRows(market, rows);
      return remember(key, market, generation, {
        ok: true,
        market,
        source: 'Wildberries Prices & Discounts API',
        fetchedAt: Date.now(),
        rows: normalized
      });
    } catch (error) {
      if (Number(error?.status) === 429 && rows.length) {
        const partial = {
          ok: true,
          market,
          source: 'Wildberries Prices & Discounts API',
          fetchedAt: Date.now(),
          rows: await normalizeWbPriceRows(market, rows),
          stale: true,
          partial: true,
          warning: 'WB ограничил проверку следующей страницы',
          retryAt: Number(error?.retryAt) || 0
        };
        if (generationFor(market) === generation) cache.set(key, { at: 0, value: partial });
        return partial;
      }
      const fallback = canServeStale(error) ? staleSnapshot(key, error) : null;
      if (fallback) return fallback;
      throw error;
    }
  });
}

function freshWbRowForWrite(market, token, nmID) {
  const key = market + ':' + tokenFingerprint(token);
  const hit = cache.get(key);
  const fetchedAt = Number(hit?.value?.fetchedAt || 0);
  if (!hit?.value || !fetchedAt || Date.now() - fetchedAt >= CACHE_TTL_MS) {
    const error = new Error('Перед изменением общей цены обновите цены WB');
    error.status = 409;
    throw error;
  }
  const row = (hit.value.rows || []).find(item => Number(item?.remoteId) === nmID);
  if (!row) {
    const error = new Error('Товар WB не найден в актуальном снимке цен');
    error.status = 409;
    throw error;
  }
  return row;
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
  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); }
    catch {
      const error = new Error('Ozon цены: некорректный ответ API');
      error.status = 502;
      throw error;
    }
  }
  if (!response.ok) {
    let detail = cleanText(data?.message || data?.error?.message || data?.error || data?.detail);
    for (const secret of [cleanText(credentials.apiKey), cleanText(credentials.clientId)]) {
      if (secret) detail = detail.replaceAll(secret, '[hidden]');
    }
    detail = detail.slice(0, 400);
    const error = new Error('Ozon цены: HTTP ' + response.status + (detail ? ' · ' + detail : ''));
    error.status = response.status === 401 || response.status === 403 ? 403
      : response.status >= 400 && response.status < 500 ? 400 : 502;
    throw error;
  }
  if (!data || typeof data !== 'object') {
    const error = new Error('Ozon цены: пустой ответ API');
    error.status = 502;
    throw error;
  }
  return data;
}

async function ozonAccounts() {
  return (await pool.query("SELECT id,label FROM marketplace_credentials WHERE provider='OZON' AND enabled=1 AND encrypted_token IS NOT NULL AND encrypted_token<>'' ORDER BY created_at,id")).rows;
}

function ozonPriceObject(item) {
  const price = item?.price && typeof item.price === 'object' ? item.price : {};
  const current = Math.max(0, number(price.price, item?.price));
  const sellerDiscountPrice = Math.max(0, number(price.marketing_seller_price, item?.marketing_seller_price));
  const oldPrice = Math.max(0, number(price.old_price, item?.old_price));
  const minPrice = Math.max(0, number(price.min_price, price.min_ozon_price, item?.min_price, item?.min_ozon_price));
  const currency = cleanText(price.currency_code || price.currency || item?.currency_code || item?.currency) || 'RUB';
  return { current, sellerDiscountPrice, oldPrice, minPrice, currency };
}

async function listOzonPrices(force = false) {
  const key = 'Ozon';
  const hit = cached(key, force);
  if (hit) return hit;
  const generation = generationFor('Ozon');
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
    try {
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
        const effective = p.sellerDiscountPrice > 0 ? p.sellerDiscountPrice : p.current;
        const discountBase = p.oldPrice > effective ? p.oldPrice : p.current;
        const discount = discountBase > effective && effective > 0
          ? Math.max(0, Math.min(99, Math.round((1 - effective / discountBase) * 100)))
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
          finalPrice: effective,
          sellerDiscountPrice: p.sellerDiscountPrice,
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
    } catch (error) {
      all.push({
        id: 'Ozon:' + account.id + ':error',
        market: 'Ozon',
        account: cleanText(account.label) || account.id,
        accountId: account.id,
        error: cleanText(error?.message) || 'Не удалось загрузить цены этого кабинета'
      });
    }
  }
  return remember(key, 'Ozon', generation, {
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
    const current = freshWbRowForWrite(market, token, nmID);
    if (current.canEditPrice === false) {
      const error = new Error('У товара WB разные цены по размерам. Общую цену менять нельзя; измените только скидку.');
      error.status = 409;
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
    const error = new Error('Цена и скидка не изменились');
    error.status = 400;
    throw error;
  }
  const data = await requestWb(token, '/api/v2/upload/task', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: [item] })
  }, { market, force: true });
  const uploadId = number(data?.data?.id || data?.data?.uploadID);
  const alreadyExists = Boolean(data?.data?.alreadyExists);
  if (!(uploadId > 0) && !alreadyExists) {
    const error = new Error('WB не вернул корректное подтверждение операции');
    error.status = 502;
    throw error;
  }
  invalidateMarket(market, true);
  return {
    ok: true,
    market,
    accepted: true,
    applied: false,
    uploadId,
    alreadyExists
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
  if (!result) {
    const failure = new Error('Ozon не вернул результат обновления цены');
    failure.status = 502;
    throw failure;
  }
  const errors = Array.isArray(result?.errors) ? result.errors : [];
  if (result.updated !== true) {
    const message = errors.map(error => cleanText(error?.message || error?.code || error)).filter(Boolean).join('; ');
    const failure = new Error(message || 'Ozon не подтвердил обновление цены');
    failure.status = 400;
    throw failure;
  }
  invalidateMarket('Ozon', true);
  return { ok: true, market: 'Ozon', updated: true, result };
}

function sendPriceError(res, error) {
  const status = Number(error?.status || 500);
  const safeStatus = status >= 400 && status < 600 ? status : 500;
  return res.status(safeStatus).json({
    ok: false,
    error: safeStatus >= 500 ? 'Временная ошибка сервиса цен' : cleanText(error?.message || error),
    retryAt: Number(error?.retryAt) || 0
  });
}

pricesRouter.get('/market-prices', asyncRoute(async (req, res) => {
  const market = cleanText(req.query.market || 'Kaspi');
  const force = req.query.force === '1';
  try {
    if (market === 'Kaspi') return res.json(await listKaspiPrices());
    if (market === 'WB' || market === 'WB2') return res.json(await listWbPrices(market, force));
    if (market === 'Ozon') return res.json(await listOzonPrices(force));
    return res.status(400).json({ ok: false, error: 'Неизвестный магазин цен' });
  } catch (error) {
    return sendPriceError(res, error);
  }
}));

pricesRouter.post('/market-prices/update', requireWritesEnabled, asyncRoute(async (req, res) => {
  if (req.body?.confirm !== true) return res.status(400).json({ ok: false, error: 'Подтвердите изменение цены' });
  const market = cleanText(req.body?.market);
  try {
    if (market === 'WB' || market === 'WB2') return res.json(await setWbPrice(market, req.body));
    if (market === 'Ozon') return res.json(await setOzonPrice(req.body));
    return res.status(400).json({ ok: false, error: 'Этот магазин обновляется другим способом' });
  } catch (error) {
    return sendPriceError(res, error);
  }
}));
