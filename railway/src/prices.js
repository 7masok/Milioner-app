import express from 'express';
import { createHash } from 'node:crypto';
import { config } from './config.js';
import { pool } from './db.js';
import { credentialFor } from './connections.js';
import { asyncRoute, requireTrustedOrigin, requireWritesEnabled } from './http.js';
import { readWarehouseProducts } from './warehouse-products.js';
import { decorateWbPromotionRows } from './wb-promotions.js';

const WB_PRICE_API = 'https://discounts-prices-api.wildberries.ru';
const OZON_API = 'https://api-seller.ozon.ru';
const CACHE_TTL_MS = 2 * 60 * 1000;
const WB_MIN_INTERVAL_MS = 650;
const WB_FALLBACK_COOLDOWN_MS = 6_000;
const WB_PRICE_SLOT_MS = 15 * 60 * 1000 + 5_000;
const WB_PRICE_LOOP_MS = 60 * 1000;
const WB_PRICE_FIRST_DELAY_MS = 5_000;
const WB_PRICE_PAGE_LIMIT = 1000;
const ALMATY_OFFSET_MS = 5 * 60 * 60 * 1000;
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

function jsonValue(value, fallback) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(String(value || '')); } catch { return fallback; }
}

function timeToMinute(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(cleanText(value));
  if (!match) return null;
  const hour = Number(match[1]), minute = Number(match[2]);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}

function minuteToTime(value) {
  const minute = Math.max(0, Math.min(1439, Math.trunc(Number(value) || 0)));
  return String(Math.floor(minute / 60)).padStart(2, '0') + ':' + String(minute % 60).padStart(2, '0');
}

export function wbSafeReturnPrice(currentPrice, basePrice, cautious = false) {
  const current = number(currentPrice);
  const base = number(basePrice);
  if (!(current > 0) || !(base > 0) || base >= current) return base;
  const divisor = cautious ? 1.25 : 2;
  return Math.max(base, Math.ceil(current / divisor));
}

function isWbQuarantineError(value) {
  return /quarant|карантин/i.test(cleanText(value));
}

export function wbNightWindowState(startMinute, endMinute, now = Date.now()) {
  const start = Math.max(0, Math.min(1439, Math.trunc(Number(startMinute) || 0)));
  const end = Math.max(0, Math.min(1439, Math.trunc(Number(endMinute) || 0)));
  const local = new Date(Number(now) + ALMATY_OFFSET_MS);
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  const today = local.toISOString().slice(0, 10);
  const previous = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - 86_400_000).toISOString().slice(0, 10);
  if (start === end) return { inWindow: false, windowKey: '', minute };
  if (start < end) return { inWindow: minute >= start && minute < end, windowKey: minute >= start && minute < end ? today : '', minute };
  const inWindow = minute >= start || minute < end;
  return { inWindow, windowKey: inWindow ? (minute >= start ? today : previous) : '', minute };
}

async function wbPriceState(market, client = pool) {
  const result = await client.query(`SELECT market,next_allowed_at AS "nextAllowedAt",last_attempt_at AS "lastAttemptAt",
    last_success_at AS "lastSuccessAt",last_action AS "lastAction",last_error AS "lastError",
    read_offset AS "readOffset",read_buffer AS "readBuffer",updated_at AS "updatedAt"
    FROM wb_price_sync_state WHERE market=$1`, [market]);
  return result.rows[0] || {
    market, nextAllowedAt: 0, lastAttemptAt: 0, lastSuccessAt: 0,
    lastAction: '', lastError: '', readOffset: 0, readBuffer: []
  };
}

async function wbPriceSnapshot(market, client = pool) {
  const result = await client.query(`SELECT payload,fetched_at AS "fetchedAt",updated_at AS "updatedAt"
    FROM wb_price_snapshots WHERE market=$1`, [market]);
  const row = result.rows[0];
  if (!row) return null;
  const payload = jsonValue(row.payload, {});
  return { ...payload, fetchedAt: Number(row.fetchedAt || payload?.fetchedAt || 0), updatedAt: Number(row.updatedAt || 0) };
}

async function wbPriceQueueRows(market, client = pool) {
  const result = await client.query(`SELECT nm_id AS "nmId",desired_price AS "desiredPrice",
    desired_discount AS "desiredDiscount",status,queued_at AS "queuedAt",sent_at AS "sentAt",
    upload_id AS "uploadId",last_error AS "lastError",updated_at AS "updatedAt",
    source,promotion_id AS "promotionId"
    FROM wb_price_update_queue WHERE market=$1 ORDER BY queued_at,nm_id`, [market]);
  return result.rows.map(row => ({
    ...row,
    nmId: String(row.nmId || ''),
    desiredPrice: row.desiredPrice === null || row.desiredPrice === undefined ? null : Number(row.desiredPrice),
    desiredDiscount: row.desiredDiscount === null || row.desiredDiscount === undefined ? null : Number(row.desiredDiscount),
    queuedAt: Number(row.queuedAt || 0),
    sentAt: Number(row.sentAt || 0),
    uploadId: Number(row.uploadId || 0),
    updatedAt: Number(row.updatedAt || 0),
    source: cleanText(row.source || 'manual'),
    promotionId: Number(row.promotionId || 0)
  }));
}

async function wbPriceSchedules(market, client = pool) {
  const result = await client.query(`SELECT market,nm_id AS "nmId",enabled,start_minute AS "startMinute",
    end_minute AS "endMinute",target_price AS "targetPrice",base_price AS "basePrice",
    window_key AS "windowKey",manual_override_window AS "manualOverrideWindow",phase,
    last_error AS "lastError",updated_at AS "updatedAt"
    FROM wb_price_schedules WHERE market=$1 ORDER BY nm_id`, [market]);
  return result.rows.map(row => ({
    ...row,
    nmId: String(row.nmId || ''),
    enabled: Boolean(row.enabled),
    startMinute: Number(row.startMinute || 0),
    endMinute: Number(row.endMinute || 0),
    targetPrice: Number(row.targetPrice || 0),
    basePrice: row.basePrice === null || row.basePrice === undefined ? null : Number(row.basePrice),
    windowKey: cleanText(row.windowKey),
    manualOverrideWindow: cleanText(row.manualOverrideWindow),
    phase: cleanText(row.phase),
    lastError: cleanText(row.lastError),
    updatedAt: Number(row.updatedAt || 0)
  }));
}

function decorateWbNightSchedules(rows, schedules) {
  const byNm = new Map(schedules.map(row => [String(row.nmId), row]));
  return rows.map(raw => {
    const row = { ...raw };
    const schedule = byNm.get(String(row.remoteId || ''));
    row.nightPriceEnabled = Boolean(schedule?.enabled);
    row.nightPriceStart = schedule ? minuteToTime(schedule.startMinute) : '04:00';
    row.nightPriceEnd = schedule ? minuteToTime(schedule.endMinute) : '06:00';
    row.nightPriceTarget = schedule?.targetPrice || null;
    row.nightPricePhase = cleanText(schedule?.phase);
    row.nightPriceError = cleanText(schedule?.lastError);
    return row;
  });
}

async function queueSchedulePrice(market, nmId, price, client = pool) {
  const now = Date.now();
  const result = await client.query(`INSERT INTO wb_price_update_queue
    (market,nm_id,desired_price,desired_discount,status,queued_at,sent_at,upload_id,last_error,updated_at,source,promotion_id)
    VALUES($1,$2,$3,NULL,'pending',$4,0,0,'',$4,'schedule',0)
    ON CONFLICT(market,nm_id) DO UPDATE SET desired_price=excluded.desired_price,desired_discount=NULL,
      status='pending',queued_at=excluded.queued_at,sent_at=0,upload_id=0,last_error='',
      updated_at=excluded.updated_at,source='schedule',promotion_id=0
    WHERE wb_price_update_queue.source<>'manual'`, [market, nmId, Number(price), now]);
  return Number(result.rowCount || 0) > 0;
}

async function holdSchedulePrice(market, nmId, price, client = pool) {
  const now = Date.now();
  const result = await client.query(`INSERT INTO wb_price_update_queue
    (market,nm_id,desired_price,desired_discount,status,queued_at,sent_at,upload_id,last_error,updated_at,source,promotion_id)
    VALUES($1,$2,$3,NULL,'held',$4,0,0,'',$4,'schedule',0)
    ON CONFLICT(market,nm_id) DO UPDATE SET desired_price=excluded.desired_price,desired_discount=NULL,
      status='held',last_error='',updated_at=excluded.updated_at,source='schedule',promotion_id=0
    WHERE wb_price_update_queue.source<>'manual'`, [market, nmId, Number(price), now]);
  return Number(result.rowCount || 0) > 0;
}

async function markManualScheduleOverride(market, nmId, desiredPrice, now = Date.now()) {
  if (!(Number(desiredPrice) > 0)) return;
  const result = await pool.query(`SELECT enabled,start_minute AS "startMinute",end_minute AS "endMinute",
    base_price AS "basePrice",window_key AS "windowKey"
    FROM wb_price_schedules WHERE market=$1 AND nm_id=$2`, [market, nmId]);
  const schedule = result.rows[0];
  if (!schedule) return;
  const window = wbNightWindowState(schedule.startMinute, schedule.endMinute, now);
  await pool.query(`UPDATE wb_price_schedules SET
    base_price=CASE WHEN base_price IS NOT NULL OR $4 THEN $3 ELSE base_price END,
    manual_override_window=CASE WHEN $4 THEN $5 ELSE manual_override_window END,
    phase=CASE WHEN $4 THEN 'manual' ELSE phase END,last_error='',updated_at=$6
    WHERE market=$1 AND nm_id=$2`,
    [market, nmId, Number(desiredPrice), Boolean(schedule.enabled) && window.inWindow, window.windowKey, now]);
}

async function syncWbNightSchedules(market, now = Date.now()) {
  const [schedules, snapshot, queue] = await Promise.all([
    wbPriceSchedules(market),
    wbPriceSnapshot(market),
    wbPriceQueueRows(market)
  ]);
  if (!schedules.length || !snapshot) return { changed: 0 };
  const byNm = new Map((snapshot.rows || []).map(row => [String(row.remoteId || ''), row]));
  const queueByNm = new Map(queue.map(row => [String(row.nmId), row]));
  let changed = 0;

  for (const schedule of schedules) {
    if (!schedule.enabled && !(Number(schedule.basePrice) > 0)) continue;
    const row = byNm.get(schedule.nmId);
    if (!row || row.canEditPrice === false) {
      await pool.query(`UPDATE wb_price_schedules SET phase='error',last_error=$3,updated_at=$4 WHERE market=$1 AND nm_id=$2`,
        [market, schedule.nmId, row ? 'Разные цены по размерам' : 'Товар отсутствует в снимке цен', now]);
      continue;
    }
    if (schedule.phase === 'error' && schedule.lastError) continue;
    const confirmedPrice = number(row.price);
    const window = wbNightWindowState(schedule.startMinute, schedule.endMinute, now);
    let queueRow = queueByNm.get(schedule.nmId);

    if (schedule.enabled && window.inWindow) {
      if (schedule.manualOverrideWindow && schedule.manualOverrideWindow === window.windowKey) {
        if (schedule.phase !== 'manual') {
          await pool.query(`UPDATE wb_price_schedules SET phase='manual',last_error='',updated_at=$3 WHERE market=$1 AND nm_id=$2`,
            [market, schedule.nmId, now]);
        }
        continue;
      }

      let basePrice = Number(schedule.basePrice);
      if (!(basePrice > 0) || schedule.windowKey !== window.windowKey) {
        basePrice = confirmedPrice;
        await pool.query(`UPDATE wb_price_schedules SET base_price=$3,window_key=$4,manual_override_window='',
          phase='raising',last_error='',updated_at=$5 WHERE market=$1 AND nm_id=$2`,
          [market, schedule.nmId, basePrice, window.windowKey, now]);
        schedule.basePrice = basePrice;
        schedule.windowKey = window.windowKey;
        schedule.manualOverrideWindow = '';
        schedule.phase = 'raising';
      }

      if (queueRow?.source === 'manual') continue;
      if (Math.abs(confirmedPrice - schedule.targetPrice) < 0.000001) {
        const held = await holdSchedulePrice(market, schedule.nmId, schedule.targetPrice);
        if (held) {
          await pool.query(`UPDATE wb_price_schedules SET phase='active',last_error='',updated_at=$3 WHERE market=$1 AND nm_id=$2`,
            [market, schedule.nmId, now]);
          changed += 1;
        }
        continue;
      }
      if (queueRow?.source === 'schedule' && Number(queueRow.desiredPrice) === schedule.targetPrice && ['pending','sent','checking'].includes(queueRow.status)) continue;
      if (await queueSchedulePrice(market, schedule.nmId, schedule.targetPrice)) {
        await pool.query(`UPDATE wb_price_schedules SET phase='raising',last_error='',updated_at=$3 WHERE market=$1 AND nm_id=$2`,
          [market, schedule.nmId, now]);
        changed += 1;
      }
      continue;
    }

    if (!(Number(schedule.basePrice) > 0)) {
      if (schedule.phase !== (schedule.enabled ? 'idle' : 'off') || schedule.manualOverrideWindow) {
        await pool.query(`UPDATE wb_price_schedules SET phase=$3,window_key='',manual_override_window='',last_error='',updated_at=$4
          WHERE market=$1 AND nm_id=$2`, [market, schedule.nmId, schedule.enabled ? 'idle' : 'off', now]);
      }
      continue;
    }

    if (queueRow?.source === 'manual') continue;
    const basePrice = Number(schedule.basePrice);
    if (Math.abs(confirmedPrice - basePrice) < 0.000001) {
      await pool.query(`DELETE FROM wb_price_update_queue WHERE market=$1 AND nm_id=$2 AND source='schedule'`, [market, schedule.nmId]);
      await pool.query(`UPDATE wb_price_schedules SET base_price=NULL,window_key='',manual_override_window='',
        phase=$3,last_error='',updated_at=$4 WHERE market=$1 AND nm_id=$2`,
        [market, schedule.nmId, schedule.enabled ? 'idle' : 'off', now]);
      changed += 1;
      continue;
    }
    const restoreTarget = wbSafeReturnPrice(confirmedPrice, basePrice, isWbQuarantineError(schedule.lastError));
    if (queueRow?.source === 'schedule' && Number(queueRow.desiredPrice) === restoreTarget && ['pending','sent','checking'].includes(queueRow.status)) continue;
    if (await queueSchedulePrice(market, schedule.nmId, restoreTarget)) {
      await pool.query(`UPDATE wb_price_schedules SET phase='restoring',last_error='',updated_at=$3 WHERE market=$1 AND nm_id=$2`,
        [market, schedule.nmId, now]);
      changed += 1;
    }
  }
  return { changed };
}

function overlayWbQueuedRows(rows, queue) {
  const byNm = new Map(queue.map(item => [String(item.nmId), item]));
  return rows.map(raw => {
    const row = { ...raw };
    const pending = byNm.get(String(row.remoteId || ''));
    if (!pending) return row;
    row.confirmedPrice = number(row.price);
    row.confirmedPriceMax = number(row.priceMax);
    row.confirmedDiscount = clampDiscount(row.discount);
    if (pending.desiredPrice !== null && pending.desiredPrice > 0) {
      row.price = pending.desiredPrice;
      if (row.canEditPrice !== false) row.priceMax = pending.desiredPrice;
    }
    if (pending.desiredDiscount !== null) row.discount = clampDiscount(pending.desiredDiscount);
    const discount = clampDiscount(row.discount);
    if (number(row.price) > 0) row.finalPrice = number(row.price) * (1 - discount / 100);
    if (number(row.priceMax) > 0) row.finalPriceMax = number(row.priceMax) * (1 - discount / 100);
    row.syncState = pending.status === 'held' ? '' : ['sent','checking'].includes(pending.status) ? 'sent' : 'pending';
    row.syncSource = pending.source;
    row.syncQueuedAt = pending.queuedAt;
    row.syncSentAt = pending.sentAt;
    row.syncUploadId = pending.uploadId;
    row.syncError = cleanText(pending.lastError);
    return row;
  });
}

async function listWbPrices(market) {
  const [snapshot, state, queue, schedules] = await Promise.all([
    wbPriceSnapshot(market),
    wbPriceState(market),
    wbPriceQueueRows(market),
    wbPriceSchedules(market)
  ]);
  const queuedRows = overlayWbQueuedRows(Array.isArray(snapshot?.rows) ? snapshot.rows : [], queue);
  const promo = await decorateWbPromotionRows(market, queuedRows);
  const scheduledRows = decorateWbNightSchedules(promo.rows, schedules);
  return {
    ok: true,
    market,
    source: 'Снимок Railway · Wildberries Prices & Discounts API',
    fetchedAt: Number(snapshot?.fetchedAt || 0),
    rows: scheduledRows,
    serverSnapshot: true,
    waiting: !snapshot,
    nextSyncAt: Number(state.nextAllowedAt || 0),
    lastAttemptAt: Number(state.lastAttemptAt || 0),
    lastSuccessAt: Number(state.lastSuccessAt || 0),
    lastAction: cleanText(state.lastAction),
    syncError: cleanText(state.lastError),
    pendingCount: queue.filter(row => row.status === 'pending').length,
    sentCount: queue.filter(row => row.status === 'sent').length,
    promoNextSyncAt: Number(promo.promoNextSyncAt || 0),
    promoLastSyncAt: Number(promo.promoLastSyncAt || 0),
    promoSyncError: cleanText(promo.promoSyncError)
  };
}

async function wbSnapshotRowForWrite(market, nmID) {
  const snapshot = await wbPriceSnapshot(market);
  if (!snapshot) {
    const error = new Error('Цены WB ещё не синхронизированы. Дождитесь первого серверного сеанса.');
    error.status = 409;
    throw error;
  }
  const row = (snapshot.rows || []).find(item => Number(item?.remoteId) === nmID);
  if (!row) {
    const error = new Error('Товар WB не найден в последнем серверном снимке цен');
    error.status = 409;
    throw error;
  }
  return row;
}

async function markWbPriceState(market, values, client = pool) {
  const now = Date.now();
  const current = await wbPriceState(market, client);
  const next = {
    nextAllowedAt: values.nextAllowedAt ?? Number(current.nextAllowedAt || 0),
    lastAttemptAt: values.lastAttemptAt ?? Number(current.lastAttemptAt || 0),
    lastSuccessAt: values.lastSuccessAt ?? Number(current.lastSuccessAt || 0),
    lastAction: values.lastAction ?? cleanText(current.lastAction),
    lastError: values.lastError ?? cleanText(current.lastError),
    readOffset: values.readOffset ?? Number(current.readOffset || 0),
    readBuffer: values.readBuffer ?? (Array.isArray(current.readBuffer) ? current.readBuffer : jsonValue(current.readBuffer, []))
  };
  await client.query(`INSERT INTO wb_price_sync_state
    (market,next_allowed_at,last_attempt_at,last_success_at,last_action,last_error,read_offset,read_buffer,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
    ON CONFLICT(market) DO UPDATE SET
      next_allowed_at=excluded.next_allowed_at,last_attempt_at=excluded.last_attempt_at,
      last_success_at=excluded.last_success_at,last_action=excluded.last_action,last_error=excluded.last_error,
      read_offset=excluded.read_offset,read_buffer=excluded.read_buffer,updated_at=excluded.updated_at`,
    [market, next.nextAllowedAt, next.lastAttemptAt, next.lastSuccessAt, next.lastAction, next.lastError,
      next.readOffset, JSON.stringify(next.readBuffer || []), now]);
  return next;
}

async function queueWbPrice(market, input) {
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
  const current = await wbSnapshotRowForWrite(market, nmID);
  let desiredPrice = null, desiredDiscount = null;
  if (input?.price !== null && input?.price !== undefined && input?.price !== '') {
    const price = number(input.price);
    if (!(price > 0)) {
      const error = new Error('Цена WB должна быть больше 0');
      error.status = 400;
      throw error;
    }
    if (current.canEditPrice === false) {
      const error = new Error('У товара WB разные цены по размерам. Общую цену менять нельзя; измените только скидку.');
      error.status = 409;
      throw error;
    }
    desiredPrice = price;
  }
  if (input?.discount !== null && input?.discount !== undefined && input?.discount !== '') {
    const discount = Number(input.discount);
    if (!Number.isInteger(discount) || discount < 0 || discount > 99) {
      const error = new Error('Скидка WB должна быть целым числом от 0 до 99');
      error.status = 400;
      throw error;
    }
    desiredDiscount = discount;
  }
  if (desiredPrice === null && desiredDiscount === null) {
    const error = new Error('Цена и скидка не изменились');
    error.status = 400;
    throw error;
  }
  const now = Date.now();
  await pool.query(`INSERT INTO wb_price_update_queue
    (market,nm_id,desired_price,desired_discount,status,queued_at,sent_at,upload_id,last_error,updated_at,source,promotion_id)
    VALUES($1,$2,$3,$4,'pending',$5,0,0,'',$5,'manual',0)
    ON CONFLICT(market,nm_id) DO UPDATE SET
      desired_price=COALESCE(excluded.desired_price,wb_price_update_queue.desired_price),
      desired_discount=COALESCE(excluded.desired_discount,wb_price_update_queue.desired_discount),
      status='pending',queued_at=excluded.queued_at,sent_at=0,upload_id=0,last_error='',updated_at=excluded.updated_at,
      source='manual',promotion_id=0`,
    [market, nmID, desiredPrice, desiredDiscount, now]);
  if (desiredDiscount !== null) {
    await pool.query(`UPDATE wb_promo_preferences SET base_discount=$3,updated_at=$4
      WHERE market=$1 AND nm_id=$2 AND enabled=true`, [market, nmID, desiredDiscount, now]).catch(() => {});
  }
  if (desiredPrice !== null) await markManualScheduleOverride(market, String(nmID), desiredPrice, now).catch(() => {});
  const state = await wbPriceState(market);
  return {
    ok: true,
    market,
    queued: true,
    accepted: false,
    applied: false,
    queuedAt: now,
    nextSyncAt: Number(state.nextAllowedAt || 0)
  };
}

async function fetchWbPricePage(market, token, offset) {
  const data = await requestWb(
    token,
    '/api/v2/list/goods/filter?limit=' + WB_PRICE_PAGE_LIMIT + '&offset=' + Math.max(0, Number(offset) || 0),
    {},
    { market, offset: Math.max(0, Number(offset) || 0), force: false }
  );
  return Array.isArray(data?.data?.listGoods) ? data.data.listGoods : [];
}

async function fetchWbUploadDetails(market, token, uploadId) {
  const data = await requestWb(
    token,
    '/api/v2/history/goods/task?limit=1000&offset=0&uploadID=' + encodeURIComponent(String(uploadId)),
    {},
    { market, force: false }
  );
  return Array.isArray(data?.data?.historyGoods) ? data.data.historyGoods : [];
}

async function inspectWbPriceUpload(market, token, sentRows, now) {
  const candidates = sentRows.filter(row => Number(row.uploadId) > 0)
    .sort((a, b) => Number(a.sentAt || 0) - Number(b.sentAt || 0));
  const uploadId = Number(candidates[0]?.uploadId || 0);
  if (!(uploadId > 0)) return { uploadId: 0, checked: 0, errors: 0, missing: 0 };
  const targetRows = candidates.filter(row => Number(row.uploadId) === uploadId);
  const goods = await fetchWbUploadDetails(market, token, uploadId);
  const byNm = new Map(goods.map(item => [String(item?.nmID || ''), item]));
  const client = await pool.connect();
  let checked = 0, errors = 0, missing = 0;
  const errorSamples = [];
  try {
    await client.query('BEGIN');
    for (const queued of targetRows) {
      const item = byNm.get(String(queued.nmId));
      if (!item) {
        missing += 1;
        continue;
      }
      checked += 1;
      const errorText = cleanText(item?.errorText);
      if (errorText) {
        errors += 1;
        if (errorSamples.length < 5) errorSamples.push({ nmId: String(queued.nmId), error: errorText.slice(0, 240) });
        await client.query(`UPDATE wb_price_update_queue
          SET status='pending',sent_at=0,upload_id=0,last_error=$3,updated_at=$4
          WHERE market=$1 AND nm_id=$2 AND status='sent'`,
          [market, queued.nmId, errorText.slice(0, 500), now]);
        if (queued.source === 'schedule') {
          await client.query(`UPDATE wb_price_schedules SET phase=$3,last_error=$4,updated_at=$5
            WHERE market=$1 AND nm_id=$2`,
            [market, queued.nmId, isWbQuarantineError(errorText) ? 'restoring' : 'error', errorText.slice(0, 500), now]);
        }
      } else {
        await client.query(`UPDATE wb_price_update_queue
          SET status='checking',last_error='',updated_at=$3
          WHERE market=$1 AND nm_id=$2 AND status='sent'`,
          [market, queued.nmId, now]);
      }
    }
    await markWbPriceState(market, {
      nextAllowedAt: now + WB_PRICE_SLOT_MS,
      lastAttemptAt: now,
      lastSuccessAt: now,
      lastAction: errors ? 'verify-errors' : 'verify-upload',
      lastError: errors ? ('WB отклонил ' + errors + ' позиций из загрузки ' + uploadId) : '',
      readOffset: 0,
      readBuffer: []
    }, client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  return { uploadId, checked, errors, missing, errorSamples };
}

async function sendWbPriceQueue(market, token, pending, now) {
  const selected = pending.map(row => ({
    nmID: Number(row.nmId),
    updatedAt: Number(row.updatedAt || 0),
    ...(row.desiredPrice !== null ? { price: Number(row.desiredPrice) } : {}),
    ...(row.desiredDiscount !== null ? { discount: Number(row.desiredDiscount) } : {})
  })).filter(row => Number.isInteger(row.nmID) && row.nmID > 0 && (row.price !== undefined || row.discount !== undefined));
  if (!selected.length) return { sent: 0, uploadId: 0, alreadyExists: false };
  const data = await requestWb(token, '/api/v2/upload/task', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: selected.map(({ updatedAt, ...row }) => row) })
  }, { market, force: false });
  const uploadId = number(data?.data?.id || data?.data?.uploadID);
  const alreadyExists = Boolean(data?.data?.alreadyExists);
  if (!(uploadId > 0) && !alreadyExists) {
    const error = new Error('WB не вернул корректное подтверждение операции');
    error.status = 502;
    throw error;
  }
  const client = await pool.connect();
  let sent = 0;
  try {
    await client.query('BEGIN');
    for (const row of selected) {
      const updated = await client.query(`UPDATE wb_price_update_queue
        SET status='sent',sent_at=$4,upload_id=$5,last_error='',updated_at=$4
        WHERE market=$1 AND nm_id=$2 AND status='pending' AND updated_at=$3`,
        [market, row.nmID, row.updatedAt, now, uploadId]);
      sent += Number(updated.rowCount || 0);
    }
    await markWbPriceState(market, {
      nextAllowedAt: now + WB_PRICE_SLOT_MS,
      lastAttemptAt: now,
      lastSuccessAt: now,
      lastAction: 'write',
      lastError: '',
      readOffset: 0,
      readBuffer: []
    }, client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  return { sent, uploadId, alreadyExists };
}

async function saveWbPriceRead(market, state, batch, now) {
  const offset = Math.max(0, Number(state.readOffset || 0));
  const previous = offset > 0
    ? (Array.isArray(state.readBuffer) ? state.readBuffer : jsonValue(state.readBuffer, []))
    : [];
  const combined = previous.concat(batch);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (batch.length >= WB_PRICE_PAGE_LIMIT) {
      await markWbPriceState(market, {
        nextAllowedAt: now + WB_PRICE_SLOT_MS,
        lastAttemptAt: now,
        lastSuccessAt: now,
        lastAction: 'read-partial',
        lastError: '',
        readOffset: offset + WB_PRICE_PAGE_LIMIT,
        readBuffer: combined
      }, client);
      await client.query('COMMIT');
      return { complete: false, rows: combined.length };
    }

    const normalized = await normalizeWbPriceRows(market, combined);
    await client.query(`INSERT INTO wb_price_snapshots(market,payload,fetched_at,updated_at)
      VALUES($1,$2::jsonb,$3,$3)
      ON CONFLICT(market) DO UPDATE SET payload=excluded.payload,fetched_at=excluded.fetched_at,updated_at=excluded.updated_at`,
      [market, JSON.stringify({ rows: normalized }), now]);

    const [sent, schedules] = await Promise.all([wbPriceQueueRows(market, client), wbPriceSchedules(market, client)]);
    const scheduleByNm = new Map(schedules.map(row => [String(row.nmId), row]));
    const byNm = new Map(normalized.map(row => [String(row.remoteId || ''), row]));
    for (const queued of sent.filter(row => ['checking','sent'].includes(row.status))) {
      const row = byNm.get(String(queued.nmId));
      if (!row) continue;
      const priceOk = queued.desiredPrice === null || Math.abs(number(row.price) - queued.desiredPrice) < 0.000001;
      const discountOk = queued.desiredDiscount === null || clampDiscount(row.discount) === queued.desiredDiscount;
      if (priceOk && discountOk) {
        if (queued.source === 'schedule') {
          const schedule = scheduleByNm.get(String(queued.nmId));
          const window = schedule ? wbNightWindowState(schedule.startMinute, schedule.endMinute, now) : { inWindow: false, windowKey: '' };
          const keepHeld = Boolean(schedule?.enabled && window.inWindow && window.windowKey === schedule.windowKey
            && schedule.manualOverrideWindow !== window.windowKey
            && Number(queued.desiredPrice) === Number(schedule.targetPrice));
          if (keepHeld) {
            await client.query(`UPDATE wb_price_update_queue SET status='held',last_error='',updated_at=$3
              WHERE market=$1 AND nm_id=$2 AND status IN ('checking','sent') AND source='schedule'`, [market, queued.nmId, now]);
          } else {
            await client.query("DELETE FROM wb_price_update_queue WHERE market=$1 AND nm_id=$2 AND status IN ('checking','sent')", [market, queued.nmId]);
            await client.query(`UPDATE wb_price_schedules SET last_error='',phase=CASE WHEN base_price IS NULL THEN 'idle' ELSE phase END,updated_at=$3
              WHERE market=$1 AND nm_id=$2`, [market, queued.nmId, now]);
          }
        } else {
          await client.query("DELETE FROM wb_price_update_queue WHERE market=$1 AND nm_id=$2 AND status IN ('checking','sent')", [market, queued.nmId]);
        }
      } else {
        await client.query(`UPDATE wb_price_update_queue SET last_error='WB обработал загрузку, ждём отражения цены',updated_at=$3
          WHERE market=$1 AND nm_id=$2 AND status IN ('checking','sent')`, [market, queued.nmId, now]);
      }
    }

    await markWbPriceState(market, {
      nextAllowedAt: now + WB_PRICE_SLOT_MS,
      lastAttemptAt: now,
      lastSuccessAt: now,
      lastAction: 'read',
      lastError: '',
      readOffset: 0,
      readBuffer: []
    }, client);
    await client.query('COMMIT');
    return { complete: true, rows: normalized.length };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function syncWbPriceMarket(market) {
  const lockClient = await pool.connect();
  const lockName = 'millioner:wb-prices:' + market;
  let locked = false;
  try {
    const lock = await lockClient.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [lockName]);
    locked = Boolean(lock.rows[0]?.locked);
    if (!locked) return { ok: true, market, skipped: true, reason: 'already-running' };

    const now = Date.now();
    await syncWbNightSchedules(market, now);
    const state = await wbPriceState(market);
    if (Number(state.nextAllowedAt || 0) > now) {
      return { ok: true, market, skipped: true, reason: 'slot-cooldown', nextSyncAt: Number(state.nextAllowedAt) };
    }
    const token = await wbToken(market);
    if (!token) return { ok: true, market, skipped: true, reason: 'not-configured' };
    const queue = await wbPriceQueueRows(market);
    const sent = queue.filter(row => row.status === 'sent' && Number(row.uploadId) > 0);
    const pending = queue.filter(row => row.status === 'pending');
    const checking = queue.filter(row => row.status === 'checking');
    let action = sent.length ? 'verify' : pending.length ? 'write' : 'read';
    try {
      if (sent.length) {
        const result = await inspectWbPriceUpload(market, token, sent, now);
        console.info('WB price sync verify', JSON.stringify({
          market, uploadId: result.uploadId, checked: result.checked, errors: result.errors,
          missing: result.missing, errorSamples: result.errorSamples
        }));
        return { ok: result.errors === 0, market, action: 'verify', ...result, nextSyncAt: now + WB_PRICE_SLOT_MS };
      }
      if (pending.length) {
        const result = await sendWbPriceQueue(market, token, pending, now);
        console.info('WB price sync write', JSON.stringify({ market, queued: pending.length, sent: result.sent, uploadId: result.uploadId }));
        return { ok: true, market, action: 'write', ...result, nextSyncAt: now + WB_PRICE_SLOT_MS };
      }
      const batch = await fetchWbPricePage(market, token, Number(state.readOffset || 0));
      const result = await saveWbPriceRead(market, state, batch, now);
      console.info('WB price sync read', JSON.stringify({
        market, offset: Number(state.readOffset || 0), batch: batch.length, complete: result.complete,
        rows: result.rows, checking: checking.length
      }));
      return { ok: true, market, action: result.complete ? 'read' : 'read-partial', ...result, nextSyncAt: now + WB_PRICE_SLOT_MS };
    } catch (error) {
      const retryAt = Math.max(now + WB_PRICE_SLOT_MS, Number(error?.retryAt || 0));
      await markWbPriceState(market, {
        nextAllowedAt: retryAt,
        lastAttemptAt: now,
        lastAction: action + '-error',
        lastError: cleanText(error?.message || error)
      }).catch(() => {});
      if (pending.length) {
        await pool.query(`UPDATE wb_price_update_queue SET last_error=$2 WHERE market=$1 AND status='pending'`,
          [market, cleanText(error?.message || error)]).catch(() => {});
      }
      console.warn('WB price sync failed', JSON.stringify({
        market, action, status: Number(error?.status || 0),
        retryAt, error: cleanText(error?.message || error)
      }));
      return { ok: false, market, error: cleanText(error?.message || error), retryAt };
    }
  } finally {
    if (locked) await lockClient.query('SELECT pg_advisory_unlock(hashtext($1))', [lockName]).catch(() => {});
    lockClient.release();
  }
}

let wbPriceSyncTimer = null;
let wbPriceSyncRunning = false;
export function startWbPriceSyncLoop() {
  if (wbPriceSyncTimer) return;
  const run = async () => {
    if (wbPriceSyncRunning) return;
    wbPriceSyncRunning = true;
    try {
      for (const market of ['WB', 'WB2']) await syncWbPriceMarket(market);
    } catch (error) {
      console.error('WB price sync loop failed', error);
    } finally {
      wbPriceSyncRunning = false;
    }
  };
  setTimeout(run, WB_PRICE_FIRST_DELAY_MS).unref();
  wbPriceSyncTimer = setInterval(run, WB_PRICE_LOOP_MS);
  wbPriceSyncTimer.unref();
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
  return queueWbPrice(market, input);
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
    if (market === 'WB' || market === 'WB2') return res.json(await listWbPrices(market));
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

async function saveWbNightSchedules(market, input) {
  const rawIds = Array.isArray(input?.remoteIds) ? input.remoteIds : [input?.remoteId];
  const ids = [...new Set(rawIds.map(Number).filter(value => Number.isInteger(value) && value > 0))].slice(0, 1000);
  if (!ids.length) {
    const error = new Error('Не выбраны товары WB');
    error.status = 400;
    throw error;
  }
  const enabled = input?.enabled === true;
  const startMinute = timeToMinute(input?.start || '04:00');
  const endMinute = timeToMinute(input?.end || '06:00');
  const targetPrice = number(input?.price);
  if (enabled && (startMinute === null || endMinute === null || startMinute === endMinute)) {
    const error = new Error('Укажите корректное ночное окно');
    error.status = 400;
    throw error;
  }
  if (enabled && !(targetPrice > 0)) {
    const error = new Error('Ночная цена должна быть больше 0');
    error.status = 400;
    throw error;
  }

  const client = await pool.connect();
  const now = Date.now();
  try {
    await client.query('BEGIN');
    const snapshot = await wbPriceSnapshot(market, client);
    const byNm = new Map((snapshot?.rows || []).map(row => [Number(row.remoteId), row]));
    const applied = [];
    const skipped = [];
    for (const nmId of ids) {
      const row = byNm.get(nmId);
      if (!row) { skipped.push(String(nmId)); continue; }
      if (enabled && row.canEditPrice === false) { skipped.push(String(nmId)); continue; }
      if (enabled) {
        await client.query(`INSERT INTO wb_price_schedules
          (market,nm_id,enabled,start_minute,end_minute,target_price,base_price,window_key,manual_override_window,phase,last_error,updated_at)
          VALUES($1,$2,true,$3,$4,$5,NULL,'','','idle','',$6)
          ON CONFLICT(market,nm_id) DO UPDATE SET enabled=true,start_minute=excluded.start_minute,
            end_minute=excluded.end_minute,target_price=excluded.target_price,last_error='',updated_at=excluded.updated_at`,
          [market, nmId, startMinute, endMinute, targetPrice, now]);
      } else {
        await client.query(`UPDATE wb_price_schedules SET enabled=false,
          phase=CASE WHEN base_price IS NOT NULL THEN 'restoring' ELSE 'off' END,
          last_error='',updated_at=$3 WHERE market=$1 AND nm_id=$2`, [market, nmId, now]);
      }
      applied.push(String(nmId));
    }
    if (!applied.length) {
      const error = new Error(enabled ? 'Для выбранных товаров нельзя изменить общую цену' : 'У выбранных товаров нет ночного расписания');
      error.status = 409;
      throw error;
    }
    await client.query('COMMIT');
    await syncWbNightSchedules(market, now);
    const schedules = await wbPriceSchedules(market);
    const appliedSet = new Set(applied);
    return { applied, skipped, schedules: schedules.filter(row => appliedSet.has(String(row.nmId))) };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

pricesRouter.post('/market-prices/night-schedule', requireWritesEnabled, asyncRoute(async (req, res) => {
  if (req.body?.confirm !== true) return res.status(400).json({ ok: false, error: 'Подтвердите ночное расписание' });
  const market = cleanText(req.body?.market);
  if (market !== 'WB' && market !== 'WB2') return res.status(400).json({ ok: false, error: 'Ночное расписание доступно только для WB' });
  try {
    const result = await saveWbNightSchedules(market, req.body);
    return res.json({ ok: true, market, count: result.applied.length, skipped: result.skipped, schedules: result.schedules });
  } catch (error) {
    return sendPriceError(res, error);
  }
}));
