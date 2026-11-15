import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const passport = readFileSync(new URL('../../docs/SITE-PASSPORT.md', import.meta.url), 'utf8');
const agents = readFileSync(new URL('../../AGENTS.md', import.meta.url), 'utf8');
const adsServer = readFileSync(new URL('../src/wb-ads.js', import.meta.url), 'utf8');

test('Advertising exposes the standard five period choices without changing other screens', () => {
  assert.match(html, /id="adsPeriod" class="period"/);
  assert.match(html, /data-ads-period="today"[^>]*>Сегодня<\/button>/);
  assert.match(html, /data-ads-period="yesterday"[^>]*>Вчера<\/button>/);
  assert.match(html, /data-ads-period="7"[^>]*>7 дней<\/button>/);
  assert.match(html, /data-ads-period="30"[^>]*>30 дней<\/button>/);
  assert.match(html, /data-ads-period="custom"[^>]*>Свой период<\/button>/);
  assert.match(html, /id="adsDateFrom" type="date"/);
  assert.match(html, /id="adsDateTo" type="date"/);
});

test('Advertising period is persistent analysis state while the daily budget remains today-only', () => {
  assert.match(html, /localStorage\.getItem\('adsSelectedPeriod'\)/);
  assert.match(html, /function adsMetricsForRow\(row\)/);
  assert.match(html, /todaySpend=Number\(row\.todaySpend\)\|\|0/);
  assert.match(html, /data\.day===day\?wbAdsMoneyText\(todaySpend\)/);
});

test('Server fills a 30-day cache in the existing advertising snapshot', () => {
  assert.match(adsServer, /historyFrom = localDate\(Date\.now\(\) - 29 \* 86400000\)/);
  assert.match(adsServer, /beginDate=' \+ historyFrom \+ '&endDate=' \+ historyTo/);
  assert.match(adsServer, /periodMetrics: hasFreshStats/);
});

test('Passport defines the standard but explicitly forbids opportunistic mass alignment', () => {
  assert.match(passport, /«Сегодня», «Вчера», «7 дней», «30 дней», «Свой период»/);
  assert.match(passport, /текущая задача распространяет его только на «Рекламу»/);
  assert.match(passport, /Массовое выравнивание остальных экранов требует отдельного согласования/);
  assert.match(agents, /Единый UI-стандарт — цель для новых и затрагиваемых элементов, а не разрешение/);
});

test('Kaspi has its own advertising tab and selects only the marketing connection endpoint', async () => {
  const markup = html.slice(html.indexOf('<section id="ads"'), html.indexOf('<section id="settings"'));
  assert.match(markup, /data-ads-market="Kaspi"[^>]*>Kaspi<\/button>/);
  const kaspi = markup.slice(markup.indexOf('id="adsKaspiPanel"'), markup.indexOf('id="adsWbPanel"'));
  assert.match(kaspi, /id="kaspiMarketingButton"[^>]*openKaspiMarketing/);
  assert.match(kaspi, /showKaspiAdsHistory/);
  assert.doesNotMatch(markup.slice(0, markup.indexOf('id="adsKaspiPanel"')), /openKaspiMarketing/);

  const requests = [];
  const ctx = vm.createContext({
    adsMarket: 'Kaspi', adsRenderInFlight: false,
    document: { getElementById: () => ({}), activeElement: null },
    startAdsSnapshotWatcher() {}, supportedAdsMarket: market => market,
    syncAdsMarketView() {}, paintKaspiAdsPanel: data => { ctx.result = data; },
    adsApi: async path => { requests.push(path); return { connected: true, shop: 'LUXAR' }; },
  });
  const start = html.indexOf('async function renderAds(){');
  const end = html.indexOf('async function saveAdsLimit(', start);
  vm.runInContext(html.slice(start, end), ctx);
  await ctx.renderAds();
  assert.deepEqual(requests, ['/api/kaspi-marketing/state']);
  assert.equal(ctx.result.shop, 'LUXAR');
});

test('Kaspi audit stays usable without any Wildberries advertising data', async () => {
  const ctx = vm.createContext({
    window: { kaspiAdsLinkAudit: () => ({ total: 120 }) },
    adsAuditPeriodSpec: () => ({ days: 180 }),
    showSheet() {},
    document: { getElementById: () => ({ isConnected: true }) },
    apiJson: async () => assert.fail('Kaspi audit should not request WB'),
    paintAdsLinkAudit() {},
  });
  const start = html.indexOf('async function openAdsLinkAudit(period,');
  const end = html.indexOf('\n}', start) + 2;
  vm.runInContext(html.slice(start, end), ctx);
  await ctx.openAdsLinkAudit(undefined, 'Kaspi');
  assert.equal(ctx.window.__adsAuditMarket, 'Kaspi');
  assert.equal(ctx.window.__adsAuditView.kaspi.total, 120);
});
