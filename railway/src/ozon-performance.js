import express from 'express';
import { asyncRoute, requireTrustedOrigin } from './http.js';

const HOST = 'https://api-performance.ozon.ru';
const CACHE_MS = 15 * 60 * 1000;
const cache = new Map();
let statsChain = Promise.resolve();
let access = { value: '', exp: 0 };

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
  const sku = String(row?.sku || row?.productSku || row?.product_sku || '').trim();
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
    for (const row of list) addSkuSpend(bySku, row, row?.moneySpent ?? row?.expense);
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
      if (amount > 0) spent += amount;
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
  if (response.status === 429 && attempt < 6) {
    await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
    return api(token, path, body, attempt + 1);
  }
  if (!response.ok) {
    const reason = text.replace(/client_secret":"[^"]+/g, 'client_secret":"[hidden]').slice(0, 240);
    const error = new Error('Ozon Performance ' + path + ': HTTP ' + response.status + (reason ? ' · ' + reason : ''));
    error.status = 502;
    throw error;
  }
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

async function skuCampaignIds(token) {
  const ids = [];
  for (let page = 1; page <= 20; page++) {
    const body = await api(token, '/api/client/campaign?page=' + page + '&pageSize=200&advObjectType=SKU');
    const list = Array.isArray(body.list) ? body.list : [];
    ids.push(...list.filter(row => row?.advObjectType === 'SKU').map(row => String(row.id)).filter(Boolean));
    if (list.length < 200) break;
  }
  return [...new Set(ids)];
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

async function directSkuRows(token, ids, from, to) {
  const bySku = new Map();
  for (let offset = 0; offset < ids.length; offset += 100) {
    const body = await api(token, '/api/client/statistics/products/sku', {
      campaignIds: ids.slice(offset, offset + 100),
      dateFrom: from,
      dateTo: to
    });
    if (!Array.isArray(body?.rows)) throw new Error('Ozon Performance: неизвестный формат статистики по SKU');
    mergeSkuRows(bySku, skuSpendFromSkuStats(body));
  }
  return [...bySku.values()];
}

async function productReportRows(token, from, to) {
  const range = moscowRange(from, to);
  const created = await api(token, '/api/client/statistic/products/generate/json', range);
  const uuid = String(created.UUID || created.uuid || '');
  if (!uuid) throw new Error('Ozon Performance: товарный отчёт не поставлен в очередь');
  const started = Date.now();
  let link = '';
  while (Date.now() - started < 90_000) {
    const status = await api(token, '/api/client/statistics/' + encodeURIComponent(uuid));
    const state = String(status.state || '');
    if (state === 'OK' && status.link) { link = String(status.link); break; }
    if (state === 'ERROR' || state === 'FAILED') throw new Error('Ozon Performance: товарный отчёт не собрался');
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  if (!link) throw new Error('Ozon Performance: товарный отчёт не готов');
  const path = link.startsWith('http') ? link.slice(HOST.length) : link;
  return skuSpendFromProductReport(await api(token, path.startsWith('/') ? path : '/' + path));
}

async function build(from, to) {
  const token = await tokenFor();
  const bySku = new Map();
  let source = 'product-report';
  let fallbackError = '';
  try {
    const rows = await enqueue(() => productReportRows(token, from, to));
    mergeSkuRows(bySku, rows);
    if (!rows.length) throw new Error('Ozon Performance: товарный отчёт не вернул расходы по SKU');
  } catch (error) {
    fallbackError = String(error?.message || error);
    source = 'products-sku';
    const ids = await skuCampaignIds(token);
    if (ids.length) mergeSkuRows(bySku, await directSkuRows(token, ids, from, to));
  }
  const rows = [...bySku.values()];
  return {
    from,
    to,
    rows,
    totalSpent: rows.reduce((sum, row) => sum + (Number(row.spent) || 0), 0),
    source,
    fallbackError,
    updatedAt: Date.now()
  };
}

export async function ozonSkuSpend(from, to) {
  const key = from + '|' + to;
  const hit = cache.get(key);
  if (hit?.data && Date.now() - hit.at < CACHE_MS) return hit.data;
  if (hit?.promise) return hit.promise;
  const promise = build(from, to).then(data => {
    cache.set(key, { at: Date.now(), data });
    return data;
  }).catch(error => {
    cache.delete(key);
    throw error;
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
