import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
const ui=readFileSync(new URL('../../prices-v1.js',import.meta.url),'utf8');
const server=readFileSync(new URL('../src/server.js',import.meta.url),'utf8');
const api=readFileSync(new URL('../src/prices.js',import.meta.url),'utf8');
const passport=readFileSync(new URL('../../docs/SITE-PASSPORT.md',import.meta.url),'utf8');
const agents=readFileSync(new URL('../../AGENTS.md',import.meta.url),'utf8');
const wbPriceMigration=readFileSync(new URL('../migrations/131_wb_price_sync_queue.sql',import.meta.url),'utf8');
const wbPromo=readFileSync(new URL('../src/wb-promotions.js',import.meta.url),'utf8');
const wbPromoMigration=readFileSync(new URL('../migrations/132_wb_promo_preferences.sql',import.meta.url),'utf8');
const wbPromoPhaseMigration=readFileSync(new URL('../migrations/133_wb_promo_sync_phase.sql',import.meta.url),'utf8');
const wbNightMigration=readFileSync(new URL('../migrations/134_wb_price_schedules.sql',import.meta.url),'utf8');
const wbUploadVerifyMigration=readFileSync(new URL('../migrations/135_wb_price_upload_verification.sql',import.meta.url),'utf8');

test('Prices is a real ninth tab and survives reload navigation',()=>{
  assert.match(html,/<section id="prices" class="view">/);
  assert.match(html,/data-view="prices"/);
  assert.match(html,/grid-template-columns:repeat\(9,minmax\(0,1fr\)\)/);
  assert.match(html,/\['home','products','prices','movement','purchases','reports','ads','settings','finance'\]/);
  assert.match(html,/view==='prices'.*renderPrices/s);
});

test('Prices UI is static before auth but does not fetch prices on startup',()=>{
  const scriptAt=html.indexOf('./prices-v1.js?v=20260928-night-price');
  const authAt=html.lastIndexOf('<script>initOwnerAuth();</script>');
  assert.ok(scriptAt>0&&scriptAt<authAt);
  const runtime=html.slice(html.indexOf('function startAppRuntime(){'),html.indexOf('// Wait for the server-sync module'));
  assert.doesNotMatch(runtime,/market-prices/);
  assert.match(ui,/window\.renderPrices=async function\(force=false\)/);
  assert.match(ui,/if\(!view\|\|!view\.classList\.contains\('active'\)\)return/);
});

test('Prices server keeps marketplace credentials server-side and normalizes all four markets',()=>{
  assert.match(server,/import \{ pricesRouter, startWbPriceSyncLoop \} from '\.\/prices\.js'/);
  assert.match(server,/'prices-v1\.js'/);
  assert.match(server,/app\.use\('\/api', pricesRouter\)/);
  assert.match(api,/credentialFor\(market, fallback\)/);
  assert.match(api,/\/api\/v2\/list\/goods\/filter\?limit=/);
  assert.match(api,/WB_PRICE_PAGE_LIMIT = 1000/);
  assert.match(api,/\/v5\/product\/info\/prices/);
  assert.match(api,/kaspi_price_template/);
  assert.match(api,/product\?\.kaspiPrice/);
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

test('WB size-specific prices cannot be flattened by the generic editor or server',()=>{
  assert.match(api,/canEditPrice: uniquePrices\.length <= 1/);
  assert.match(ui,/row\.canEditPrice===false/);
  assert.match(ui,/[Рр]азные цены по размерам/);
  assert.match(ui,/меняется только скидка/);
  assert.match(api,/wbSnapshotRowForWrite\(market, nmID\)/);
  assert.match(api,/разные цены по размерам\. Общую цену менять нельзя/);
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
  assert.match(agents,/фоновый цикл/);
  assert.match(agents,/не отправляются немедленно/);
});


test('WB prices use a persistent 15-minute server sync instead of browser-driven upstream reads',()=>{
  assert.match(api,/WB_PRICE_SLOT_MS = 15 \* 60 \* 1000 \+ 5_000/);
  assert.match(api,/export function startWbPriceSyncLoop\(\)/);
  assert.match(server,/startWbPriceSyncLoop\(\)/);
  assert.match(api,/wb_price_sync_state/);
  assert.match(api,/wb_price_snapshots/);
  assert.match(api,/wb_price_update_queue/);
  assert.match(api,/x-ratelimit-retry/);
  assert.match(api,/retry-after/);
  assert.match(api,/Math\.max\(now \+ WB_PRICE_SLOT_MS, Number\(error\?\.retryAt \|\| 0\)\)/);
  assert.match(api,/if \(market === 'WB' \|\| market === 'WB2'\) return res\.json\(await listWbPrices\(market\)\)/);
});

test('Refreshing WB prices reloads only the Railway snapshot and never forces a WB API call',()=>{
  assert.doesNotMatch(ui,/priceCache\.delete\(priceUi\.market\)/);
  assert.match(ui,/PRICE_CLIENT_TTL_MS/);
  assert.match(ui,/remoteForce=force&&market!=='WB'&&market!=='WB2'/);
  assert.match(ui,/serverSnapshot/);
  assert.match(ui,/wbServerStatus\(data\)/);
  const route=api.slice(api.indexOf("pricesRouter.get('/market-prices'"),api.indexOf("pricesRouter.post('/market-prices/update'"));
  assert.doesNotMatch(route,/requestWb\(/);
  assert.match(route,/listWbPrices\(market\)/);
});

test('WB editor sends only the fields that actually changed',()=>{
  assert.match(ui,/const priceChanged=/);
  assert.match(ui,/const discountChanged=/);
  assert.match(ui,/if\(priceChanged\)body\.price=enteredPrice/);
  assert.match(ui,/if\(discountChanged\)body\.discount=enteredDiscount/);
  assert.doesNotMatch(ui,/remotePriceUpdate\(\{market:row\.market,remoteId:row\.remoteId,price,discount\}\)/);
});

test('Marketplace price APIs reject malformed success payloads',()=>{
  assert.match(api,/WB цены: некорректный ответ API/);
  assert.match(api,/Ozon цены: некорректный ответ API/);
  assert.match(api,/WB не вернул корректное подтверждение операции/);
  assert.match(api,/Ozon не вернул результат обновления цены/);
  assert.match(api,/result\.updated !== true/);
});

test('WB edits are queued locally while Ozon keeps its immediate write invalidation',()=>{
  const submitStart=ui.indexOf("window.submitPriceEdit");
  const wbSubmit=ui.slice(ui.indexOf("if(row.market==='WB'||row.market==='WB2'){",submitStart),ui.indexOf("if(row.market==='Ozon'){",submitStart));
  assert.match(wbSubmit,/row\.syncState='pending'/);
  assert.doesNotMatch(wbSubmit,/bumpPriceEpoch\(/);
  assert.match(api,/return queueWbPrice\(market, input\)/);
  assert.match(api,/status='pending'/);
  assert.match(ui,/bumpPriceEpoch\('Ozon'\)/);
});


test('WB pagination spends at most one upstream request per sync slot',()=>{
  assert.match(api,/async function fetchWbPricePage\(market, token, offset\)/);
  assert.match(api,/const batch = await fetchWbPricePage\(market, token, Number\(state\.readOffset \|\| 0\)\)/);
  assert.match(api,/if \(batch\.length >= WB_PRICE_PAGE_LIMIT\)/);
  assert.match(api,/readOffset: offset \+ WB_PRICE_PAGE_LIMIT/);
  assert.match(api,/readBuffer: combined/);
  assert.match(api,/nextAllowedAt: now \+ WB_PRICE_SLOT_MS/);
});


test('Prices can sort by price in both directions and remember the choice',()=>{
  assert.match(html,/id="priceSortButton"/);
  assert.match(html,/onclick="priceToggleSort\(\)"/);
  assert.match(ui,/priceUi=\{market:'Kaspi',q:'',sort:'asc',hidden:\{\},groupFilter:'all',groupId:''\}/);
  assert.match(ui,/saved\.sort==='desc'\|\|saved\.sort==='asc'/);
  assert.match(ui,/function priceSortValue\(row\)/);
  assert.match(ui,/priceUi\.sort==='desc'\?bv-av:av-bv/);
  assert.match(ui,/window\.priceToggleSort=function\(\)/);
  assert.match(ui,/Цена ↓/);
  assert.match(ui,/Цена ↑/);
});


test('Prices can hide unwanted products without deleting marketplace or warehouse cards',()=>{
  assert.match(html,/id="priceHiddenButton"/);
  assert.match(html,/onclick="openHiddenPrices\(\)"/);
  assert.match(ui,/hidden:\{\}/);
  assert.match(ui,/function priceRowKey\(row\)/);
  assert.match(ui,/function priceIsHidden\(row/);
  assert.match(ui,/window\.hidePriceRow=function\(index\)/);
  assert.match(ui,/window\.openHiddenPrices=function\(\)/);
  assert.match(ui,/window\.restorePriceRow=function\(index\)/);
  assert.match(ui,/window\.restoreAllPriceRows=function\(\)/);
  assert.match(ui,/Скрыть из списка/);
  assert.match(ui,/Все позиции этого магазина скрыты/);
  const hide=ui.slice(ui.indexOf('window.hidePriceRow=function()'),ui.indexOf('window.openHiddenPrices=function()'));
  assert.doesNotMatch(hide,/fetch\(|remotePriceUpdate|state\.products/);
});


test('A short WB price page completes and persists the snapshot in the same slot',()=>{
  assert.match(api,/const normalized = await normalizeWbPriceRows\(market, combined\)/);
  assert.match(api,/INSERT INTO wb_price_snapshots/);
  assert.match(api,/lastAction: 'read'/);
  assert.match(api,/readOffset: 0/);
  assert.match(api,/readBuffer: \[\]/);
});


test('WB price queue is durable, last-value-wins and survives deploys',()=>{
  assert.match(wbPriceMigration,/CREATE TABLE IF NOT EXISTS wb_price_snapshots/);
  assert.match(wbPriceMigration,/CREATE TABLE IF NOT EXISTS wb_price_sync_state/);
  assert.match(wbPriceMigration,/CREATE TABLE IF NOT EXISTS wb_price_update_queue/);
  assert.match(wbPriceMigration,/PRIMARY KEY \(market,nm_id\)/);
  assert.match(api,/ON CONFLICT\(market,nm_id\) DO UPDATE SET/);
  assert.match(api,/desired_price=COALESCE\(excluded\.desired_price,wb_price_update_queue\.desired_price\)/);
  assert.match(api,/desired_discount=COALESCE\(excluded\.desired_discount,wb_price_update_queue\.desired_discount\)/);
  assert.match(api,/status='pending',queued_at=excluded\.queued_at/);
});

test('WB queued writes batch changes and verify them only on a later read slot',()=>{
  assert.match(api,/body: JSON\.stringify\(\{ data: selected\.map/);
  assert.match(api,/SET status='sent'/);
  assert.match(api,/lastAction: 'write'/);
  assert.match(api,/row\.status === 'sent'/);
  assert.match(api,/DELETE FROM wb_price_update_queue WHERE market=\$1 AND nm_id=\$2/);
  assert.match(api,/WB обработал загрузку, ждём отражения цены/);
  assert.match(ui,/Ожидает отправки в WB/);
  assert.match(ui,/Отправлено в WB · ждём проверки/);
  assert.match(ui,/>Сохранить<\/button>/);
});


test('Price cards expand inline instead of opening the shared sheet editor',()=>{
  assert.match(ui,/let priceExpanded=null/);
  assert.match(ui,/function priceInlineEditor\(row,index\)/);
  assert.match(ui,/class="price-card-toggle"/);
  assert.match(ui,/aria-expanded=/);
  assert.match(ui,/window\.openPriceEditor=function\(index\)/);
  assert.match(ui,/window\.collapsePriceEditor=function\(\)/);
  assert.match(ui,/window\.submitPriceEdit=async function\(index\)/);
  assert.match(html,/\.price-inline-editor\{/);
  assert.match(html,/\.price-card-toggle\{/);
  const open=ui.slice(ui.indexOf('window.openPriceEditor=function(index)'),ui.indexOf('async function remotePriceUpdate'));
  assert.doesNotMatch(open,/showSheet\(/);
  assert.doesNotMatch(open,/closeModal\(/);
  assert.match(open,/priceExpanded=same\?null:/);
});


test('Inline price editor stays compact and avoids explanatory blocks',()=>{
  assert.match(ui,/price-inline-fields/);
  assert.match(ui,/price-inline-actions/);
  assert.match(ui,/>Сохранить<\/button>/);
  assert.match(ui,/>Скрыть<\/button>/);
  const inline=ui.slice(ui.indexOf('function priceInlineEditor'),ui.indexOf('function priceCard'));
  assert.doesNotMatch(inline,/price-inline-collapse/);
  assert.doesNotMatch(inline,/link-note/);
  assert.doesNotMatch(inline,/Изменение сохранится/);
  assert.match(html,/\.price-inline-editor\{[^}]*padding:7px 10px 9px/);
  assert.match(html,/\.price-inline-fields\{display:grid;grid-template-columns:1fr 1fr/);
  assert.match(html,/height:36px/);
});


test('WB promotion checkbox is compact and only exists in WB editor',()=>{
  const inline=ui.slice(ui.indexOf('function priceInlineEditor'),ui.indexOf('function priceCard'));
  const wb=inline.slice(inline.indexOf("if(row.market==='WB'||row.market==='WB2')"),inline.indexOf("if(row.market==='Ozon')"));
  const kaspi=inline.slice(inline.indexOf("if(row.market==='Kaspi')"),inline.indexOf("if(row.market==='WB'"));
  assert.match(wb,/price-promo-toggle/);
  assert.match(wb,/togglePricePromo\(/);
  assert.match(wb,/>Акции<\/label>/);
  assert.doesNotMatch(kaspi,/price-promo-toggle/);
  assert.match(html,/\.price-inline-actions\.wb\{grid-template-columns:auto 1fr auto\}/);
  assert.match(ui,/window\.togglePricePromo=async function\(index,enabled\)/);
  assert.match(ui,/\/api\/market-prices\/promo/);
});

test('WB promotion automation scans regular promotions in persisted safe steps and respects WB retry headers',()=>{
  assert.match(server,/wbPromotionsRouter, startWbPromotionLoop/);
  assert.match(server,/app\.use\('\/api', wbPromotionsRouter\)/);
  assert.match(server,/startWbPromotionLoop\(\)/);
  assert.match(wbPromo,/https:\/\/dp-calendar-api\.wildberries\.ru/);
  assert.match(wbPromo,/\/api\/v1\/calendar\/promotions\?/);
  assert.match(wbPromo,/\/api\/v1\/calendar\/promotions\/nomenclatures\?/);
  assert.match(wbPromo,/\/api\/v1\/calendar\/promotions\/upload/);
  assert.match(wbPromo,/cleanText\(item\?\.type\)\.toLowerCase\(\) === 'regular'/);
  assert.match(wbPromo,/WB_PROMO_SLOT_MS = 60 \* 60 \* 1000 \+ 5_000/);
  assert.match(wbPromo,/WB_PROMO_MIN_INTERVAL_MS = WB_PROMO_SLOT_MS/);
  assert.match(wbPromo,/WB_PROMO_FALLBACK_COOLDOWN_MS = WB_PROMO_SLOT_MS/);
  assert.match(wbPromo,/WB_PROMO_MAX_CAMPAIGNS = 10/);
  assert.match(wbPromo,/eligibleIndex/);
  assert.match(wbPromo,/betterPromoCandidate/);
  assert.match(wbPromo,/state\.phase === 'eligible'/);
  assert.match(wbPromo,/state\.phase === 'upload'/);
  assert.match(wbPromo,/state\.phase === 'verify'/);
  assert.match(wbPromo,/Math\.max\(now \+ WB_PROMO_FALLBACK_COOLDOWN_MS, Number\(error\?\.retryAt \|\| 0\)\)/);
  assert.match(wbPromoPhaseMigration,/ADD COLUMN IF NOT EXISTS phase/);
  assert.match(wbPromoPhaseMigration,/ADD COLUMN IF NOT EXISTS payload JSONB/);
});

test('WB promotion scan never restores seller discount just because no regular candidate was found',()=>{
  const list=wbPromo.slice(wbPromo.indexOf('async function promoListStep'),wbPromo.indexOf('async function promoEligibleStep'));
  const eligible=wbPromo.slice(wbPromo.indexOf('async function promoEligibleStep'),wbPromo.indexOf('async function promoUploadStep'));
  assert.doesNotMatch(list,/restorePromoDiscountIfNeeded/);
  assert.doesNotMatch(eligible,/restorePromoDiscountIfNeeded/);
  assert.doesNotMatch(wbPromo,/async function restorePromoDiscountIfNeeded/);
  assert.match(wbPromo,/!enabled && effectiveDiscount !== baseDiscount/);
});

test('WB promotion automation does not pretend that public API can manage auto promotions',()=>{
  assert.match(wbPromo,/type\)\.toLowerCase\(\) === 'auto'/);
  assert.match(wbPromo,/status: 'auto_only'/);
  assert.match(wbPromo,/WB API не поддерживает управление автоакциями/);
  assert.match(ui,/Автоакции вручную/);
});

test('WB promotion preferences persist and promo changes cannot overwrite a manual queue item',()=>{
  assert.match(wbPromoMigration,/CREATE TABLE IF NOT EXISTS wb_promo_preferences/);
  assert.match(wbPromoMigration,/CREATE TABLE IF NOT EXISTS wb_promo_sync_state/);
  assert.match(wbPromoMigration,/ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual'/);
  assert.match(wbPromoMigration,/source IN \('manual','promo'\)/);
  assert.match(wbNightMigration,/source IN \('manual','promo','schedule'\)/);
  assert.match(wbPromo,/WHERE wb_price_update_queue\.source='promo'/);
  assert.match(api,/source='manual',promotion_id=0/);
  assert.match(api,/UPDATE wb_promo_preferences SET base_discount=/);
  assert.match(wbPromo,/\/market-prices\/promo\/bulk/);
  assert.match(wbPromo,/applyPromoPreferenceChange/);
  assert.match(wbPromo,/next_sync_at=CASE WHEN wb_promo_sync_state\.next_sync_at>\$2/);
});

test('WB promotions lower the effective price with discount and restore the previous discount when automation stops',()=>{
  assert.match(wbPromo,/function requiredDiscount\(row, candidate\)/);
  assert.match(wbPromo,/planDiscount/);
  assert.match(wbPromo,/currentFinal <= (?:candidate\.)?planPrice \+ 0\.01/);
  assert.match(wbPromo,/status: queued \? 'price_pending' : 'manual_pending'/);
  assert.match(wbPromo,/uploadNow: true/);
  assert.match(wbPromo,/status: 'participating'/);
  assert.match(wbPromo,/!enabled && effectiveDiscount !== baseDiscount/);
  assert.match(wbPromo,/queuePromoDiscount\(market, String\(nmId\), baseDiscount, 0, client\)/);
});

test('WB price rows expose persisted promotion state without browser calls to WB',()=>{
  assert.match(api,/decorateWbPromotionRows\(market, queuedRows\)/);
  assert.match(wbPromo,/row\.promoEnabled = Boolean\(pref\?\.enabled\)/);
  assert.match(wbPromo,/row\.promoStatus = cleanText\(pref\?\.status\)/);
  assert.match(ui,/price-promo-badge/);
  assert.doesNotMatch(ui,/dp-calendar-api\.wildberries\.ru/);
});


test('WB promotion state is visible on every collapsed card',()=>{
  assert.match(ui,/В акции/);
  assert.match(ui,/Ждёт акцию/);
  assert.match(ui,/Без акции/);
  assert.match(ui,/price-promo-badge/);
  assert.match(html,/\.price-promo-badge\.off/);
  assert.match(html,/\.price-promo-badge\.waiting/);
});

test('WB bulk promotion controls can select all visible rows and enable or disable them together',()=>{
  assert.match(html,/id="priceBulkTools"/);
  assert.match(html,/id="priceSelectAll"/);
  assert.match(html,/id="priceBulkEnablePromo"/);
  assert.match(html,/id="priceBulkDisablePromo"/);
  assert.match(html,/class="price-bulk-selection"/);
  assert.match(html,/class="price-bulk-actions"/);
  assert.match(html,/\.price-bulk-actions\{display:grid;grid-template-columns:repeat\(4,minmax\(0,1fr\)\);gap:10px\}/);
  assert.match(html,/\.price-bulk-actions \.btn\{[^}]*min-height:42px/);
  assert.match(html,/@media\(max-width:420px\)\{\.price-bulk-tools\{[^}]*gap:9px[^}]*\}\.price-bulk-actions\{gap:9px\}\.price-bulk-actions \.btn\{[^}]*min-height:44px/);
  assert.match(ui,/const priceSelected=\{WB:new Set\(\),WB2:new Set\(\)\}/);
  assert.match(ui,/window\.priceSelectAllVisible=function\(checked\)/);
  assert.match(ui,/window\.priceSelectRow=function\(index,checked\)/);
  assert.match(ui,/window\.priceBulkPromo=async function\(enabled\)/);
  assert.match(ui,/\/api\/market-prices\/promo\/bulk/);
  assert.match(ui,/class="price-row-select"/);
  assert.match(html,/\.price-row-select\{[^}]*right:8px[^}]*width:52px[^}]*height:48px/);
  assert.match(html,/\.price-item:has\(\.price-row-select\) \.price-card-toggle\{padding-right:92px\}/);
  assert.match(html,/\.price-item:has\(\.price-row-select\) \.price-chevron\{[^}]*width:32px[^}]*height:44px/);
});


test('WB night schedule accepts normal HH:MM time values',()=>{
  assert.match(api,/const match = \/\^\(\\d\{2\}\):\(\\d\{2\}\)\$\//);
  assert.doesNotMatch(api,/const match = \/\^\(\\\\d\{2\}\):\(\\\\d\{2\}\)\$\//);
});

test('WB night price restore stays below the configured 2x category quarantine threshold',()=> {
  assert.match(api,/export function wbSafeReturnPrice\(currentPrice, basePrice\)/);
  assert.match(api,/Math\.ceil\(current \/ 1\.9\)/);
  assert.match(api,/function isWbGradualReductionError\(value\)/);
  assert.match(api,/more than\.\*twice/);
  assert.match(api,/!isWbGradualReductionError\(schedule\.lastError\)/);
  assert.match(api,/queueSchedulePrice\(market, schedule\.nmId, restoreTarget\)/);
});

test('WB price sync verifies upload details before retrying a rejected update',()=> {
  assert.match(wbUploadVerifyMigration,/status IN \('pending','sent','checking','held'\)/);
  assert.match(api,/\/api\/v2\/history\/goods\/task\?limit=1000&offset=0&uploadID=/);
  assert.match(api,/async function inspectWbPriceUpload\(market, token, sentRows, now\)/);
  assert.match(api,/status='checking'/);
  assert.match(api,/WB price sync verify/);
  assert.match(api,/sent\.length \? 'verify' : pending\.length \? 'write' : 'read'/);
  assert.doesNotMatch(api,/SET status='pending',sent_at=0,upload_id=0,\s*last_error='WB ещё не подтвердил изменение'/);
  assert.match(api,/WB обработал загрузку, ждём отражения цены/);
});

test('WB night price schedule is persisted, bulk-configurable and reuses the 15-minute price queue',()=>{
  assert.match(wbNightMigration,/CREATE TABLE IF NOT EXISTS wb_price_schedules/);
  assert.match(wbNightMigration,/status IN \('pending','sent','held'\)/);
  assert.match(api,/ALMATY_OFFSET_MS = 5 \* 60 \* 60 \* 1000/);
  assert.match(api,/export function wbNightWindowState\(startMinute, endMinute, now = Date\.now\(\)\)/);
  assert.match(api,/async function syncWbNightSchedules\(market, now = Date\.now\(\)\)/);
  assert.match(api,/await syncWbNightSchedules\(market, now\)/);
  assert.match(api,/source='schedule'/);
  assert.match(api,/status='held'/);
  assert.match(api,/markManualScheduleOverride/);
  assert.match(api,/pricesRouter\.post\('\/market-prices\/night-schedule', requireWritesEnabled/);
  assert.match(html,/id="priceBulkNight"/);
  assert.match(ui,/window\.openPriceNightSchedule=function\(\)/);
  assert.match(ui,/window\.savePriceNightSchedule=async function\(enabled\)/);
  assert.match(ui,/\/api\/market-prices\/night-schedule/);
  assert.match(ui,/price-night-badge/);
  assert.match(passport,/PRICE-18/);
  assert.match(agents,/действие «Ночь»/);
});

test('Saving an unchanged WB price after toggling promotions closes quietly',()=>{
  assert.match(ui,/if\(!priceChanged&&!discountChanged\)\{priceExpanded=null;paintPrices\(\);return;\}/);
  assert.doesNotMatch(ui,/throw new Error\('Цена и скидка не изменились'\)/);
});
