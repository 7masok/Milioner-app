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

export function skuSpendFromReport(payload) {
  const bySku = new Map();
  if (!payload || typeof payload !== 'object') return [];
  for (const block of Object.values(payload)) {
    const list = Array.isArray(block?.report?.rows) ? block.report.rows : [];
    for (const row of list) {
      const sku = String(row?.sku || '').trim();
      const spent = parseOzonMoney(row?.moneySpent);
      if (!sku || spent <= 0) continue;
      const prev = bySku.get(sku) || { sku, title: '', spent: 0, orders: 0 };
      prev.spent += spent;
      prev.orders += parseOzonMoney(row?.orders);
      if (!prev.title && row?.title) prev.title = String(row.title);
      bySku.set(sku, prev);
    }
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
  const body = await api(token, '/api/client/campaign?page=1&pageSize=200');
  const list = Array.isArray(body.list) ? body.list : [];
  return list.filter(row => row?.advObjectType === 'SKU').map(row => String(row.id)).filter(Boolean);
}

async function reportRows(token, ids, from, to) {
  const created = await api(token, '/api/client/statistics/json', {
    campaigns: ids,
    dateFrom: from,
    dateTo: to,
    groupBy: 'NO_GROUP_BY'
  });
  const uuid = String(created.UUID || created.uuid || '');
  if (!uuid) throw new Error('Ozon Performance: отчёт не поставлен в очередь');
  const started = Date.now();
  let link = '';
  while (Date.now() - started < 90_000) {
    const status = await api(token, '/api/client/statistics/' + encodeURIComponent(uuid));
    const state = String(status.state || '');
    if (state === 'OK' && status.link) { link = String(status.link); break; }
    if (state === 'ERROR' || state === 'FAILED') throw new Error('Ozon Performance: отчёт не собрался');
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  if (!link) throw new Error('Ozon Performance: отчёт не готов');
  const path = link.startsWith('http') ? link.slice(HOST.length) : link;
  return skuSpendFromReport(await api(token, path.startsWith('/') ? path : '/' + path));
}

async function build(from, to) {
  const token = await tokenFor();
  const ids = await skuCampaignIds(token);
  const bySku = new Map();
  for (let offset = 0; offset < ids.length; offset += 10) {
    const chunk = ids.slice(offset, offset + 10);
    const rows = await enqueue(() => reportRows(token, chunk, from, to));
    for (const row of rows) {
      const prev = bySku.get(row.sku) || { sku: row.sku, title: '', spent: 0, orders: 0 };
      prev.spent += row.spent;
      prev.orders += row.orders;
      if (!prev.title && row.title) prev.title = row.title;
      bySku.set(row.sku, prev);
    }
  }
  return { from, to, rows: [...bySku.values()], updatedAt: Date.now() };
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
