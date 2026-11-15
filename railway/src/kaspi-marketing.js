import express from 'express';
import { config } from './config.js';
import { requireConfiguredSession } from './auth.js';
import { asyncRoute, noStore, requireTrustedOrigin, requireWritesEnabled } from './http.js';
import { readKaspiMarketingAccess, saveKaspiMarketingAccess } from './connections.js';
import { transaction } from './db.js';
import { persistKaspiAdExpenses } from './warehouse-kaspi-ads.js';

const ORIGIN = 'https://marketing.kaspi.kz';
const ACCOUNT_API = '/accounts/api/User/';
const ADS_API = '/advertising/products/api/';
const TIME_ZONE = 'Asia/Almaty';
const DAY = 86_400_000;
const RETRY = 15 * 60_000;
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
    if (value === '' || value === '-' || value === '—') continue;
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount < 0) throw fail('Не удалось прочитать сумму в отчёте Kaspi');
    if (!amount) continue;
    lines.push({ date, sku: row[indices.sku] || '', name: row[indices.name] || '', amount });
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
    if (!changed.length) return;
    const now = Date.now();
    await persistKaspiAdExpenses(client, changed, now);
    await client.query('UPDATE warehouse_state SET revision=revision+1,updated_at=$1 WHERE id=1', [now]);
  });
}

export function createKaspiMarketingService({
  read = readKaspiMarketingAccess, write = saveKaspiMarketingAccess, persist = storeExpenses,
  fetchImpl = fetch, now = Date.now,
} = {}) {
  let tail = Promise.resolve();
  const locked = fn => {
    const pending = tail.then(fn);
    tail = pending.catch(() => {});
    return pending;
  };

  async function request(path, cookies, { body, csv = false } = {}) {
    const headers = {
      Accept: csv ? 'text/csv, application/octet-stream;q=0.9' : 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      'X-Front-Version': '26.11.16175',
    };
    const cookie = cookieHeader(cookies, path, now());
    if (cookie) headers.Cookie = cookie;
    if (body) headers.Origin = ORIGIN;
    let response;
    try {
      response = await fetchImpl(ORIGIN + path, {
        method: body ? 'POST' : 'GET', headers, body, redirect: 'manual', signal: AbortSignal.timeout(15_000),
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
        accountingVersion: 'ads-snapshot-v3', replacementPolicy: 'campaign-date-snapshot',
        fromDate: date, toDate: date, amount, rowsCount: lines.length, lines, importedAt,
      });
    }
    return { batches, sourcesByName };
  }

  function view(data) {
    return {
      ok: true, connected: Boolean(data?.account), shop: data?.account?.name || '',
      time: data?.time || '09:00', lastDay: data?.lastDay || '',
      lastSuccessAt: data?.lastSuccessAt || 0, lastError: data?.lastError || '', reconnect: Boolean(data?.reconnect),
    };
  }

  function checkedTime(value) {
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(value || ''))) throw fail('Укажите время загрузки', 400);
    return value;
  }

  async function sync(data, force = false) {
    if (!data?.account) {
      if (force) throw fail('Подключите Kaspi Маркетинг', 409);
      return view(data);
    }
    const timestamp = now(), yesterday = localDay(timestamp - DAY);
    if (data.reconnect) {
      if (force) throw fail('Подключите кабинет Kaspi Маркетинг повторно', 409);
      return view(data);
    }
    if (data.nextAttemptAt > timestamp && force && data.lastError) return view(data);
    if (!force && (clock.format(timestamp) < data.time || data.lastDay >= yesterday ||
        data.nextAttemptAt > timestamp)) return view(data);
    const date = data.lastDay && data.lastDay < yesterday ? dayAfter(data.lastDay) : yesterday;
    try {
      let report;
      try {
        report = await loadDay(data, date);
      } catch (error) {
        if (error.status !== 401) throw error;
        Object.assign(data, await login(data));
        report = await loadDay(data, date);
      }
      await persist(report.batches, date, report.sourcesByName);
      Object.assign(data, { lastDay: date, lastSuccessAt: now(), lastError: '', nextAttemptAt: now() + 60_000, reconnect: false });
    } catch (error) {
      data.lastError = error.status ? error.message : 'Не удалось сохранить отчёт Kaspi';
      data.nextAttemptAt = Math.max(now() + RETRY, Number(error.retryAt) || 0);
      data.reconnect = [401, 403].includes(error.status);
    }
    await write(data);
    return view(data);
  }

  return {
    state: async () => view(await read()),
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
    sync: () => locked(async () => sync(await read(), true)),
    syncIfDue: () => locked(async () => sync(await read())),
  };
}

const service = createKaspiMarketingService();
export const kaspiMarketingRouter = express.Router();
kaspiMarketingRouter.use(noStore, requireConfiguredSession, requireTrustedOrigin);
kaspiMarketingRouter.get('/state', asyncRoute(async (_req, res) => res.json(await service.state())));
kaspiMarketingRouter.post('/connect', requireWritesEnabled, asyncRoute(async (req, res) => res.json(await service.connect(req.body))));
kaspiMarketingRouter.post('/schedule', requireWritesEnabled, asyncRoute(async (req, res) => res.json(await service.saveTime(req.body))));
kaspiMarketingRouter.post('/disconnect', requireWritesEnabled, asyncRoute(async (_req, res) => res.json(await service.disconnect())));
kaspiMarketingRouter.post('/sync', requireWritesEnabled, asyncRoute(async (_req, res) => res.json(await service.sync())));

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
