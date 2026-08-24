import express from 'express';
import { pool } from './db.js';
import { config } from './config.js';
import { credentialFor } from './connections.js';
import { asyncRoute } from './http.js';

const ADVERT_API = 'https://advert-api.wildberries.ru';
const CONTENT_API = 'https://content-api.wildberries.ru';
// WB order sync starts immediately and performs the heaviest import after a deploy.
// Run promotion sync in the quiet half of the 10-minute cycle so both jobs do not
// hit the seller-wide WB limiter at the same time.
const CHECK_MS = 10 * 60 * 1000;
const STARTUP_DELAY_MS = 2 * 60 * 1000;
const RATE_LIMIT_TTL_MS = 60 * 1000;
const MAX_AUTO_RETRY_MS = 2 * 60 * 1000;
const GENERAL_REQUEST_INTERVAL_MS = 1000;
const FULLSTATS_REQUEST_INTERVAL_MS = 21 * 1000;
const CONTENT_REQUEST_INTERVAL_MS = 700;
const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;

const refreshInFlight = new Map();
const requestQueues = new Map();
const requestWindows = new Map();
const catalogCache = new Map();
const verifiedSnapshots = new Set();
const MANAGEABLE_CAMPAIGN_STATUSES = new Set([4, 9, 11]);

export const wbAdsRouter = express.Router();

function market(value) {
  const normalized = String(value || 'WB').toUpperCase();
  return normalized === 'WB1' ? 'WB' : normalized;
}

function allowed(value) {
  return /^WB(?:[2-9]\d*|1\d+)?$/.test(value);
}

function localDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Qyzylorda',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const value = type => parts.find(part => part.type === type)?.value || '';
  return value('year') + '-' + value('month') + '-' + value('day');
}

async function tokenFor(marketName) {
  return credentialFor(marketName, marketName === 'WB2' ? config.wbToken2 : config.wbToken);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function retryAfterMs(response) {
  const raw = String(
    response.headers.get('x-ratelimit-retry')
    || response.headers.get('retry-after')
    || response.headers.get('x-ratelimit-reset')
    || '',
  ).trim();
  if (!raw) return RATE_LIMIT_TTL_MS;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(1000, seconds * 1000 + 250);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(1000, date - Date.now() + 250) : RATE_LIMIT_TTL_MS;
}

function requestInterval(url) {
  if (url.includes('/adv/v3/fullstats')) return { key: 'stats', interval: FULLSTATS_REQUEST_INTERVAL_MS };
  if (url.startsWith(CONTENT_API)) return { key: 'content', interval: CONTENT_REQUEST_INTERVAL_MS };
  return { key: 'general', interval: GENERAL_REQUEST_INTERVAL_MS };
}

async function request(url, token, { method = 'GET', body } = {}) {
  // The queue is keyed by token so two configured cabinets cannot accidentally
  // exceed the same WB account limit when the same token is reused.
  const queueKey = String(token);
  const previous = requestQueues.get(queueKey) || Promise.resolve();
  const queued = previous.catch(() => {}).then(async () => {
    const window = requestWindows.get(queueKey) || { cooldownUntil: 0, nextAt: {} };
    const now = Date.now();
    if (window.cooldownUntil > now) {
      const error = new Error('WB API cooldown');
      error.retryAt = window.cooldownUntil;
      throw error;
    }

    const limiter = requestInterval(url);
    const waitUntil = Number(window.nextAt[limiter.key] || 0);
    if (waitUntil > now) await delay(waitUntil - now);
    window.nextAt[limiter.key] = Date.now() + limiter.interval;
    requestWindows.set(queueKey, window);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      try {
        const response = await fetch(url, {
          method,
          headers: {
            Accept: 'application/json',
            Authorization: token,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });
        const text = await response.text();
        let data = {};
        try {
          data = text ? JSON.parse(text) : {};
        } catch {}
        if (!response.ok) {
          const error = new Error(data?.message || data?.error || data?.detail || ('WB API HTTP ' + response.status));
          error.status = response.status;
          if (response.status === 429) {
            const waitMs = retryAfterMs(response);
            window.cooldownUntil = Date.now() + waitMs;
            requestWindows.set(queueKey, window);
            error.retryAt = window.cooldownUntil;
            error.endpoint = new URL(url).pathname;
            error.retryAfterMs = waitMs;
            if (attempt === 0 && waitMs <= MAX_AUTO_RETRY_MS) {
              await delay(waitMs);
              window.cooldownUntil = 0;
              requestWindows.set(queueKey, window);
              continue;
            }
          }
          throw error;
        }
        window.cooldownUntil = 0;
        requestWindows.set(queueKey, window);
        return data;
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error('WB API retry failed');
  });
  requestQueues.set(queueKey, queued.catch(() => {}));
  return queued;
}

function campaignId(row) {
  return Number(row?.advertId ?? row?.id ?? row?.advert_id ?? 0);
}

function campaignRows(data) {
  const rows = Array.isArray(data)
    ? data
    : Array.isArray(data?.adverts)
      ? data.adverts
      : Array.isArray(data?.items)
        ? data.items
        : Array.isArray(data?.data)
          ? data.data
          : [];
  return rows.flatMap(row => Array.isArray(row?.advert_list)
    ? row.advert_list.map(item => ({
      ...row,
      ...item,
      status: item?.status ?? item?.statusId ?? row?.status ?? row?.statusId,
      payment_type: item?.payment_type ?? row?.payment_type,
    }))
    : row);
}

function active(row) {
  const status = Number(row?.status ?? row?.statusId ?? row?.status_id);
  return status === 9 || String(row?.status || '').toUpperCase() === 'ACTIVE';
}

function statMetric(row, day, fields) {
  const stats = Array.isArray(row?.stats)
    ? row.stats
    : Array.isArray(row?.dailyStats)
      ? row.dailyStats
      : Array.isArray(row?.days)
        ? row.days
        : [];
  const dailyValue = stats
    .filter(item => !item?.date || String(item.date).slice(0, 10) === day)
    .reduce((sum, item) => {
      const value = fields.map(field => item?.[field]).find(candidate => Number.isFinite(Number(candidate)));
      return sum + Math.max(0, Number(value) || 0);
    }, 0);
  if (stats.length) return dailyValue;
  const value = fields.map(field => row?.[field]).find(candidate => Number.isFinite(Number(candidate)));
  return Math.max(0, Number(value) || 0);
}

function spend(row, day) {
  return statMetric(row, day, ['sum', 'spend', 'expenses', 'cost']);
}

function collectNmIds(value, output = new Set(), depth = 0) {
  if (value == null || depth > 8) return output;
  if (Array.isArray(value)) {
    for (const item of value) collectNmIds(item, output, depth + 1);
    return output;
  }
  if (typeof value !== 'object') return output;
  for (const [key, item] of Object.entries(value)) {
    if (/^(nm_?id|nmID)$/i.test(key)) {
      const id = Number(item);
      if (id > 0) output.add(id);
      continue;
    }
    if (/^(nms|nm_?ids)$/i.test(key) && Array.isArray(item)) {
      for (const candidate of item) {
        const id = Number(typeof candidate === 'object' ? candidate?.nmId ?? candidate?.nmID ?? candidate?.nm_id : candidate);
        if (id > 0) output.add(id);
      }
      continue;
    }
    collectNmIds(item, output, depth + 1);
  }
  return output;
}

async function cardCatalog(marketName, token) {
  const cached = catalogCache.get(marketName);
  if (cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.cards;

  const cards = new Map();
  let cursor = { limit: 100 };
  for (let page = 0; page < 100; page += 1) {
    const data = await request(CONTENT_API + '/content/v2/get/cards/list', token, {
      method: 'POST',
      body: {
        settings: {
          sort: { ascending: true },
          cursor,
          filter: { withPhoto: -1 },
        },
      },
    });
    const rows = Array.isArray(data?.cards) ? data.cards : [];
    for (const row of rows) {
      const nmId = Number(row?.nmID ?? row?.nmId ?? row?.nm_id ?? 0);
      if (!nmId) continue;
      cards.set(nmId, {
        nmId,
        title: String(row?.title || '').trim(),
        vendorCode: String(row?.vendorCode || '').trim(),
      });
    }
    const next = data?.cursor || {};
    if (rows.length < 100 || !next.updatedAt || !next.nmID) break;
    cursor = { limit: 100, updatedAt: next.updatedAt, nmID: next.nmID };
  }
  catalogCache.set(marketName, { at: Date.now(), cards });
  return cards;
}

function campaignName(row, statRow, cards) {
  const nmIds = [...collectNmIds(row)];
  collectNmIds(statRow, new Set(nmIds));
  const allNmIds = [...new Set([...nmIds, ...collectNmIds(statRow)])];
  const matched = allNmIds.map(id => cards.get(id)).filter(Boolean);
  const titles = [...new Set(matched.map(card => card.title).filter(Boolean))];
  const vendorCodes = [...new Set(matched.map(card => card.vendorCode).filter(Boolean))];
  const apiName = String(
    row?.campaignName
    || row?.campaign_name
    || row?.name
    || row?.advertName
    || row?.advert_name
    || '',
  ).trim();
  // A product title is not a campaign title. Keep products in productTitles and
  // use a neutral ID fallback until WB returns the actual campaign name.
  const title = apiName || ('Кампания ' + campaignId(row));
  return { title, nmIds: allNmIds, productTitles: titles, vendorCodes };
}

async function fetchCampaigns(marketName) {
  if (!allowed(marketName)) throw new Error('Неверный кабинет WB');
  const token = await tokenFor(marketName);
  if (!token) throw new Error((marketName === 'WB2' ? 'WB_TOKEN_2' : 'WB_TOKEN') + ' не настроен');

  // This detailed endpoint returns IDs, statuses and real campaign names in one
  // call. Avoid a separate count request: it adds load but contains no names.
  const list = campaignRows(await request(
    ADVERT_API + '/api/advert/v2/adverts?statuses=4,9,11',
    token,
  )).filter(row => MANAGEABLE_CAMPAIGN_STATUSES.has(Number(row?.status ?? row?.statusId ?? 0)));
  const day = localDate();
  const statIds = [...new Set(list
    .filter(row => MANAGEABLE_CAMPAIGN_STATUSES.has(Number(row?.status ?? row?.statusId ?? 0)))
    .map(campaignId)
    .filter(Boolean))];
  const stats = [];

  for (let offset = 0; offset < statIds.length; offset += 50) {
    const ids = statIds.slice(offset, offset + 50);
    stats.push(...campaignRows(await request(
      ADVERT_API + '/adv/v3/fullstats?ids=' + ids.join(',') + '&beginDate=' + day + '&endDate=' + day,
      token,
    )));
  }

  let cards = new Map();
  try {
    cards = await cardCatalog(marketName, token);
  } catch (error) {
    // Campaign limits and auto-stop must keep working even if WB Content is temporarily unavailable.
    console.warn('WB ads card catalog unavailable', marketName, String(error?.message || error));
  }

  const byId = new Map(stats.map(row => [campaignId(row), row]));
  const campaigns = list.map(row => {
    const statRow = byId.get(campaignId(row));
    const label = campaignName(row, statRow, cards);
    return {
      id: campaignId(row),
      name: label.title,
      status: Number(row?.status ?? row?.statusId ?? 0),
      paymentType: String(row?.payment_type || row?.paymentType || ''),
      todaySpend: spend(statRow, day),
      orders: statMetric(statRow, day, ['orders']),
      orderedItems: statMetric(statRow, day, ['shks', 'orders']),
      orderRevenue: statMetric(statRow, day, ['sum_price', 'revenue']),
      views: statMetric(statRow, day, ['views']),
      clicks: statMetric(statRow, day, ['clicks']),
      nmIds: label.nmIds,
      productTitles: label.productTitles,
      vendorCodes: label.vendorCodes,
    };
  });
  const unique = new Map();
  for (const row of campaigns) {
    const existing = unique.get(row.id);
    if (!existing) {
      unique.set(row.id, row);
      continue;
    }
    unique.set(row.id, {
      ...existing,
      ...row,
      nmIds: [...new Set([...(existing.nmIds || []), ...(row.nmIds || [])])],
      productTitles: [...new Set([...(existing.productTitles || []), ...(row.productTitles || [])])],
      vendorCodes: [...new Set([...(existing.vendorCodes || []), ...(row.vendorCodes || [])])],
    });
  }
  return [...unique.values()];
}

async function rules(marketName) {
  const result = await pool.query(
    'SELECT campaign_id AS "campaignId",daily_limit AS "dailyLimit",enabled,last_checked_at AS "lastCheckedAt",last_action_at AS "lastActionAt",last_action_error AS "lastActionError" FROM wb_ad_limits WHERE market=$1',
    [marketName],
  );
  return new Map(result.rows.map(row => [Number(row.campaignId), row]));
}

async function storedSnapshot(marketName) {
  const result = await pool.query(
    'SELECT payload,updated_at AS "updatedAt",last_error AS "lastError",next_attempt_at AS "nextAttemptAt" FROM wb_ads_snapshots WHERE market=$1',
    [marketName],
  );
  const row = result.rows[0];
  if (!row) return null;
  const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
  return {
    market: marketName,
    day: String(payload.day || localDate()),
    campaigns: Array.isArray(payload.campaigns) ? payload.campaigns : [],
    updatedAt: Number(row.updatedAt || 0),
    lastError: String(row.lastError || ''),
    nextAttemptAt: Number(row.nextAttemptAt || 0),
  };
}

async function saveSnapshot(marketName, value) {
  const now = Date.now();
  await pool.query(
    `INSERT INTO wb_ads_snapshots(market,payload,updated_at,last_error,next_attempt_at)
     VALUES($1,$2,$3,'',0)
     ON CONFLICT(market) DO UPDATE
     SET payload=EXCLUDED.payload,updated_at=EXCLUDED.updated_at,last_error='',next_attempt_at=0`,
    [marketName, JSON.stringify(value), now],
  );
  return { ...value, updatedAt: now, lastError: '', nextAttemptAt: 0 };
}

async function setStoredCampaignStatus(marketName, campaignIdValue, status) {
  const snapshot = await storedSnapshot(marketName);
  if (!snapshot) return;
  const campaigns = snapshot.campaigns.map(row => Number(row.id) === campaignIdValue
    ? { ...row, status }
    : row);
  await saveSnapshot(marketName, {
    market: marketName,
    day: snapshot.day,
    campaigns,
  });
}

async function saveRefreshError(marketName, error) {
  const message = String(error?.message || error || 'Не удалось обновить рекламу').slice(0, 500);
  const retryAt = Math.max(Number(error?.retryAt || 0), Date.now() + (/429|cooldown|too many requests/i.test(message) ? RATE_LIMIT_TTL_MS : CHECK_MS));
  await pool.query(
    `INSERT INTO wb_ads_snapshots(market,payload,updated_at,last_error,next_attempt_at)
     VALUES($1,'{}'::jsonb,0,$2,$3)
     ON CONFLICT(market) DO UPDATE SET last_error=EXCLUDED.last_error,next_attempt_at=EXCLUDED.next_attempt_at`,
    [marketName, message, retryAt],
  );
}

async function refreshMarket(marketName) {
  if (refreshInFlight.has(marketName)) return refreshInFlight.get(marketName);
  const work = (async () => {
    const previous = await storedSnapshot(marketName);
    const remainingBackoff = Number(previous?.nextAttemptAt || 0) - Date.now();
    // Ignore obsolete ten-minute cooldowns saved by older deployments. Current
    // versions only persist the short retry period WB returns in rate-limit headers.
    if (remainingBackoff > 0 && remainingBackoff <= RATE_LIMIT_TTL_MS) return previous;
    try {
      const campaigns = await fetchCampaigns(marketName);
      const saved = await saveSnapshot(marketName, { market: marketName, day: localDate(), campaigns });
      if (!verifiedSnapshots.has(marketName)) {
        verifiedSnapshots.add(marketName);
        console.info('WB ads snapshot updated', marketName, campaigns.map(row => ({ id: row.id, name: row.name, status: row.status })));
      }
      return saved;
    } catch (error) {
      await saveRefreshError(marketName, error);
      throw error;
    }
  })();
  refreshInFlight.set(marketName, work);
  try {
    return await work;
  } finally {
    refreshInFlight.delete(marketName);
  }
}

async function publicSnapshot(marketName) {
  const [snapshot, configured] = await Promise.all([storedSnapshot(marketName), rules(marketName)]);
  const value = snapshot || {
    market: marketName,
    day: localDate(),
    campaigns: [],
    updatedAt: 0,
    lastError: '',
    nextAttemptAt: 0,
  };
  return {
    ...value,
    cached: true,
    waitingForFirstSync: !value.updatedAt,
    campaigns: value.campaigns
      .filter(row => MANAGEABLE_CAMPAIGN_STATUSES.has(Number(row.status)))
      .map(row => ({
        ...row,
        rule: configured.get(Number(row.id)) || { dailyLimit: 0, enabled: false },
      })),
  };
}

wbAdsRouter.get('/promotion/campaigns', asyncRoute(async (req, res) => {
  // Important: this browser-facing route never calls WB. It only reads Railway/Postgres.
  res.json({ ok: true, ...await publicSnapshot(market(req.query.market)) });
}));

wbAdsRouter.put('/promotion/limits/:market/:campaignId', asyncRoute(async (req, res) => {
  const marketName = market(req.params.market);
  const id = Math.max(0, Number(req.params.campaignId) || 0);
  const limit = Math.max(0, Number(req.body?.dailyLimit) || 0);
  const enabled = Boolean(req.body?.enabled);
  if (!allowed(marketName) || !id) throw new Error('Неверная кампания');
  await pool.query(
    `INSERT INTO wb_ad_limits(market,campaign_id,daily_limit,enabled,updated_at)
     VALUES($1,$2,$3,$4,$5)
     ON CONFLICT(market,campaign_id)
     DO UPDATE SET daily_limit=excluded.daily_limit,enabled=excluded.enabled,updated_at=excluded.updated_at`,
    [marketName, id, limit, enabled, Date.now()],
  );
  res.json({ ok: true, market: marketName, campaignId: id, dailyLimit: limit, enabled });
}));

wbAdsRouter.post('/promotion/actions/:market/:campaignId', asyncRoute(async (req, res) => {
  const marketName = market(req.params.market);
  const id = Math.max(0, Number(req.params.campaignId) || 0);
  const action = String(req.body?.action || '').toLowerCase();
  if (!allowed(marketName) || !id || !['pause', 'start', 'stop'].includes(action)) {
    const error = new Error('Неверная команда кампании');
    error.status = 400;
    throw error;
  }

  const snapshot = await storedSnapshot(marketName);
  const campaign = snapshot?.campaigns.find(row => Number(row.id) === id);
  const currentStatus = Number(campaign?.status || 0);
  const canPause = action === 'pause' && currentStatus === 9;
  const canStart = action === 'start' && [4, 11].includes(currentStatus);
  const canStop = action === 'stop' && [4, 9, 11].includes(currentStatus);
  if (!canPause && !canStart && !canStop) {
    const error = new Error('Статус кампании уже изменился. Обновите раздел рекламы.');
    error.status = 409;
    throw error;
  }

  const token = await tokenFor(marketName);
  if (!token) throw new Error((marketName === 'WB2' ? 'WB_TOKEN_2' : 'WB_TOKEN') + ' не настроен');
  const actionPath = action === 'pause' ? '/adv/v0/pause' : action === 'start' ? '/adv/v0/start' : '/adv/v0/stop';
  await request(ADVERT_API + actionPath + '?id=' + encodeURIComponent(id), token);
  const status = action === 'pause' ? 11 : action === 'start' ? 9 : 7;
  await setStoredCampaignStatus(marketName, id, status);
  res.json({ ok: true, market: marketName, campaignId: id, action, status });
}));

async function enforce(marketName, snapshot) {
  const configured = await rules(marketName);
  const enabled = [...configured.values()].filter(row => row.enabled && Number(row.dailyLimit) > 0);
  if (!enabled.length) return;
  const byId = new Map((snapshot?.campaigns || []).map(row => [Number(row.id), row]));
  const token = await tokenFor(marketName);
  for (const rule of enabled) {
    const row = byId.get(Number(rule.campaignId));
    if (!row || !active(row) || Number(row.todaySpend) < Number(rule.dailyLimit)) continue;
    try {
      await request(ADVERT_API + '/adv/v0/pause?id=' + encodeURIComponent(row.id), token);
      await pool.query(
        "UPDATE wb_ad_limits SET last_checked_at=$3,last_action_at=$3,last_action_error='' WHERE market=$1 AND campaign_id=$2",
        [marketName, row.id, Date.now()],
      );
    } catch (error) {
      await pool.query(
        'UPDATE wb_ad_limits SET last_checked_at=$3,last_action_error=$4 WHERE market=$1 AND campaign_id=$2',
        [marketName, row.id, Date.now(), String(error?.message || error).slice(0, 500)],
      );
    }
  }
}

export function startWbAdsLimitLoop() {
  const run = async () => {
    // Cabinets run sequentially. If one is throttled, it cannot cause a burst on the other one.
    for (const marketName of ['WB', 'WB2']) {
      try {
        const snapshot = await refreshMarket(marketName);
        await enforce(marketName, snapshot);
      } catch (error) {
        console.error('WB ads refresh', marketName, error);
      }
    }
  };
  const startupTimer = setTimeout(() => void run(), STARTUP_DELAY_MS);
  startupTimer.unref();
  const timer = setInterval(() => void run(), CHECK_MS);
  timer.unref();
  return timer;
}
