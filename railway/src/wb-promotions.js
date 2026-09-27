import express from 'express';
import { createHash } from 'node:crypto';
import { config } from './config.js';
import { pool } from './db.js';
import { credentialFor } from './connections.js';
import { asyncRoute, requireTrustedOrigin, requireWritesEnabled } from './http.js';

const WB_PROMO_API = 'https://dp-calendar-api.wildberries.ru';
const WB_PROMO_MIN_INTERVAL_MS = 650;
const WB_PROMO_SLOT_MS = 10 * 60 * 1000;
const WB_PROMO_LOOP_MS = 60 * 1000;
const WB_PROMO_FIRST_DELAY_MS = 15_000;
const WB_PROMO_LOOKAHEAD_MS = 14 * 24 * 60 * 60 * 1000;
const WB_PROMO_MAX_CAMPAIGNS = 3;
const WB_PROMO_FALLBACK_COOLDOWN_MS = 10_000;

let promoLane = Promise.resolve();
let promoNextAllowedAt = 0;
const promoCooldowns = new Map();
let promoTimer = null;
let promoRunning = false;

export const wbPromotionsRouter = express.Router();
wbPromotionsRouter.use(requireTrustedOrigin);

function cleanText(value) {
  return String(value ?? '').trim();
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
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

function withPromoLane(scope, task) {
  const run = promoLane.then(async () => {
    const now = Date.now();
    const cooldown = Number(promoCooldowns.get(scope) || 0);
    if (cooldown > now) {
      const error = new Error('WB временно ограничил календарь акций');
      error.status = 429;
      error.retryAt = cooldown;
      throw error;
    }
    const wait = Math.max(0, promoNextAllowedAt - now);
    if (wait) await sleep(wait);
    promoNextAllowedAt = Date.now() + WB_PROMO_MIN_INTERVAL_MS;
    return task();
  });
  promoLane = run.catch(() => {});
  return run;
}

async function wbToken(market) {
  const fallback = market === 'WB2' ? config.wbToken2 : market === 'WB' ? config.wbToken : '';
  return credentialFor(market, fallback);
}

async function requestPromo(token, path, options = {}, meta = {}) {
  const scope = tokenFingerprint(token);
  return withPromoLane(scope, async () => {
    const started = Date.now();
    let response;
    try {
      response = await fetch(WB_PROMO_API + path, {
        ...options,
        headers: { Accept: 'application/json', Authorization: token, ...(options.headers || {}) },
        signal: AbortSignal.timeout(30_000)
      });
    } catch (cause) {
      const error = new Error('WB акции: сеть временно недоступна');
      error.status = 502;
      error.cause = cause;
      throw error;
    }
    const raw = await response.text();
    let data = null;
    if (raw) {
      try { data = JSON.parse(raw); }
      catch {
        const error = new Error('WB акции: некорректный ответ API');
        error.status = 502;
        throw error;
      }
    }
    const retryAt = response.status === 429
      ? (retryAtFromHeaders(response.headers) || Date.now() + WB_PROMO_FALLBACK_COOLDOWN_MS)
      : 0;
    if (retryAt) promoCooldowns.set(scope, Math.max(Number(promoCooldowns.get(scope) || 0), retryAt));
    console.info('WB promo request', JSON.stringify({
      market: meta.market || '', endpoint: path.split('?')[0],
      method: cleanText(options.method || 'GET').toUpperCase(),
      status: response.status, durationMs: Date.now() - started, retryAt
    }));
    if (!response.ok || data?.error === true) {
      const detail = cleanText(data?.errorText || data?.message || data?.detail);
      const error = new Error('WB акции: HTTP ' + response.status + (detail ? ' · ' + detail : ''));
      error.status = response.status === 429 ? 429
        : response.status === 401 || response.status === 403 ? 403
        : response.status >= 400 && response.status < 500 ? 400 : 502;
      error.retryAt = retryAt;
      throw error;
    }
    if (!data || typeof data !== 'object') {
      const error = new Error('WB акции: пустой ответ API');
      error.status = 502;
      throw error;
    }
    return data;
  });
}

function isoSeconds(value) {
  return new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

async function promoPreferences(market, client = pool, onlyEnabled = false) {
  const result = await client.query(`SELECT market,nm_id AS "nmId",enabled,base_discount AS "baseDiscount",
    promotion_id AS "promotionId",promotion_name AS "promotionName",plan_price AS "planPrice",
    plan_discount AS "planDiscount",status,last_error AS "lastError",updated_at AS "updatedAt"
    FROM wb_promo_preferences WHERE market=$1 ${onlyEnabled ? 'AND enabled=true' : ''} ORDER BY nm_id`, [market]);
  return result.rows.map(row => ({
    ...row,
    nmId: String(row.nmId || ''),
    enabled: Boolean(row.enabled),
    baseDiscount: row.baseDiscount === null || row.baseDiscount === undefined ? null : Number(row.baseDiscount),
    promotionId: Number(row.promotionId || 0),
    planPrice: row.planPrice === null || row.planPrice === undefined ? null : Number(row.planPrice),
    planDiscount: row.planDiscount === null || row.planDiscount === undefined ? null : Number(row.planDiscount),
    updatedAt: Number(row.updatedAt || 0)
  }));
}

async function promoMarketState(market, client = pool) {
  const result = await client.query(`SELECT next_sync_at AS "nextSyncAt",last_sync_at AS "lastSyncAt",
    last_error AS "lastError",updated_at AS "updatedAt" FROM wb_promo_sync_state WHERE market=$1`, [market]);
  const row = result.rows[0];
  return row ? {
    nextSyncAt: Number(row.nextSyncAt || 0),
    lastSyncAt: Number(row.lastSyncAt || 0),
    lastError: cleanText(row.lastError),
    updatedAt: Number(row.updatedAt || 0)
  } : { nextSyncAt: 0, lastSyncAt: 0, lastError: '', updatedAt: 0 };
}

async function markPromoMarketState(market, values, client = pool) {
  const current = await promoMarketState(market, client);
  const now = Date.now();
  const nextSyncAt = values.nextSyncAt ?? current.nextSyncAt;
  const lastSyncAt = values.lastSyncAt ?? current.lastSyncAt;
  const lastError = values.lastError ?? current.lastError;
  await client.query(`INSERT INTO wb_promo_sync_state(market,next_sync_at,last_sync_at,last_error,updated_at)
    VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(market) DO UPDATE SET next_sync_at=excluded.next_sync_at,last_sync_at=excluded.last_sync_at,
      last_error=excluded.last_error,updated_at=excluded.updated_at`,
    [market, nextSyncAt, lastSyncAt, cleanText(lastError), now]);
}

async function priceSnapshotRows(market, client = pool) {
  const result = await client.query('SELECT payload FROM wb_price_snapshots WHERE market=$1', [market]);
  const raw = result.rows[0]?.payload;
  const payload = raw && typeof raw === 'object' ? raw : {};
  return Array.isArray(payload.rows) ? payload.rows : [];
}

async function currentQueueRow(market, nmId, client = pool) {
  const result = await client.query(`SELECT desired_discount AS "desiredDiscount",source,status
    FROM wb_price_update_queue WHERE market=$1 AND nm_id=$2`, [market, nmId]);
  return result.rows[0] || null;
}

async function queuePromoDiscount(market, nmId, discount, promotionId = 0, client = pool) {
  const now = Date.now();
  const normalized = clampDiscount(discount);
  const result = await client.query(`INSERT INTO wb_price_update_queue
    (market,nm_id,desired_price,desired_discount,status,queued_at,sent_at,upload_id,last_error,updated_at,source,promotion_id)
    VALUES($1,$2,NULL,$3,'pending',$4,0,0,'',$4,'promo',$5)
    ON CONFLICT(market,nm_id) DO UPDATE SET desired_price=NULL,desired_discount=excluded.desired_discount,
      status='pending',queued_at=excluded.queued_at,sent_at=0,upload_id=0,last_error='',
      updated_at=excluded.updated_at,source='promo',promotion_id=excluded.promotion_id
    WHERE wb_price_update_queue.source<>'manual'`,
    [market, nmId, normalized, now, Number(promotionId) || 0]);
  return Number(result.rowCount || 0) > 0;
}

function candidatePriority(candidate, now) {
  if (candidate.inAction) return 3;
  const start = Date.parse(candidate.startDateTime || '') || 0;
  const end = Date.parse(candidate.endDateTime || '') || 0;
  if (start <= now && (!end || end >= now)) return 2;
  return 1;
}

function chooseCandidate(current, next, now) {
  if (!current) return next;
  const currentPriority = candidatePriority(current, now);
  const nextPriority = candidatePriority(next, now);
  if (nextPriority !== currentPriority) return nextPriority > currentPriority ? next : current;
  const currentPrice = number(current.planPrice);
  const nextPrice = number(next.planPrice);
  if (Math.abs(nextPrice - currentPrice) > 0.000001) return nextPrice > currentPrice ? next : current;
  const currentStart = Date.parse(current.startDateTime || '') || Number.MAX_SAFE_INTEGER;
  const nextStart = Date.parse(next.startDateTime || '') || Number.MAX_SAFE_INTEGER;
  return nextStart < currentStart ? next : current;
}

function requiredDiscount(row, candidate) {
  const basePrice = number(row?.price);
  const planPrice = number(candidate?.planPrice);
  if (!(basePrice > 0) || !(planPrice > 0)) return null;
  const planDiscount = Number(candidate?.planDiscount);
  if (Number.isInteger(planDiscount) && planDiscount >= 0 && planDiscount <= 99) {
    const final = basePrice * (1 - planDiscount / 100);
    if (final <= planPrice + 0.01) return planDiscount;
  }
  return Math.max(0, Math.min(99, Math.ceil((1 - planPrice / basePrice) * 100)));
}

async function promotionCandidates(market, token, enabledIds, now) {
  if (!enabledIds.size) return { candidates: new Map(), promotions: [] };
  const startDateTime = isoSeconds(now - 24 * 60 * 60 * 1000);
  const endDateTime = isoSeconds(now + WB_PROMO_LOOKAHEAD_MS);
  const list = await requestPromo(token,
    '/api/v1/calendar/promotions?startDateTime=' + encodeURIComponent(startDateTime) +
    '&endDateTime=' + encodeURIComponent(endDateTime) + '&allPromo=false&limit=1000&offset=0',
    {}, { market });
  const promotions = (Array.isArray(list?.data?.promotions) ? list.data.promotions : [])
    .filter(item => cleanText(item?.type).toLowerCase() === 'regular')
    .filter(item => {
      const end = Date.parse(item?.endDateTime || '') || 0;
      return !end || end >= now;
    })
    .sort((a, b) => {
      const aActive = (Date.parse(a?.startDateTime || '') || 0) <= now && (Date.parse(a?.endDateTime || '') || Number.MAX_SAFE_INTEGER) >= now;
      const bActive = (Date.parse(b?.startDateTime || '') || 0) <= now && (Date.parse(b?.endDateTime || '') || Number.MAX_SAFE_INTEGER) >= now;
      if (aActive !== bActive) return aActive ? -1 : 1;
      return (Date.parse(a?.startDateTime || '') || 0) - (Date.parse(b?.startDateTime || '') || 0);
    })
    .slice(0, WB_PROMO_MAX_CAMPAIGNS);

  const candidates = new Map();
  for (const promotion of promotions) {
    const promotionId = Number(promotion?.id || 0);
    if (!(promotionId > 0)) continue;
    for (const inAction of [false, true]) {
      const data = await requestPromo(token,
        '/api/v1/calendar/promotions/nomenclatures?promotionID=' + promotionId +
        '&inAction=' + (inAction ? 'true' : 'false') + '&limit=1000&offset=0',
        {}, { market });
      for (const raw of Array.isArray(data?.data?.nomenclatures) ? data.data.nomenclatures : []) {
        const nmId = String(raw?.id || '');
        if (!enabledIds.has(nmId)) continue;
        const candidate = {
          nmId,
          promotionId,
          promotionName: cleanText(promotion?.name),
          startDateTime: cleanText(promotion?.startDateTime),
          endDateTime: cleanText(promotion?.endDateTime),
          inAction: Boolean(raw?.inAction ?? inAction),
          planPrice: number(raw?.planPrice),
          planDiscount: Number.isFinite(Number(raw?.planDiscount)) ? Math.round(Number(raw.planDiscount)) : null
        };
        candidates.set(nmId, chooseCandidate(candidates.get(nmId), candidate, now));
      }
    }
  }
  return { candidates, promotions };
}

async function updatePreference(market, nmId, values, client = pool) {
  const fields = [];
  const params = [market, nmId];
  for (const [column, value] of Object.entries(values)) {
    params.push(value);
    fields.push(column + '=$' + params.length);
  }
  if (!fields.length) return;
  await client.query('UPDATE wb_promo_preferences SET ' + fields.join(',') + ',updated_at=$' + (params.length + 1) + ' WHERE market=$1 AND nm_id=$2',
    [...params, Date.now()]);
}

async function syncWbPromotionsMarket(market) {
  const lockClient = await pool.connect();
  const lockName = 'millioner:wb-promos:' + market;
  let locked = false;
  try {
    const lock = await lockClient.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [lockName]);
    locked = Boolean(lock.rows[0]?.locked);
    if (!locked) return { ok: true, skipped: true, reason: 'already-running' };

    const now = Date.now();
    const state = await promoMarketState(market);
    if (state.nextSyncAt > now) return { ok: true, skipped: true, reason: 'slot-cooldown', nextSyncAt: state.nextSyncAt };

    const prefs = await promoPreferences(market, pool, true);
    if (!prefs.length) {
      await markPromoMarketState(market, { nextSyncAt: now + WB_PROMO_SLOT_MS, lastSyncAt: now, lastError: '' });
      return { ok: true, skipped: true, reason: 'no-enabled-products' };
    }
    const token = await wbToken(market);
    if (!token) {
      await markPromoMarketState(market, { nextSyncAt: now + WB_PROMO_SLOT_MS, lastSyncAt: now, lastError: 'Токен WB не настроен' });
      return { ok: false, reason: 'not-configured' };
    }

    try {
      const rows = await priceSnapshotRows(market);
      const byNm = new Map(rows.map(row => [String(row?.remoteId || ''), row]));
      const enabledIds = new Set(prefs.map(row => row.nmId));
      const { candidates } = await promotionCandidates(market, token, enabledIds, now);
      const joins = new Map();

      for (const pref of prefs) {
        const row = byNm.get(pref.nmId);
        if (!row) continue;
        const candidate = candidates.get(pref.nmId);
        const baseDiscount = pref.baseDiscount === null ? clampDiscount(row.discount) : clampDiscount(pref.baseDiscount);

        if (!candidate) {
          if (pref.promotionId > 0 || ['price_pending','joining','participating','restoring'].includes(pref.status)) {
            const queue = await currentQueueRow(market, pref.nmId);
            if (!queue || cleanText(queue.source) !== 'manual') {
              if (clampDiscount(row.discount) !== baseDiscount) {
                await queuePromoDiscount(market, pref.nmId, baseDiscount, 0);
                await updatePreference(market, pref.nmId, {
                  status: 'restoring', promotion_id: 0, promotion_name: '', plan_price: null, plan_discount: null, last_error: ''
                });
              } else {
                await updatePreference(market, pref.nmId, {
                  status: 'idle', promotion_id: 0, promotion_name: '', plan_price: null, plan_discount: null, last_error: ''
                });
              }
            }
          } else if (pref.status !== 'idle') {
            await updatePreference(market, pref.nmId, { status: 'idle', last_error: '' });
          }
          continue;
        }

        const planPrice = number(candidate.planPrice);
        if (!(planPrice > 0)) continue;
        const currentFinal = number(row.finalPrice) || (number(row.price) * (1 - clampDiscount(row.discount) / 100));
        if (candidate.inAction) {
          await updatePreference(market, pref.nmId, {
            status: 'participating', promotion_id: candidate.promotionId, promotion_name: candidate.promotionName,
            plan_price: planPrice, plan_discount: candidate.planDiscount, last_error: ''
          });
          continue;
        }

        if (currentFinal <= planPrice + 0.01) {
          if (!joins.has(candidate.promotionId)) joins.set(candidate.promotionId, { promotion: candidate, ids: [] });
          joins.get(candidate.promotionId).ids.push(Number(pref.nmId));
          await updatePreference(market, pref.nmId, {
            status: 'joining', promotion_id: candidate.promotionId, promotion_name: candidate.promotionName,
            plan_price: planPrice, plan_discount: candidate.planDiscount, last_error: ''
          });
          continue;
        }

        const discount = requiredDiscount(row, candidate);
        if (discount === null) continue;
        const queued = await queuePromoDiscount(market, pref.nmId, discount, candidate.promotionId);
        await updatePreference(market, pref.nmId, {
          status: queued ? 'price_pending' : 'manual_pending',
          promotion_id: candidate.promotionId, promotion_name: candidate.promotionName,
          plan_price: planPrice, plan_discount: discount, last_error: ''
        });
      }

      for (const { promotion, ids } of joins.values()) {
        if (!ids.length) continue;
        const data = await requestPromo(token, '/api/v1/calendar/promotions/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: { promotionID: promotion.promotionId, uploadNow: true, nomenclatures: ids } })
        }, { market });
        const uploadId = number(data?.data?.uploadID);
        console.info('WB promo join queued', JSON.stringify({ market, promotionId: promotion.promotionId, products: ids.length, uploadId }));
      }

      await markPromoMarketState(market, { nextSyncAt: now + WB_PROMO_SLOT_MS, lastSyncAt: now, lastError: '' });
      return { ok: true, market, enabled: prefs.length, candidates: candidates.size };
    } catch (error) {
      const retryAt = Math.max(now + WB_PROMO_SLOT_MS, Number(error?.retryAt || 0));
      await markPromoMarketState(market, { nextSyncAt: retryAt, lastSyncAt: now, lastError: cleanText(error?.message || error) }).catch(() => {});
      console.warn('WB promo sync failed', JSON.stringify({
        market, status: Number(error?.status || 0), retryAt, error: cleanText(error?.message || error)
      }));
      return { ok: false, market, error: cleanText(error?.message || error), retryAt };
    }
  } finally {
    if (locked) await lockClient.query('SELECT pg_advisory_unlock(hashtext($1))', [lockName]).catch(() => {});
    lockClient.release();
  }
}

export async function decorateWbPromotionRows(market, rows) {
  const [prefs, state] = await Promise.all([promoPreferences(market), promoMarketState(market)]);
  const byNm = new Map(prefs.map(pref => [pref.nmId, pref]));
  return {
    rows: rows.map(raw => {
      const row = { ...raw };
      const pref = byNm.get(String(row.remoteId || ''));
      row.promoEnabled = Boolean(pref?.enabled);
      row.promoStatus = cleanText(pref?.status);
      row.promoName = cleanText(pref?.promotionName);
      row.promoPlanPrice = pref?.planPrice ?? null;
      row.promoPlanDiscount = pref?.planDiscount ?? null;
      row.promoError = cleanText(pref?.lastError);
      return row;
    }),
    promoNextSyncAt: state.nextSyncAt,
    promoLastSyncAt: state.lastSyncAt,
    promoSyncError: state.lastError
  };
}

wbPromotionsRouter.post('/market-prices/promo', requireWritesEnabled, asyncRoute(async (req, res) => {
  if (req.body?.confirm !== true) return res.status(400).json({ ok: false, error: 'Нужно подтверждение изменения режима акций' });
  const market = cleanText(req.body?.market);
  if (market !== 'WB' && market !== 'WB2') return res.status(400).json({ ok: false, error: 'Акции доступны только для WB' });
  const nmId = Number(req.body?.remoteId);
  if (!Number.isInteger(nmId) || nmId <= 0) return res.status(400).json({ ok: false, error: 'Некорректный nmID WB' });
  const enabled = req.body?.enabled === true;

  const rows = await priceSnapshotRows(market);
  const row = rows.find(item => Number(item?.remoteId) === nmId);
  if (!row) return res.status(409).json({ ok: false, error: 'Товар не найден в последнем снимке цен WB' });

  const existing = (await promoPreferences(market)).find(item => Number(item.nmId) === nmId);
  const queue = await currentQueueRow(market, nmId);
  const effectiveDiscount = queue?.desiredDiscount !== null && queue?.desiredDiscount !== undefined
    ? clampDiscount(queue.desiredDiscount)
    : clampDiscount(row.discount);
  const baseDiscount = existing?.baseDiscount === null || existing?.baseDiscount === undefined
    ? effectiveDiscount
    : clampDiscount(existing.baseDiscount);
  const now = Date.now();

  await pool.query(`INSERT INTO wb_promo_preferences
    (market,nm_id,enabled,base_discount,promotion_id,promotion_name,plan_price,plan_discount,status,last_error,updated_at)
    VALUES($1,$2,$3,$4,0,'',NULL,NULL,$5,'',$6)
    ON CONFLICT(market,nm_id) DO UPDATE SET enabled=excluded.enabled,
      base_discount=CASE WHEN excluded.enabled AND NOT wb_promo_preferences.enabled THEN excluded.base_discount ELSE wb_promo_preferences.base_discount END,
      status=excluded.status,last_error='',updated_at=excluded.updated_at`,
    [market, nmId, enabled, enabled ? effectiveDiscount : baseDiscount, enabled ? 'idle' : 'off', now]);

  if (!enabled && effectiveDiscount !== baseDiscount && cleanText(queue?.source) !== 'manual') {
    await queuePromoDiscount(market, nmId, baseDiscount, 0);
  }
  await pool.query(`INSERT INTO wb_promo_sync_state(market,next_sync_at,last_sync_at,last_error,updated_at)
    VALUES($1,0,0,'',$2)
    ON CONFLICT(market) DO UPDATE SET next_sync_at=0,last_error='',updated_at=excluded.updated_at`, [market, now]);

  return res.json({ ok: true, market, remoteId: String(nmId), enabled, baseDiscount, queuedRestore: !enabled && effectiveDiscount !== baseDiscount });
}));

export function startWbPromotionLoop() {
  if (promoTimer) return;
  const run = async () => {
    if (promoRunning) return;
    promoRunning = true;
    try {
      for (const market of ['WB', 'WB2']) await syncWbPromotionsMarket(market);
    } catch (error) {
      console.error('WB promo loop failed', error);
    } finally {
      promoRunning = false;
    }
  };
  setTimeout(run, WB_PROMO_FIRST_DELAY_MS).unref();
  promoTimer = setInterval(run, WB_PROMO_LOOP_MS);
  promoTimer.unref();
}
