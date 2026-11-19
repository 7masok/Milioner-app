import {kaspiIdentityCollector} from './kaspi-product-identities.js';
import express from 'express';
import { config } from './config.js';
import { requireConfiguredSession } from './auth.js';
import { asyncRoute, noStore, requireTrustedOrigin, requireWritesEnabled } from './http.js';
import { readKaspiMarketingAccess, saveKaspiMarketingAccess } from './connections.js';
import { pool, transaction } from './db.js';
import { persistKaspiAdExpenses } from './warehouse-kaspi-ads.js';

const ORIGIN = 'https://marketing.kaspi.kz';
const ACCOUNT_API = '/accounts/api/User/';
const ADS_API = '/advertising/products/api/';
const TIME_ZONE = 'Asia/Almaty';
const DAY = 86_400_000;
const RETRY = 15 * 60_000;
const COVERAGE_START = '2026-11-09';
const COVERAGE_SCAN = 5 * 60_000;
const EXPENSE_HEADER = /^(?:расход|рекламн[а-я]* расход|затрат|стоимост|cost|spend)/u;
const clock = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE, hourCycle: 'h23', hour: '2-digit', minute: '2-digit',
});
const dateFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
});

function fail(message, status = 502, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}

function localDay(now) {
  const parts = Object.fromEntries(dateFormat.formatToParts(now).map(part => [part.type, part.value]));
  return [parts.year, parts.month, parts.day].join('-');
}

function dayAfter(day) {
  return new Date(Date.parse(day + 'T00:00:00Z') + DAY).toISOString().slice(0, 10);
}

function labelKey(text) {
  return String(text || '').toLowerCase().replace(/[^a-zа-я0-9]+/g, ' ').trim();
}

function parseCsv(text, separator) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        cell += '"';
        index++;
      } else if (quoted || cell === '') quoted = !quoted;
      else cell += char;
    } else if (quoted) cell += char;
    else if (char === separator) {
      row.push(cell.trim());
      cell = '';
    } else if (char === '\n') {
      rows.push([...row, cell.trim()]);
      row = [];
      cell = '';
    } else cell += char;
  }
  if (quoted) throw fail('Kaspi вернул неполный CSV');
  if (cell || row.length) rows.push([...row, cell.trim()]);
  return rows;
}

export function kaspiProductExpenses(text, date) {
  const content = text.replace(/^\uFEFF/, '').trim();
  if (!content || ['<', '{', '['].includes(content[0])) throw fail('Kaspi не вернул CSV с расходами');
  let header, data, indices;
  for (const separator of [';', ',', '\t']) {
    const rows = parseCsv(content, separator);
    const located = rows.slice(0, 10).findIndex(row => row.map(labelKey).some(
      name => EXPENSE_HEADER.test(name),
    ) && row.length > 1);
    if (located < 0) continue;
    header = rows[located].map(labelKey);
    indices = {
      cost: header.findIndex(name => EXPENSE_HEADER.test(name)),
      sku: header.findIndex(name => /^(?:рекламируемый товар|sku|артикул|код товара)(?: |$)/.test(name)),
      name: header.findIndex(name => /^(?:товар|наименование товара|название товара|название|product name)(?: |$)/.test(name)),
      views: header.findIndex(name => /^(?:показы|просмотры|количество показов|количество просмотров|impressions|views)$/.test(name)),
      clicks: header.findIndex(name => /^(?:клики|количество кликов|clicks)$/.test(name)),
      carts: header.findIndex(name => /^(?:в корзину|добавления в корзину|cart adds)$/.test(name)),
      orders: header.findIndex(name => /^(?:заказы|количество заказов|заказы по рекламе|количество заказов по рекламе|orders)$/.test(name)),
      orderCodes: header.findIndex(name => /^(?:номера? заказов? по рекламе|номера рекламных заказов|advertising order ids)$/.test(name)),
      score: header.findIndex(name => /^(?:оценка конверсии(?: товара)?|conversion score)$/.test(name)),
      bid: header.findIndex(name => /^(?:ставка за клик|ставка|bid)$/.test(name)),
      averageBid: header.findIndex(name => /^(?:средняя ставка по категории|средняя цена за клик по категории|category average bid)$/.test(name)),
    };
    if (indices.sku >= 0 || indices.name >= 0) {
      data = rows.slice(located + 1);
      break;
    }
  }
  if (!data) throw fail('Формат рекламного отчёта Kaspi изменился');
  const lines = [];
  for (const row of data) {
    if (!row.some(Boolean) || row.some(cell => /^(итого|всего|total)$/i.test(cell))) continue;
    if (row.length !== header.length) throw fail('В отчёте Kaspi есть неполная строка');
    const value = row[indices.cost].replace(/[\s₸]/g, '').replace(/(?:KZT|тг\.?|тенге)$/i, '').replace(',', '.');
    const hasCost = value !== '' && value !== '-' && value !== '—';
    const amount = hasCost ? Number(value) : 0;
    if (!Number.isFinite(amount) || amount < 0) throw fail('Не удалось прочитать сумму в отчёте Kaspi');
    const metrics = {};
    for (const key of ['views', 'clicks', 'carts', 'orders', 'score', 'bid', 'averageBid']) {
      const cell = (row[indices[key]] || '').replace(/[\s₸]/g, '').replace(',', '.');
      const number = Number(cell);
      if (cell && /^(?:\d+)(?:\.\d+)?$/.test(cell) && Number.isFinite(number)
        && (['views','clicks','carts','orders'].includes(key) ? Number.isSafeInteger(number) : key !== 'score' || number >= 1 && number <= 10)) {
        metrics[key] = number;
      }
    }
    if (indices.orderCodes >= 0) {
      const cell = row[indices.orderCodes];
      if (/^\d+(?:[\s,;]+\d+)*$/.test(cell)) metrics.orderCodes = [...new Set(cell.split(/[\s,;]+/))];
      else if (!cell && metrics.orders === 0) metrics.orderCodes = [];
    }
    const sku = row[indices.sku] || '', name = row[indices.name] || '';
    if (!amount && (!Object.keys(metrics).length || !sku && !name)) continue;
    lines.push({ date, sku, name, amount, ...metrics });
  }
  return lines;
}

function accountChoices(user) {
  const profiles = Array.isArray(user?.profiles) ? user.profiles : [];
  return (profiles.length ? profiles : [{ merchants: user?.shop?.merchants }]).flatMap(profile =>
    (Array.isArray(profile.merchants) ? profile.merchants : []).map(merchant => ({
      id: String(merchant.id || ''),
      name: String(merchant.merchantName || profile.organizationName || ''),
      profileId: profile.id ? String(profile.id) : '',
    })),
  ).filter(merchant => /^\d+$/.test(merchant.id));
}

function pickAccount(user, shop) {
  const accounts = accountChoices(user);
  const matches = shop ? accounts.filter(account => labelKey(account.name) === labelKey(shop)) : accounts;
  if (matches.length === 1) return matches[0];
  throw fail(accounts.length ? 'Укажите точное название магазина из кабинета Kaspi Маркетинг' : 'У этого пользователя нет магазина в Kaspi Маркетинге', 409);
}

function updateCookies(cookies, response, path, now) {
  for (const header of response.headers.getSetCookie()) {
    const [pair, ...attributes] = header.split(';');
    const equal = pair.indexOf('=');
    if (equal < 1) continue;
    const name = pair.slice(0, equal).trim(), value = pair.slice(equal + 1).trim();
    const attrs = new Map(attributes.map(item => {
      const [key, ...rest] = item.trim().split('=');
      return [key.toLowerCase(), rest.join('=')];
    }));
    const cookiePath = attrs.get('path') || path.split('?')[0].split('/').slice(0, -1).join('/') || '/';
    const key = cookiePath + '|' + name;
    const maxAge = attrs.has('max-age') ? Number(attrs.get('max-age')) : NaN;
    const expiresAt = Number.isFinite(maxAge) ? now + maxAge * 1000 : Date.parse(attrs.get('expires') || '');
    if (!value || expiresAt <= now) delete cookies[key];
    else cookies[key] = { name, value, path: cookiePath, expiresAt: expiresAt || null };
  }
}

function cookieHeader(cookies, path, now) {
  const pathname = path.split('?')[0];
  return Object.values(cookies)
    .filter(cookie => (!cookie.expiresAt || cookie.expiresAt > now) &&
      (pathname === cookie.path || pathname.startsWith(cookie.path.endsWith('/') ? cookie.path : cookie.path + '/')))
    .sort((a, b) => b.path.length - a.path.length)
    .map(cookie => cookie.name + '=' + cookie.value).join('; ');
}

async function storeExpenses(batches, date, sourcesByName) {
  return transaction(async client => {
    const warehouse = await client.query('SELECT revision FROM warehouse_state WHERE id=1 FOR UPDATE');
    if (!warehouse.rowCount) throw fail('Сначала откройте основной склад', 409);
    const overlaps = await client.query(
      `SELECT payload FROM warehouse_kaspi_ad_expenses
       WHERE payload->>'fromDate' <= $1 AND payload->>'toDate' >= $1`, [date],
    );
    const existing = overlaps.rows.map(row => row.payload);
    const existingSources = new Set();
    const existingIds = new Set();
    for (const row of existing) {
      if (row.source === 'Kaspi Marketing auto') {
        existingIds.add(row.id);
        continue;
      }
      const name = labelKey(row.sourceKey || row.campaignName);
      const count = sourcesByName.get(name);
      if (count !== 1) {
        throw fail('За ' + date + ' есть ручной импорт «' + (row.campaignName || name) +
          '». Перед автозагрузкой нужно сверить его с кампаниями Kaspi.', 409);
      }
      existingSources.add(name);
    }
    const changed = batches.filter(batch => batch.amount > 0 ||
      existingIds.has(batch.id) || existingSources.has(batch.sourceKey));
    if (!changed.length) return [];
    const now = Date.now();
    await persistKaspiAdExpenses(client, changed, now);
    await client.query('UPDATE warehouse_state SET revision=revision+1,updated_at=$1 WHERE id=1', [now]);
    return changed.map(batch => batch.id);
  });
}

async function readSavedExpenseIds(ids) {
  const { rows } = await pool.query('SELECT id FROM warehouse_kaspi_ad_expenses WHERE id=ANY($1::text[])', [ids]);
  return new Set(rows.map(row => row.id));
}

export function createKaspiMarketingService({
  read = readKaspiMarketingAccess, write = saveKaspiMarketingAccess, persist = storeExpenses,
  fetchImpl = fetch, now = Date.now, findSavedIds = readSavedExpenseIds, coverageStart = COVERAGE_START,
} = {}) {
  let tail = Promise.resolve();
  let lastCoverageScanAt = 0;
  const productStatsCache = new Map();
  const locked = fn => {
    const pending = tail.then(fn);
    tail = pending.catch(() => {});
    return pending;
  };

  async function request(path, cookies, { body, csv = false, method = body ? 'POST' : 'GET', json = false } = {}) {
    const headers = {
      Accept: csv ? 'text/csv, application/octet-stream;q=0.9' : 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      'X-Front-Version': '26.11.16175',
    };
    const cookie = cookieHeader(cookies, path, now());
    if (cookie) headers.Cookie = cookie;
    if (body) headers.Origin = ORIGIN;
    if (json) headers['Content-Type'] = 'application/json';
    let response;
    try {
      response = await fetchImpl(ORIGIN + path, {
        method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw fail('Сервис Kaspi Маркетинг не ответил');
    }
    if (response.status === 429) {
      const retry = response.headers.get('retry-after');
      const retryAt = /^\d+$/.test(retry || '') ? now() + Number(retry) * 1000 : Date.parse(retry || '');
      throw fail('Kaspi ограничил запросы. Повторим позже.', 429, { retryAt });
    }
    if ([401, 403].includes(response.status)) throw fail('Kaspi отклонил вход или срок сессии истёк', response.status);
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')?.startsWith('/sign-in')) throw fail('Kaspi запросил повторный вход', 401);
    if (!response.ok) throw fail('Kaspi вернул ошибку HTTP ' + response.status);
    updateCookies(cookies, response, path, now());
    if (csv) {
      if (/text\/html|application\/json/i.test(response.headers.get('content-type') || '')) throw fail('Kaspi не вернул файл отчёта');
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > 3_000_000) throw fail('Рекламный отчёт Kaspi слишком большой');
      return bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.toString('utf16le') : bytes.toString('utf8');
    }
    const text = await response.text();
    if (body && !text.trim()) return null;
    let result;
    try { result = JSON.parse(text); } catch { result = null; }
    if (!result || String(result.result).toLowerCase() !== 'ok') {
      const login = path === ACCOUNT_API + 'login';
      throw fail(login ? 'Kaspi не подтвердил вход. Проверьте данные кабинета Маркетинг.' : 'Kaspi не подтвердил получение рекламных данных', login ? 401 : 502);
    }
    return result.data;
  }

  async function login({ phone, password, shop, account }) {
    const cookies = {};
    const body = new FormData();
    body.set('username', phone);
    body.set('password', password);
    await request(ACCOUNT_API + 'login', cookies, { body });
    const user = await request(ACCOUNT_API + 'getdata', cookies);
    const matched = account ? accountChoices(user).find(choice => choice.id === account.id && choice.profileId === account.profileId) : pickAccount(user, shop);
    if (!matched) throw fail('Подключённый магазин больше недоступен в Kaspi Маркетинге', 409);
    if (matched.profileId && String(user?.pay?.context?.profileId || '') !== matched.profileId) {
      await request(ACCOUNT_API + 'select-profile?' + new URLSearchParams({ profileId: matched.profileId }), cookies, { body: new FormData() });
    }
    return { account: matched, cookies };
  }

  async function campaigns(data, date) {
    const query = new URLSearchParams({ StartDate: date, EndDate: date });
    const result = await request(ADS_API + 'v5/merchant/' + data.account.id + '/Campaigns?' + query, data.cookies);
    if (!Array.isArray(result) || result.length > 150 || result.some(row =>
      !/^\d+$/.test(String(row?.id || '')) || !labelKey(row?.name) ||
      (row.cost !== null && (!['number', 'string'].includes(typeof row.cost) || !Number.isFinite(Number(row.cost)) || Number(row.cost) < 0)),
    )) throw fail('Не удалось подтвердить список рекламных кампаний Kaspi');
    if (new Set(result.map(row => String(row.id))).size !== result.length) {
      throw fail('Kaspi вернул повторяющийся ID рекламной кампании');
    }
    return result;
  }

  async function loadDay(data, date, probe = false) {
    const list = await campaigns(data, date);
    if (list.length && list.every(campaign => campaign.cost === null)) {
      throw fail('Kaspi пока не подтвердил расходы за ' + date);
    }
    const sourcesByName = new Map();
    const batches = [];
    const importedAt = now();
    for (const campaign of list) {
      const key = labelKey(campaign.name);
      sourcesByName.set(key, (sourcesByName.get(key) || 0) + 1);
    }
    for (const campaign of list) {
      const nameKey = labelKey(campaign.name);
      const repeatedName = sourcesByName.get(nameKey) > 1;
      const sourceKey = repeatedName ? 'kaspi campaign ' + data.account.id + ' ' + campaign.id : nameKey;
      if (campaign.cost === null) continue;
      const cost = Number(campaign.cost);
      let lines = [];
      if (cost > 0) {
        const query = new URLSearchParams({ campaignId: String(campaign.id), startDate: date, endDate: date });
        const path = ADS_API + 'v3/merchant/' + data.account.id + '/reports/products/csv?' + query;
        lines = kaspiProductExpenses(await request(path, data.cookies, { csv: true }), date);
      }
      const amount = lines.reduce((total, line) => total + line.amount, 0);
      if (Math.abs(amount - cost) > 1) throw fail('Расходы по товарам не сходятся с итогом кампании Kaspi');
      if (probe && cost > 0) break;
      batches.push({
        id: ['kaspi-auto', data.account.id, campaign.id, date].join('-'),
        market: 'Kaspi', source: 'Kaspi Marketing auto', sourceKey,
        campaignName: repeatedName ? campaign.name + ' · № ' + campaign.id : campaign.name,
        campaignId: String(campaign.id), accountId: data.account.id,
        accountingVersion: 'ads-snapshot-v3', replacementPolicy: 'campaign-date-snapshot',
        fromDate: date, toDate: date, amount, rowsCount: lines.length, lines, importedAt,
      });
    }
    return { batches, sourcesByName };
  }

  function eligibleThrough(data, timestamp) {
    return localDay(timestamp - (clock.format(timestamp) >= (data?.time || '09:00') ? DAY : 2 * DAY));
  }

  function coverageSummary(data, timestamp) {
    const to = eligibleThrough(data, timestamp);
    let confirmed = 0, total = 0, zero = 0, firstMissing = '';
    for (let day = coverageStart; day <= to; day = dayAfter(day)) {
      total++;
      const record = data?.confirmedDays?.[day];
      if (record) {
        confirmed++;
        if (!record.amount) zero++;
      } else if (!firstMissing) firstMissing = day;
    }
    return { from: coverageStart, to, confirmed, total, zero, firstMissing, error: data?.gapError || '' };
  }

  async function verifySavedCoverage(data, timestamp) {
    if (timestamp - lastCoverageScanAt < COVERAGE_SCAN) return;
    const days = Object.entries(data.confirmedDays || {});
    const ids = days.flatMap(([, record]) => record.ids);
    if (ids.length) {
      const saved = await findSavedIds(ids);
      const removed = days.filter(([, record]) => record.ids.some(id => !saved.has(id)));
      if (removed.length) {
        for (const [date] of removed) delete data.confirmedDays[date];
        await write(data);
      }
    }
    lastCoverageScanAt = timestamp;
  }

  function view(data) {
    return {
      ok: true, connected: Boolean(data?.account), shop: data?.account?.name || '',
      time: data?.time || '09:00', lastDay: data?.lastDay || '',
      lastSuccessAt: data?.lastSuccessAt || 0, lastError: data?.lastError || '', reconnect: Boolean(data?.reconnect),
      defaultFrom: localDay(now() - 4 * DAY), yesterday: localDay(now() - DAY),
      backfill: data?.backfill || null, coverage: coverageSummary(data, now()),
      confirmedDays: Object.keys(data?.confirmedDays || {}).sort(),
    };
  }

  function checkedTime(value) {
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(value || ''))) throw fail('Укажите время загрузки', 400);
    return value;
  }

  function backfillRange(input) {
    const from = String(input?.from || ''), to = String(input?.to || '');
    const valid = day => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
      const iso = Date.parse(day + 'T00:00:00Z');
      return Number.isFinite(iso) && new Date(iso).toISOString().slice(0, 10) === day;
    };
    if (!valid(from) || !valid(to) || from > to || to >= localDay(now())) {
      throw fail('Укажите диапазон завершённых дней, до вчера включительно', 400);
    }
    return { from, to };
  }

  async function importDay(data, date, kind) {
    const backfill = kind === 'backfill' ? data.backfill : null;
    let result;
    try {
      let report;
      try {
        report = await loadDay(data, date);
      } catch (error) {
        if (error.status !== 401) throw error;
        Object.assign(data, await login(data));
        report = await loadDay(data, date);
      }
      const ids = await persist(report.batches, date, report.sourcesByName);
      const amount = report.batches.reduce((total, batch) => total + batch.amount, 0);
      if (date >= coverageStart) {
        data.confirmedDays ||= {};
        data.confirmedDays[date] = { ids, amount };
        if (data.gapRetry) delete data.gapRetry[date];
        if (data.gapError?.date === date) delete data.gapError;
      }
      if (backfill) {
        backfill.next = date === backfill.to ? '' : dayAfter(date);
        backfill.error = '';
        backfill.retryAt = 0;
      }
      if (kind === 'daily' || (date === localDay(now() - DAY) && date > (data.lastDay || ''))) {
        Object.assign(data, { lastDay: date, lastSuccessAt: now(), lastError: '', nextAttemptAt: 0 });
      }
      Object.assign(data, { nextRunAt: now() + 60_000, reconnect: false });
      result = amount > 0 ? 'expenses' : 'zero';
      const recognised = new Set();
      for (const batch of report.batches) {
        for (const line of batch.lines) {
          for (const key of ['views', 'clicks', 'carts', 'orders', 'orderCodes', 'score', 'bid', 'averageBid']) {
            if (Object.hasOwn(line, key)) recognised.add(key);
          }
        }
      }
      console.info('Kaspi Marketing report metrics', date, [...recognised].sort().join(',') || 'expenses-only');
    } catch (error) {
      const message = error.status ? error.message : 'Не удалось сохранить отчёт Kaspi';
      const retryAt = Math.max(now() + RETRY, Number(error.retryAt) || 0);
      if (backfill) Object.assign(backfill, { error: message, retryAt });
      else if (kind === 'daily') Object.assign(data, { lastError: message, nextAttemptAt: retryAt });
      if (date >= coverageStart) {
        data.gapRetry ||= {};
        data.gapRetry[date] = retryAt;
        data.gapError = { date, message, retryAt };
      }
      if (error.status === 429) data.providerRetryAt = retryAt;
      else data.nextRunAt = now() + 60_000;
      data.reconnect = [401, 403].includes(error.status);
      result = 'retry HTTP ' + (error.status || 502);
    }
    await write(data);
    console.info('Kaspi Marketing day', date, kind, result);
    return view(data);
  }

  async function sync(data, force = false) {
    if (!data?.account || data.reconnect) {
      if (force) throw fail('Подключите Kaspi Маркетинг', 409);
      return view(data);
    }
    const timestamp = now(), yesterday = localDay(timestamp - DAY);
    if (data.providerRetryAt > timestamp || (!force && data.nextRunAt > timestamp)) return view(data);
    if (!force) await verifySavedCoverage(data, timestamp);
    const dailyDue = !(data.nextAttemptAt > timestamp) && (force ||
      (clock.format(timestamp) >= data.time && !(data.lastDay >= yesterday) && !data.confirmedDays?.[yesterday]));
    if (dailyDue) return importDay(data, yesterday, 'daily');
    if (!force && data.backfill?.next && !(data.backfill.retryAt > timestamp)) {
      return importDay(data, data.backfill.next, 'backfill');
    }
    if (!force) {
      const through = eligibleThrough(data, timestamp);
      for (let day = coverageStart; day <= through; day = dayAfter(day)) {
        if (!data.confirmedDays?.[day] && !(data.gapRetry?.[day] > timestamp)) {
          return importDay(data, day, 'gap');
        }
      }
    }
    return view(data);
  }

  return {
    state: async () => view(await read()),
    products: input => locked(async () => {
      const accountId=String(input?.accountId || ''), campaignId=String(input?.campaignId || '');
      const from=String(input?.from || ''), to=String(input?.to || '');
      const dates=[from,to].map(day=>Date.parse(day+'T00:00:00Z'));
      if (!/^\d+$/.test(accountId) || !/^\d+$/.test(campaignId)
        || [from,to].some((day,i)=>!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(dates[i]) || new Date(dates[i]).toISOString().slice(0,10)!==day)
        || from>to || to>localDay(now()) || dates[1]-dates[0]>30*DAY) throw fail('Проверьте магазин, кампанию и период до 31 дня',400);
      const data=await read();
      if (!data?.account || data.reconnect) throw fail('Подключите Kaspi Маркетинг',409);
      if (String(data.account.id)!==accountId) throw fail('Подключён другой магазин Kaspi',409);
      const key=JSON.stringify([accountId,data.account.profileId,campaignId,from,to]);
      const cached=productStatsCache.get(key);
      if (cached && now()-cached.updatedAt<5*60_000) return cached;
      if (data.providerRetryAt>now()) throw fail('Дождитесь окончания ограничения Kaspi',429,{retryAt:data.providerRetryAt});
      const query=new URLSearchParams({StartDate:from,EndDate:to});
      const path=ADS_API+'v5/merchant/'+accountId+'/campaign/'+campaignId+'/products?'+query;
      let result;
      try {
        try { result=await request(path,data.cookies); }
        catch (error) {
          if (error.status!==401) throw error;
          Object.assign(data,await login(data));
          result=await request(path,data.cookies);
        }
      } catch (error) {
        if (error.status===429) {
          data.providerRetryAt=Math.max(now()+RETRY,Number(error.retryAt)||0);
          await write(data);
        }
        throw error;
      }
      if (!Array.isArray(result) || result.length>15000 || result.some(row=>row?.sku==null || !String(row.sku).trim())
        || new Set(result.map(row=>String(row.sku))).size!==result.length) throw fail('Kaspi вернул неподтверждённую статистику товаров',502);
      const fields={views:'views',clicks:'clicks',carts:'carts',orders:'transactions',bid:'bid',cpc:'avgCpc',score:'score',spend:'cost'};
      const products=result.map(row=>{
        const item={sku:String(row.sku)};
        for (const [target,source] of Object.entries(fields)) {
          const raw=row[source], value=Number(raw);
          if (!['number','string'].includes(typeof raw) || String(raw).trim()==='' || !Number.isFinite(value) || value<0) continue;
          if (['views','clicks','carts','orders'].includes(target) && !Number.isSafeInteger(value)) continue;
          if (target==='score' && (value<1 || value>10)) continue;
          item[target]=value;
        }
        return item;
      });
      const snapshot={ok:true,accountId,campaignId,from,to,updatedAt:now(),products};
      await write(data);
      for (const [id,entry] of productStatsCache) if (now()-entry.updatedAt>=5*60_000) productStatsCache.delete(id);
      productStatsCache.set(key,snapshot);
      return snapshot;
    }),
    setBid: input => locked(async () => {
      const accountId = String(input?.accountId || ''), campaignId = String(input?.campaignId || '');
      const sku = String(input?.sku || '').trim(), bid = Number(input?.bid);
      if (!/^\d+$/.test(accountId) || !/^\d+$/.test(campaignId) || !sku || sku.length > 200
        || typeof input?.bid !== 'number' || !Number.isFinite(bid) || bid < 3 || Math.round(bid * 100) / 100 !== bid) {
        throw fail('Укажите товар, кампанию и ставку от 3 ₸ с точностью до тиына', 400);
      }
      const data = await read();
      if (!data?.account || data.reconnect) throw fail('Подключите Kaspi Маркетинг', 409);
      if (String(data.account.id) !== accountId) throw fail('Подключён другой магазин Kaspi', 409);
      if (data.providerRetryAt > now()) throw fail('Дождитесь окончания ограничения Kaspi', 429, {retryAt:data.providerRetryAt});
      const path = ADS_API + 'v1/merchant/' + accountId + '/campaign/' + campaignId + '/products/update-bid';
      let result;
      try {
        result = await request(path, data.cookies, {method:'PUT',json:true,body:JSON.stringify({skuList:[sku],bid})});
      } catch (error) {
        if (error.status === 429) {
          data.providerRetryAt = Math.max(now()+RETRY,Number(error.retryAt)||0);
          await write(data);
        }
        throw error;
      }
      await write(data);
      const product = Array.isArray(result) ? result.find(row => String(row?.sku) === sku) : null;
      if (!product || Number(product.bid) !== bid) throw fail('Kaspi не подтвердил новую ставку. Проверьте её в кабинете перед повтором.', 502);
      productStatsCache.clear();
      return {ok:true,accountId,campaignId,sku,bid};
    }),
    connect: input => locked(async () => {
      const phone = String(input?.phone || '').replace(/\D/g, '').replace(/^8(?=\d{10}$)/, '7');
      const password = String(input?.password || '');
      const shop = String(input?.shop || '').trim();
      if (!/^7\d{10}$/.test(phone) || !password || password.length > 255 || shop.length > 120) throw fail('Проверьте телефон и пароль', 400);
      const data = { phone, password, shop, time: checkedTime(input?.time) };
      const authenticated = await login(data);
      const existing = await read();
      if (existing?.account?.id && existing.account.id !== authenticated.account.id) {
        throw fail('В «Складе» уже подключён другой рекламный магазин. Сначала отключите его.', 409);
      }
      const connected = { ...existing, ...data, ...authenticated, reconnect: false, lastError: '', nextAttemptAt: 0 };
      await loadDay(connected, localDay(now() - DAY), true);
      await write(connected);
      return view(connected);
    }),
    saveTime: input => locked(async () => {
      const data = await read();
      if (!data?.account) throw fail('Подключите Kaspi Маркетинг', 409);
      data.time = checkedTime(input?.time);
      await write(data);
      return view(data);
    }),
    disconnect: () => locked(async () => {
      const data = await read();
      await write({ time: data?.time });
      return view(null);
    }),
    queueBackfill: input => locked(async () => {
      const data = await read();
      if (!data?.account || data.reconnect) throw fail('Подключите Kaspi Маркетинг', 409);
      const range = backfillRange(input);
      if (data.backfill?.next) {
        if (data.backfill.from === range.from && data.backfill.to === range.to) return view(data);
        throw fail('Догрузка другого периода уже идёт', 409);
      }
      data.backfill = { ...range, next: range.from, error: '' };
      await write(data);
      return view(data);
    }),
    stopBackfill: () => locked(async () => {
      const data = await read();
      if (data?.backfill?.next) {
        delete data.backfill;
        await write(data);
      }
      return view(data);
    }),
    sync: () => locked(async () => sync(await read(), true)),
    syncIfDue: () => locked(async () => sync(await read())),
  };
}

const service = createKaspiMarketingService();
export const kaspiMarketingRouter = express.Router();
kaspiMarketingRouter.use(noStore, requireConfiguredSession, requireTrustedOrigin);
kaspiMarketingRouter.get('/state', asyncRoute(async (_req, res) => res.json(await service.state())));
kaspiMarketingRouter.get('/identities', asyncRoute(async (_req,res)=>res.json(await kaspiIdentityCollector.snapshot())));
kaspiMarketingRouter.get('/products', asyncRoute(async (req,res)=>res.json(await service.products(req.query))));
kaspiMarketingRouter.put('/bid', requireWritesEnabled, asyncRoute(async (req, res) => res.json(await service.setBid(req.body))));
kaspiMarketingRouter.post('/connect', requireWritesEnabled, asyncRoute(async (req, res) => res.json(await service.connect(req.body))));
kaspiMarketingRouter.post('/schedule', requireWritesEnabled, asyncRoute(async (req, res) => res.json(await service.saveTime(req.body))));
kaspiMarketingRouter.post('/disconnect', requireWritesEnabled, asyncRoute(async (_req, res) => res.json(await service.disconnect())));
kaspiMarketingRouter.post('/sync', requireWritesEnabled, asyncRoute(async (_req, res) => res.json(await service.sync())));
kaspiMarketingRouter.post('/backfill', requireWritesEnabled, asyncRoute(async (req, res) => res.json(await service.queueBackfill(req.body))));
kaspiMarketingRouter.post('/stop-backfill', requireWritesEnabled, asyncRoute(async (_req, res) => res.json(await service.stopBackfill())));


export function startKaspiMarketingLoop() {
  if (!config.writesEnabled || config.storeProfile === 'WB3') return;
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try { await service.syncIfDue(); }
    catch { console.warn('Kaspi Marketing sync failed while accessing local state'); }
    finally { running = false; }
  }, 60_000);
  timer.unref();
}
