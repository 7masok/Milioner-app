import express from 'express';
import { pool } from './db.js';
import { config } from './config.js';
import { credentialFor } from './connections.js';
import { asyncRoute } from './http.js';

const API = 'https://advert-api.wildberries.ru';
const CHECK_MS = 5 * 60 * 1000;
const STARTUP_DELAY_MS = 60 * 1000;
const SNAPSHOT_TTL_MS = 10 * 60 * 1000;
const CAMPAIGN_TTL_MS = 5 * 60 * 1000;
const RATE_LIMIT_TTL_MS = 10 * 60 * 1000;
const GENERAL_REQUEST_INTERVAL_MS = 1000;
const FULLSTATS_REQUEST_INTERVAL_MS = 21 * 1000;

const inFlight = new Map();
const snapshotCache = new Map();
const snapshotInFlight = new Map();
const snapshotRetryTimers = new Map();
const campaignsCache = new Map();
const campaignsInFlight = new Map();
const requestQueues = new Map();
const requestWindows = new Map();

export const wbAdsRouter = express.Router();

function market(value) {
  const m = String(value || 'WB').toUpperCase();
  return m === 'WB1' ? 'WB' : m;
}

function allowed(m) {
  return /^WB(?:[2-9]\d*|1\d+)?$/.test(m);
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
  const raw = String(response.headers.get('retry-after') || '').trim();
  if (!raw) return RATE_LIMIT_TTL_MS;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(RATE_LIMIT_TTL_MS, seconds * 1000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(RATE_LIMIT_TTL_MS, date - Date.now()) : RATE_LIMIT_TTL_MS;
}

async function request(marketName, url, token, { method = 'GET', body } = {}) {
  // Queue by token, not by browser or route. WB1/WB2 also share the queue if the same token was entered twice.
  const queueKey = String(token);
  const previous = requestQueues.get(queueKey) || Promise.resolve();
  const queued = previous.catch(() => {}).then(async () => {
    const window = requestWindows.get(queueKey) || { nextAt: 0, nextStatsAt: 0, cooldownUntil: 0 };
    const now = Date.now();
    if (window.cooldownUntil > now) throw new Error('WB API cooldown');

    const fullstats = url.includes('/adv/v3/fullstats');
    const waitUntil = Math.max(window.nextAt, fullstats ? window.nextStatsAt : 0);
    if (waitUntil > now) await delay(waitUntil - now);

    const startedAt = Date.now();
    window.nextAt = startedAt + GENERAL_REQUEST_INTERVAL_MS;
    if (fullstats) window.nextStatsAt = startedAt + FULLSTATS_REQUEST_INTERVAL_MS;
    requestWindows.set(queueKey, window);

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
        if (response.status === 429) {
          window.cooldownUntil = Math.max(window.cooldownUntil, Date.now() + retryAfterMs(response));
          requestWindows.set(queueKey, window);
        }
        const error = new Error(data?.message || data?.error || data?.detail || ('WB API HTTP ' + response.status));
        error.status = response.status;
        throw error;
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
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

function spend(row, day) {
  const stats = Array.isArray(row?.stats)
    ? row.stats
    : Array.isArray(row?.dailyStats)
      ? row.dailyStats
      : Array.isArray(row?.days)
        ? row.days
        : [];
  return stats
    .filter(item => !item?.date || String(item.date).slice(0, 10) === day)
    .reduce((sum, item) => sum + Math.max(0, Number(item?.sum ?? item?.spend ?? item?.expenses ?? item?.cost ?? 0) || 0), 0);
}

async function campaigns(marketName) {
  if (!allowed(marketName)) throw new Error('Неверный кабинет WB');
  const cached = campaignsCache.get(marketName);
  if (cached && Date.now() - cached.at < CAMPAIGN_TTL_MS) return cached.value;
  if (campaignsInFlight.has(marketName)) return campaignsInFlight.get(marketName);

  const work = (async () => {
    const token = await tokenFor(marketName);
    if (!token) throw new Error((marketName === 'WB2' ? 'WB_TOKEN_2' : 'WB_TOKEN') + ' не настроен');

    const list = campaignRows(await request(
      marketName,
      API + '/api/advert/v2/adverts?statuses=4,7,8,9,11',
      token,
    ));
    const day = localDate();
    const statIds = [...new Set(list
      .filter(row => [7, 9, 11].includes(Number(row?.status ?? row?.statusId ?? 0)))
      .map(campaignId)
      .filter(Boolean))];
    const stats = [];

    for (let offset = 0; offset < statIds.length; offset += 50) {
      const ids = statIds.slice(offset, offset + 50);
      try {
        stats.push(...campaignRows(await request(
          marketName,
          API + '/adv/v3/fullstats?ids=' + ids.join(',') + '&beginDate=' + day + '&endDate=' + day,
          token,
        )));
      } catch (error) {
        console.warn('WB ads stats unavailable', marketName, String(error?.message || error));
        break;
      }
    }

    const byId = new Map(stats.map(row => [campaignId(row), row]));
    const value = list.map(row => ({
      id: campaignId(row),
      name: String(row?.campaignName || row?.campaign_name || row?.name || row?.advertName || ('Кампания ' + campaignId(row))),
      status: Number(row?.status ?? row?.statusId ?? 0),
      paymentType: String(row?.payment_type || row?.paymentType || ''),
      todaySpend: spend(byId.get(campaignId(row)), day),
      raw: row,
    }));
    campaignsCache.set(marketName, { at: Date.now(), value });
    return value;
  })();

  campaignsInFlight.set(marketName, work);
  try {
    return await work;
  } finally {
    campaignsInFlight.delete(marketName);
  }
}

async function rules(marketName) {
  const result = await pool.query(
    'SELECT campaign_id AS "campaignId",daily_limit AS "dailyLimit",enabled,last_checked_at AS "lastCheckedAt",last_action_at AS "lastActionAt",last_action_error AS "lastActionError" FROM wb_ad_limits WHERE market=$1',
    [marketName],
  );
  return new Map(result.rows.map(row => [Number(row.campaignId), row]));
}

function scheduleSnapshotRetry(marketName) {
  if (snapshotRetryTimers.has(marketName)) return;
  const timer = setTimeout(() => {
    snapshotRetryTimers.delete(marketName);
    snapshotCache.delete(marketName);
    campaignsCache.delete(marketName);
    void snapshot(marketName).catch(() => {});
  }, RATE_LIMIT_TTL_MS);
  timer.unref();
  snapshotRetryTimers.set(marketName, timer);
}

function publicAdsError(error) {
  const message = String(error?.message || error || '');
  return /limited by global limiter|too many requests|http 429|api cooldown/i.test(message)
    ? 'WB временно ограничил рекламный API. Склад остановил запросы на 10 минут и попробует снова сам.'
    : message || 'Не удалось получить кампании WB';
}

async function snapshot(marketName) {
  const now = Date.now();
  const cached = snapshotCache.get(marketName);
  if (cached && now - cached.at < (cached.error ? RATE_LIMIT_TTL_MS : SNAPSHOT_TTL_MS)) {
    if (cached.error) throw cached.error;
    return cached.value;
  }
  if (snapshotInFlight.has(marketName)) return snapshotInFlight.get(marketName);

  const work = (async () => {
    try {
      const [rows, limits] = await Promise.all([campaigns(marketName), rules(marketName)]);
      const value = {
        market: marketName,
        day: localDate(),
        campaigns: rows.map(row => ({
          ...row,
          rule: limits.get(row.id) || { dailyLimit: 0, enabled: false },
        })),
      };
      snapshotCache.set(marketName, { at: Date.now(), value });
      return value;
    } catch (error) {
      const safeError = new Error(publicAdsError(error));
      snapshotCache.set(marketName, { at: Date.now(), error: safeError });
      scheduleSnapshotRetry(marketName);
      throw safeError;
    } finally {
      snapshotInFlight.delete(marketName);
    }
  })();
  snapshotInFlight.set(marketName, work);
  return work;
}

wbAdsRouter.get('/ads/campaigns', asyncRoute(async (req, res) => {
  try {
    res.json({ ok: true, ...await snapshot(market(req.query.market)) });
  } catch (error) {
    res.status(/временно ограничил/.test(String(error?.message || '')) ? 429 : 502)
      .json({ ok: false, error: publicAdsError(error) });
  }
}));

wbAdsRouter.put('/ads/limits/:market/:campaignId', asyncRoute(async (req, res) => {
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
  snapshotCache.delete(marketName);
  res.json({ ok: true, market: marketName, campaignId: id, dailyLimit: limit, enabled });
}));

async function enforce(marketName) {
  if (inFlight.has(marketName)) return inFlight.get(marketName);
  const work = (async () => {
    const configured = await rules(marketName);
    const enabled = [...configured.values()].filter(row => row.enabled && Number(row.dailyLimit) > 0);
    if (!enabled.length) return;
    const current = await campaigns(marketName);
    const byId = new Map(current.map(row => [row.id, row]));
    const token = await tokenFor(marketName);
    for (const rule of enabled) {
      const row = byId.get(Number(rule.campaignId));
      if (!row || !active(row) || Number(row.todaySpend) < Number(rule.dailyLimit)) continue;
      try {
        await request(marketName, API + '/adv/v0/pause?id=' + encodeURIComponent(row.id), token);
        await pool.query(
          "UPDATE wb_ad_limits SET last_checked_at=$3,last_action_at=$3,last_action_error='' WHERE market=$1 AND campaign_id=$2",
          [marketName, row.id, Date.now()],
        );
        campaignsCache.delete(marketName);
        snapshotCache.delete(marketName);
      } catch (error) {
        await pool.query(
          'UPDATE wb_ad_limits SET last_checked_at=$3,last_action_error=$4 WHERE market=$1 AND campaign_id=$2',
          [marketName, row.id, Date.now(), String(error?.message || error).slice(0, 500)],
        );
      }
    }
  })();
  inFlight.set(marketName, work);
  try {
    return await work;
  } finally {
    inFlight.delete(marketName);
  }
}

export function startWbAdsLimitLoop() {
  const run = () => Promise.all(['WB', 'WB2'].map(name => enforce(name)
    .catch(error => console.error('WB ads limit check', name, error))));
  const startupTimer = setTimeout(() => void run(), STARTUP_DELAY_MS);
  startupTimer.unref();
  const timer = setInterval(() => void run(), CHECK_MS);
  timer.unref();
  return timer;
}

