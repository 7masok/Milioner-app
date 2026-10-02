import express from 'express';
import { asyncRoute, requireTrustedOrigin } from './http.js';

const HOST = 'https://api-performance.ozon.ru';
const CACHE_MS = 15 * 60 * 1000;
const cache = new Map();
let statsChain = Promise.resolve();
let access = { value: '', exp: 0 };
let performanceCooldown = { until: 0, error: '' };

export const ozonPerformanceRouter = express.Router();

function credentials() {
  const clientId = String(process.env.OZON_PERFORMANCE_CLIENT_ID || '').trim();
  const clientSecret = String(process.env.OZON_PERFORMANCE_CLIENT_SECRET || '').trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export function parseOzonMoney(value) {
  const n = Number(String(value ?? '').replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

function addSkuSpend(bySku, row, spentValue) {
  const sku = String(row?.sku || row?.SKU || row?.productSku || row?.product_sku || '').trim();
  const spent = parseOzonMoney(spentValue);
  if (!sku || spent <= 0) return;
  const prev = bySku.get(sku) || { sku, title: '', spent: 0, orders: 0 };
  prev.spent += spent;
  prev.orders += parseOzonMoney(row?.orders ?? row?.modelOrders ?? row?.cpcOrders);
  if (!prev.title && (row?.title || row?.name)) prev.title = String(row.title || row.name);
  bySku.set(sku, prev);
}

export function skuSpendFromReport(payload) {
  const bySku = new Map();
  if (!payload || typeof payload !== 'object') return [];
  for (const block of Object.values(payload)) {
    const list = Array.isArray(block?.report?.rows) ? block.report.rows : [];
    for (const row of list) addSkuSpend(bySku, row, row?.moneySpent ?? row?.expense ?? row?.MoneySpent ?? row?.cost);
  }
  return [...bySku.values()];
}

export function skuSpendFromSkuStats(payload) {
  const bySku = new Map();
  for (const row of Array.isArray(payload?.rows) ? payload.rows : []) addSkuSpend(bySku, row, row?.expense);
  return [...bySku.values()];
}

function reportCandidateRows(payload) {
  const rows = [];
  const seen = new Set();
  const walk = value => {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === 'object' && ('sku' in item || 'productSku' in item || 'product_sku' in item)) rows.push(item);
        else walk(item);
      }
      return;
    }
    for (const child of Object.values(value)) walk(child);
  };
  walk(payload);
  return rows;
}

export function skuSpendFromCsv(text) {
  const lines = String(text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const headerAt = lines.findIndex(line => /(^|[;,])sku([;,]|$)/i.test(line));
  if (headerAt < 0) return [];
  const delimiter = lines[headerAt].includes(';') ? ';' : ',';
  const header = lines[headerAt].split(delimiter).map(cell => cell.trim().toLowerCase());
  const skuIndex = header.findIndex(cell => cell === 'sku' || cell.startsWith('sku'));
  const spentIndex = header.findIndex(cell => /расход|moneyspent|expense|затрат/.test(cell));
  const ordersIndex = header.findIndex(cell => cell === 'orders' || cell === 'заказы' || cell.startsWith('заказы'));
  const titleIndex = header.findIndex(cell => /название|title|^name$/.test(cell));
  if (skuIndex < 0 || spentIndex < 0) return [];
  const bySku = new Map();
  for (const line of lines.slice(headerAt + 1)) {
    const cells = line.split(delimiter).map(cell => cell.trim().replace(/^"|"$/g, ''));
    const sku = String(cells[skuIndex] || '').trim();
    if (!/^\d{4,}$/.test(sku)) continue;
    addSkuSpend(bySku, {
      sku,
      title: titleIndex >= 0 ? cells[titleIndex] : '',
      orders: ordersIndex >= 0 ? cells[ordersIndex] : 0
    }, cells[spentIndex]);
  }
  return [...bySku.values()];
}

function spendFromPayload(payload) {
  if (typeof payload?.csv === 'string') return skuSpendFromCsv(payload.csv);
  const parsed = skuSpendFromReport(payload);
  return parsed.length ? parsed : skuSpendFromProductReport(payload);
}

export function skuSpendFromProductReport(payload) {
  const bySku = new Map();
  for (const row of reportCandidateRows(payload)) {
    const candidates = [
      row?.expense,
      row?.moneySpent,
      row?.cpcExpense,
      row?.cpc_expense,
      row?.expenseCpc,
      row?.searchPromoExpense
    ];
    let spent = 0;
    for (const value of candidates) {
      const amount = parseOzonMoney(value);
      if (amount > 0) { spent = amount; break; }
    }
    addSkuSpend(bySku, row, spent);
  }
  return [...bySku.values()];
}

function validDay(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value + 'T00:00:00Z'));
}

function enqueue(task) {
  const run = statsChain.then(task, task);
  statsChain = run.then(() => {}, () => {});
  return run;
}

function nextMoscowReset() {
  const shifted = new Date(Date.now() + 3 * 60 * 60 * 1000);
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() + 1) - 3 * 60 * 60 * 1000 + 5 * 60 * 1000;
}

function performanceError(path, status, text) {
  const reason = String(text || '').replace(/client_secret\":\"[^\"]+/g, 'client_secret\":\"[hidden]').slice(0, 240);
  const error = new Error('Ozon Performance ' + path + ': HTTP ' + status + (reason ? ' · ' + reason : ''));
  error.status = status;
  if (status === 429 && /дневн.*лимит|daily limit|максимум\s*720|превышен дневной лимит/i.test(reason)) {
    error.code = 'DAILY_LIMIT';
    error.retryAt = nextMoscowReset();
    error.userMessage = 'Дневной лимит Ozon Performance исчерпан';
  } else if (status === 429) {
    error.code = 'RATE_LIMIT';
    error.retryAt = Date.now() + 60_000;
    error.userMessage = 'Ozon Performance временно ограничил запросы';
  } else if (status === 400 && /today or yesterday|только.*сегодня|только.*вчера/i.test(reason)) {
    error.code = 'TODAY_YESTERDAY_ONLY';
    error.userMessage = 'Этот метод Ozon доступен только за сегодня или вчера';
  }
  return error;
}

async function api(token, path, body, attempt = 0) {
  const response = await fetch(HOST + path, {
    method: body ? 'POST' : 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: 'Bearer ' + token,
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(40000)
  });
  const text = await response.text();
  if (response.status === 429) {
    const error = performanceError(path, response.status, text);
    if (error.code === 'DAILY_LIMIT') throw error;
    if (attempt < 2) {
      await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
      return api(token, path, body, attempt + 1);
    }
    throw error;
  }
  if (!response.ok) throw performanceError(path, response.status, text);
  return text ? JSON.parse(text) : {};
}

async function tokenFor() {
  const creds = credentials();
  if (!creds) return '';
  if (access.value && Date.now() < access.exp - 30_000) return access.value;
  const response = await fetch(HOST + '/api/client/token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: creds.clientId, client_secret: creds.clientSecret, grant_type: 'client_credentials' }),
    signal: AbortSignal.timeout(25000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) {
    const error = new Error('Ozon Performance: не удалось войти');
    error.status = 502;
    throw error;
  }
  access = { value: body.access_token, exp: Date.now() + (Number(body.expires_in) || 1800) * 1000 };
  return access.value;
}

const CAMPAIGN_BATCH = 10;
let campaignGroupsCache = { at: 0, groups: null };

function campaignBatches(ids) {
  const batches = [];
  for (let index = 0; index < ids.length; index += CAMPAIGN_BATCH) batches.push(ids.slice(index, index + CAMPAIGN_BATCH));
  return batches;
}

async function campaignGroups(token) {
  if (campaignGroupsCache.groups && Date.now() - campaignGroupsCache.at < CACHE_MS) return campaignGroupsCache.groups;
  const groups = { SKU: [], SEARCH_PROMO: [], skuByPayment: {} };
  for (let page = 1; page <= 5; page++) {
    const body = await api(token, '/api/client/campaign?page=' + page + '&pageSize=200');
    const list = Array.isArray(body.list) ? body.list : [];
    for (const row of list) {
      const type = String(row?.advObjectType || '');
      const id = String(row?.id || '').trim();
      if (!id || (type !== 'SKU' && type !== 'SEARCH_PROMO')) continue;
      groups[type].push(id);
      if (type === 'SKU') {
        const payment = String(row?.paymentType || 'UNKNOWN');
        groups.skuByPayment[payment] = groups.skuByPayment[payment] || [];
        groups.skuByPayment[payment].push(id);
      }
    }
    if (list.length < 200) break;
  }
  groups.SKU = [...new Set(groups.SKU)];
  groups.SEARCH_PROMO = [...new Set(groups.SEARCH_PROMO)];
  for (const payment of Object.keys(groups.skuByPayment)) groups.skuByPayment[payment] = [...new Set(groups.skuByPayment[payment])];
  campaignGroupsCache = { at: Date.now(), groups };
  return groups;
}

function mergeSkuRows(bySku, rows) {
  for (const row of rows || []) {
    const prev = bySku.get(row.sku) || { sku: row.sku, title: '', spent: 0, orders: 0 };
    prev.spent += Number(row.spent) || 0;
    prev.orders += Number(row.orders) || 0;
    if (!prev.title && row.title) prev.title = row.title;
    bySku.set(row.sku, prev);
  }
}

function moscowRange(from, to) {
  return {
    from: from + 'T00:00:00+03:00',
    to: to + 'T23:59:59+03:00'
  };
}

async function directSkuRows(token, from, to) {
  const groups = await campaignGroups(token);
  const paymentGroups = Object.values(groups.skuByPayment || {}).filter(ids => ids.length);
  if (!paymentGroups.length) {
    const error = new Error('Ozon Performance /api/client/statistics/products/sku: empty campaigns');
    error.code = 'EMPTY_CAMPAIGNS';
    throw error;
  }
  const rows = [];
  for (const ids of paymentGroups) for (const batch of campaignBatches(ids)) {
    const body = await api(token, '/api/client/statistics/products/sku', {
      campaignIds: batch,
      dateFrom: from,
      dateTo: to
    });
    if (!Array.isArray(body?.rows)) throw new Error('Ozon Performance: неизвестный формат статистики по SKU');
    rows.push(...skuSpendFromSkuStats(body));
  }
  return rows;
}

async function pollReport(token, uuid, label) {
  const started = Date.now();
  let link = '';
  await new Promise(resolve => setTimeout(resolve, 4000));
  while (Date.now() - started < 100_000) {
    const status = await api(token, '/api/client/statistics/' + encodeURIComponent(uuid));
    const state = String(status.state || '');
    if (state === 'OK' && status.link) { link = String(status.link); break; }
    if (state === 'ERROR' || state === 'FAILED') {
      const error = new Error('Ozon Performance: ' + label + ' не собрался' + (status.error ? ' · ' + String(status.error).slice(0,180) : ''));
      error.code = 'REPORT_FAILED';
      throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 7000));
  }
  if (!link) {
    const error = new Error('Ozon Performance: ' + label + ' не готов');
    error.code = 'REPORT_TIMEOUT';
    throw error;
  }
  return link;
}

async function downloadReport(token, link) {
  const path = link.startsWith('http') ? link.slice(HOST.length) : link;
  const reportPath = path.startsWith('/') ? path : '/' + path;
  const response = await fetch(HOST + reportPath, {
    headers: { Accept: 'application/json, text/csv, */*', Authorization: 'Bearer ' + token },
    signal: AbortSignal.timeout(40000)
  });
  const text = await response.text();
  if (!response.ok) throw performanceError(reportPath, response.status, text);
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return JSON.parse(trimmed);
  return { csv: text };
}

async function productReportRows(token, from, to) {
  const created = await api(token, '/api/client/statistic/products/generate/json', moscowRange(from, to));
  const uuid = String(created.UUID || created.uuid || '');
  if (!uuid) throw new Error('Ozon Performance: товарный отчёт не поставлен в очередь');
  return spendFromPayload(await downloadReport(token, await pollReport(token, uuid, 'товарный отчёт')));
}

async function allSkuPromoRows(token, from, to) {
  const range = moscowRange(from, to);
  const query = new URLSearchParams();
  query.set('timeBounds.from', range.from);
  query.set('timeBounds.to', range.to);
  const created = await api(token, '/api/client/statistics/all_sku_promo/products/generate?' + query.toString());
  const uuid = String(created.UUID || created.uuid || '');
  if (!uuid) throw new Error('Ozon Performance: отчёт оплаты за заказ не поставлен в очередь');
  return spendFromPayload(await downloadReport(token, await pollReport(token, uuid, 'отчёт оплаты за заказ')));
}

async function statisticsReportRows(token, from, to, campaigns) {
  const created = await api(token, '/api/client/statistics/json', {
    campaigns,
    dateFrom: from,
    dateTo: to,
    groupBy: 'DATE'
  });
  const uuid = String(created.UUID || created.uuid || '');
  if (!uuid) throw new Error('Ozon Performance: отчёт по кампаниям не поставлен в очередь');
  const payload = await downloadReport(token, await pollReport(token, uuid, 'отчёт по кампаниям'));
  return spendFromPayload(payload);
}

function reportListRejected(error) {
  return error?.status === 400 && /forbidden for the transferred list|invalidargument|empty campaigns/i.test(String(error?.message || ''));
}

async function campaignStatisticsRows(token, from, to, notes) {
  const groups = await campaignGroups(token);
  const rows = [];
  for (const ids of Object.values(groups.skuByPayment || {})) {
    for (const batch of campaignBatches(ids)) {
      if (performanceCooldown.until > Date.now()) {
        const error = new Error(performanceCooldown.error || 'Ozon Performance временно недоступен');
        error.code = 'COOLDOWN';
        error.retryAt = performanceCooldown.until;
        error.userMessage = performanceCooldown.error;
        throw error;
      }
      try {
        rows.push(...await statisticsReportRows(token, from, to, batch));
      } catch (error) {
        if (error.code === 'DAILY_LIMIT' || error.code === 'COOLDOWN') throw error;
        if (!reportListRejected(error)) throw error;
        notes.push(String(error.message || error).slice(0, 240));
      }
    }
  }
  return rows;
}

function directRangeAllowed(from, to) {
  if (from !== to) return false;
  const shifted = new Date(Date.now() + 3 * 60 * 60 * 1000);
  const today = shifted.toISOString().slice(0, 10);
  const yesterday = new Date(shifted.getTime() - 86400000).toISOString().slice(0, 10);
  return from === today || from === yesterday;
}

async function build(from, to) {
  const token = await tokenFor();
  const bySku = new Map();
  let source = '';
  let fallbackError = '';
  const ensureCooldown = () => {
    if (performanceCooldown.until <= Date.now()) return;
    const error = new Error(performanceCooldown.error || 'Ozon Performance временно недоступен');
    error.code = 'COOLDOWN';
    error.retryAt = performanceCooldown.until;
    error.userMessage = performanceCooldown.error;
    throw error;
  };
  const useCampaignReport = async (label) => {
    ensureCooldown();
    const groups = await campaignGroups(token);
    const notes = [];
    if (Object.values(groups.skuByPayment || {}).some(ids => ids.length)) {
      source = label;
      mergeSkuRows(bySku, await enqueue(() => campaignStatisticsRows(token, from, to, notes)));
    }
    try {
      ensureCooldown();
      if (!source) source = 'all-sku-promo';
      mergeSkuRows(bySku, await enqueue(() => allSkuPromoRows(token, from, to)));
    } catch (error) {
      if (error.code === 'DAILY_LIMIT' || error.code === 'COOLDOWN') throw error;
      notes.push(String(error.message || error).slice(0, 240));
    }
    if (bySku.size === 0 && !groups.SKU.length && !groups.SEARCH_PROMO.length) {
      source = 'product-report-fallback';
      mergeSkuRows(bySku, await enqueue(() => productReportRows(token, from, to)));
    }
    if (notes.length) fallbackError = notes.join(' | ').slice(0, 500);
  };

  if (directRangeAllowed(from, to)) {
    source = 'products-sku';
    try {
      mergeSkuRows(bySku, await directSkuRows(token, from, to));
    } catch (error) {
      fallbackError = String(error?.message || error);
      if (error.code === 'DAILY_LIMIT') throw error;
      if (performanceCooldown.until > Date.now()) throw error;
    }
    if (bySku.size === 0) await useCampaignReport('campaign-report-fallback');
    else await useCampaignReport('products-sku+all-sku-promo');
  } else {
    await useCampaignReport('campaign-report');
  }

  const rows = [...bySku.values()];
  return {
    from,
    to,
    rows,
    totalSpent: rows.reduce((sum, row) => sum + (Number(row.spent) || 0), 0),
    source,
    fallbackError,
    error: rows.length || !fallbackError ? '' : fallbackError,
    updatedAt: Date.now()
  };
}

export async function ozonSkuSpend(from, to) {
  const key = from + '|' + to;
  const hit = cache.get(key);
  if (hit?.data && Date.now() - hit.at < CACHE_MS) return hit.data;
  if (hit?.error && Number(hit.retryAt) > Date.now()) return {
    from, to, rows: [], totalSpent: 0, source: 'error',
    error: hit.error, retryAt: Number(hit.retryAt), limited: hit.limited === true, updatedAt: Number(hit.at) || Date.now()
  };
  if (performanceCooldown.until > Date.now()) return {
    from, to, rows: [], totalSpent: 0, source: 'error',
    error: performanceCooldown.error || 'Ozon Performance временно недоступен',
    retryAt: performanceCooldown.until, limited: true, updatedAt: Date.now()
  };
  if (hit?.promise) return hit.promise;
  const promise = build(from, to).then(data => {
    cache.set(key, { at: Date.now(), data });
    return data;
  }).catch(error => {
    const retryAt = Number(error?.retryAt) || (Date.now() + 5 * 60 * 1000);
    const message = String(error?.userMessage || error?.message || error);
    const limited = error?.code === 'DAILY_LIMIT' || error?.code === 'COOLDOWN';
    if (error?.code === 'DAILY_LIMIT') performanceCooldown = { until: retryAt, error: message };
    console.warn('[ozon-performance]', JSON.stringify({ from, to, code:String(error?.code||''), status:Number(error?.status)||0, limited, message:message.slice(0,260) }));
    cache.set(key, { at: Date.now(), error: message, retryAt, limited });
    return { from, to, rows: [], totalSpent: 0, source: 'error', error: message, retryAt, limited, updatedAt: Date.now() };
  });
  cache.set(key, { promise });
  return promise;
}

ozonPerformanceRouter.use(requireTrustedOrigin);
ozonPerformanceRouter.get('/ozon-ads', asyncRoute(async (req, res) => {
  const from = String(req.query.from || '');
  const to = String(req.query.to || '');
  if (!validDay(from) || !validDay(to) || from > to) {
    return res.status(400).json({ ok: false, error: 'Нужны даты from и to' });
  }
  const span = (Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000;
  if (span > 62) return res.status(400).json({ ok: false, error: 'Период рекламы не длиннее 62 дней' });
  if (!credentials()) return res.json({ ok: true, configured: false, from, to, rows: [] });
  const data = ozonSkuSpend(from, to);
  const ready = await Promise.race([
    data.then(value => ({ value })),
    new Promise(resolve => setTimeout(() => resolve(null), 8000))
  ]);
  if (!ready) return res.json({ ok: true, configured: true, from, to, rows: [], pending: true });
  res.json({ ok: true, configured: true, pending: false, ...ready.value });
}));
