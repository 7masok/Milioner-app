import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

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
  assert.match(html, /wbAdsMoneyText\(todaySpend\).*за сегодня/);
  assert.match(html, /дневной лимит и защита кампаний всегда работают по сегодняшним данным/);
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
