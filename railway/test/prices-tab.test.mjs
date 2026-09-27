import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
const ui=readFileSync(new URL('../../prices-v1.js',import.meta.url),'utf8');
const server=readFileSync(new URL('../src/server.js',import.meta.url),'utf8');
const api=readFileSync(new URL('../src/prices.js',import.meta.url),'utf8');
const passport=readFileSync(new URL('../../docs/SITE-PASSPORT.md',import.meta.url),'utf8');
const agents=readFileSync(new URL('../../AGENTS.md',import.meta.url),'utf8');

test('Prices is a real ninth tab and survives reload navigation',()=>{
  assert.match(html,/<section id="prices" class="view">/);
  assert.match(html,/data-view="prices"/);
  assert.match(html,/grid-template-columns:repeat\(9,minmax\(0,1fr\)\)/);
  assert.match(html,/\['home','products','prices','movement','purchases','reports','ads','settings','finance'\]/);
  assert.match(html,/view==='prices'.*renderPrices/s);
});

test('Prices UI is static before auth but does not fetch prices on startup',()=>{
  const scriptAt=html.indexOf('./prices-v1.js?v=20260927-prices-tab');
  const authAt=html.lastIndexOf('<script>initOwnerAuth();</script>');
  assert.ok(scriptAt>0&&scriptAt<authAt);
  const runtime=html.slice(html.indexOf('function startAppRuntime(){'),html.indexOf('// Wait for the server-sync module'));
  assert.doesNotMatch(runtime,/market-prices/);
  assert.match(ui,/window\.renderPrices=async function\(force=false\)/);
  assert.match(ui,/if\(!view\|\|!view\.classList\.contains\('active'\)\)return/);
});

test('Prices server keeps marketplace credentials server-side and normalizes all four markets',()=>{
  assert.match(server,/import \{ pricesRouter \} from '\.\/prices\.js'/);
  assert.match(server,/'prices-v1\.js'/);
  assert.match(server,/app\.use\('\/api', pricesRouter\)/);
  assert.match(api,/credentialFor\(market, fallback\)/);
  assert.match(api,/\/api\/v2\/list\/goods\/filter\?limit=1000&offset=/);
  assert.match(api,/\/v5\/product\/info\/prices/);
  assert.match(api,/kaspi_price_template/);
  assert.match(api,/product\.kaspiPrice/);
  assert.doesNotMatch(ui,/Api-Key|Authorization:\s*token|X-Auth-Token/);
});

test('Remote price changes require confirmation and write guards',()=>{
  assert.match(api,/pricesRouter\.post\('\/market-prices\/update', requireWritesEnabled/);
  assert.match(api,/req\.body\?\.confirm !== true/);
  assert.match(api,/\/api\/v2\/upload\/task/);
  assert.match(api,/\/v1\/product\/import\/prices/);
  assert.match(ui,/confirm\('Изменить цену Kaspi/);
  assert.match(ui,/confirm\(question\)/);
  assert.match(ui,/confirm\('Отправить новую цену Ozon/);
  assert.match(ui,/confirm:true/);
});

test('WB size-specific prices cannot be flattened by the generic editor',()=>{
  assert.match(api,/canEditPrice: uniquePrices\.length <= 1/);
  assert.match(ui,/row\.canEditPrice===false/);
  assert.match(ui,/разные цены по размерам/);
  assert.match(ui,/здесь можно менять только общую скидку/);
});

test('Prices UI preserves selected market and search but not price truth',()=>{
  assert.match(ui,/PRICE_UI_KEY=.*_prices_ui_v1/);
  assert.match(ui,/localStorage\.setItem\(PRICE_UI_KEY/);
  assert.match(ui,/priceUi\.market/);
  assert.match(ui,/priceUi\.q/);
  assert.match(ui,/fetch\(url,\{cache:'no-store'\}\)/);
});

test('Passport and AGENTS define the Prices contract',()=>{
  assert.match(passport,/\| Цены \|/);
  assert.match(passport,/Нижняя навигация содержит девять разделов/);
  for(const rule of ['PRICE-01','PRICE-02','PRICE-03','PRICE-04','PRICE-05','PRICE-06','PRICE-07','PRICE-08'])assert.match(passport,new RegExp(rule));
  assert.match(agents,/Во вкладке «Цены»/);
  assert.match(agents,/явного подтверждения/);
});
