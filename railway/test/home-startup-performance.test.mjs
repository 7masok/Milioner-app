import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
const cloud=readFileSync(new URL('../../cloud-sync-v3.js',import.meta.url),'utf8');
const ads=readFileSync(new URL('../../kaspi-ads-v2.js',import.meta.url),'utf8');
const report=readFileSync(new URL('../../kaspi-report-v2.js',import.meta.url),'utf8');
const ozon=readFileSync(new URL('../../ozon-fbo-v1.js',import.meta.url),'utf8');
const compat=readFileSync(new URL('../../reservation-compat-v1.js',import.meta.url),'utf8');
const repair=readFileSync(new URL('../../save-conflict-v1.js',import.meta.url),'utf8');
const bell=readFileSync(new URL('../../stock-alerts-rescue-v1.js',import.meta.url),'utf8');
const server=readFileSync(new URL('../src/server.js',import.meta.url),'utf8');

test('Home header has final geometry in static HTML',()=>{
  const start=html.indexOf('<header>');
  const end=html.indexOf('</header>',start);
  const header=html.slice(start,end);
  for(const id of ['aiAssistantButton','stockAlertBell','syncNowButton','kaspiStatusRow','wb1StatusRow','wb2StatusRow','ozonStatusRow','cloudStatus']){
    assert.match(header,new RegExp('id="'+id+'"'));
  }
  assert.match(header,/class="sync sync-compact" data-compact-built="1"/);
  assert.match(header,/class="head-actions"/);
  assert.match(html,/#stockAlertBell\.stock-alert-button\{[^}]*flex:0 0 44px/);
  assert.match(html,/\.compact-cloud\{[^}]*width:132px;min-width:132px;flex:0 0 132px/);
  assert.match(html,/#cloudStatus\{[^}]*width:76px;min-width:76px/);
});

test('Home paints cached orders and market status before network refresh',()=>{
  for(const name of ['HOME_CACHE_KEY','function writeHomeCache()','function hydrateHomeCache()'])assert.ok(html.includes(name),name);
  assert.match(html,/homeOrdersSettled=true;/);
  assert.match(html,/state\.kaspiOrderFeed=rows\.filter/);
  assert.match(html,/state\.wbOrderFeed=rows\.filter/);
  assert.match(html,/homeCacheWriteScheduled/);
  assert.match(html,/HOME_CACHE_FRESH_MS=10\*60\*1000/);
  assert.match(html,/verifiedAt:Number\(homeCacheVerifiedAt\|\|0\)/);
  assert.match(html,/Date\.now\(\)-verifiedAt>HOME_CACHE_FRESH_MS/);
  assert.match(html,/if\(allOrders\.status==='fulfilled'\)homeCacheVerifiedAt=Date\.now\(\)/);
  assert.match(html,/render\(\);writeHomeCache\(\)/);
  assert.match(html,/function paintCachedHomeHeader\(cached\)/);
  assert.ok(html.indexOf('paintCachedHomeHeader(cached)')<html.indexOf('Date.now()-verifiedAt>HOME_CACHE_FRESH_MS'));
  const start=html.indexOf('function startAppRuntime(){');
  const end=html.indexOf('// Wait for the server-sync module',start);
  const runtime=html.slice(start,end);
  assert.ok(runtime.indexOf('hydrateHomeCache()')<runtime.indexOf('openView(startupView,false)'));
  assert.ok(runtime.indexOf('openView(startupView,false)')<runtime.indexOf('bootstrapWarehouseFromServer()'));
  assert.match(html,/requestIdleCallback\(run,\{timeout:1500\}\)/);
});


test('Home UI preferences are resolved before auth can reveal the app',()=>{
  const vars=html.slice(html.indexOf('let marketplaceReportContext=null;'),html.indexOf('let warehouseRemoteReady=',html.indexOf('let marketplaceReportContext=null;')));
  assert.match(vars,/milioner_order_period_ui_v1/);
  assert.match(vars,/milioner_order_market_ui_v2/);
  assert.match(vars,/homeOrderPeriodUiPreference\.mode/);
  assert.match(vars,/homeOrderMarketUiPreference\.market/);
  const helperStart=html.indexOf('function startOwnerRuntimeAfterAuth()');
  const helperEnd=html.indexOf('\nasync function initOwnerAuth()',helperStart);
  const helper=html.slice(helperStart,helperEnd);
  assert.match(helper,/cloudStatus\('онлайн','ok'\)/);
  assert.ok(helper.indexOf("setOwnerAuthMode('ready')")<helper.indexOf('startAppRuntime()'));
  const auth=html.slice(html.indexOf('async function initOwnerAuth()'),html.indexOf('function rememberOwnerSession',html.indexOf('async function initOwnerAuth()')));
  assert.match(auth,/if\(check\.ok\)\{startOwnerRuntimeAfterAuth\(\);return\}/);
  assert.doesNotMatch(cloud,/\[0,250,800,1800,3500\]/);
  assert.doesNotMatch(cloud,/showMarketSyncTimes\(\);restoreOrderMarketUi/);
  assert.doesNotMatch(cloud,/render\(\);setTimeout\(restoreOrderMarketUi,0\)/);
});

test('Home startup does not run report, Ozon or compatibility fetches',()=>{
  assert.doesNotMatch(compat,/loadSharedOrderCache/);
  assert.doesNotMatch(ads,/stock-alerts-rescue-v1\.js/);
  assert.doesNotMatch(report,/setTimeout\(\(\)=>window\.refreshAllMarketUnitProfit\(\),1500\)/);
  assert.doesNotMatch(report,/setTimeout\(\(\)=>window\.refreshAllMarketUnitProfit\(\),7000\)/);
  assert.doesNotMatch(report,/kaspiPayImports\)\)\{delete state\.kaspiPayImports;setTimeout/);
  const tail=ozon.slice(ozon.lastIndexOf('ensureReportTab();'));
  assert.doesNotMatch(tail,/\nload\(\)\.then/);
  const repairStart=repair.indexOf('function repairMarketplaceUi(){');
  const repairEnd=repair.indexOf('\nfunction installMarketplaceUiRepair',repairStart);
  assert.doesNotMatch(repair.slice(repairStart,repairEnd),/refreshOzonCompactStatus\(\)/);
});

test('expensive finance, Ozon and maintenance work are deferred off first Home paint',()=>{
  const start=html.indexOf('function startAppRuntime(){');
  const end=html.indexOf('// Wait for the server-sync module',start);
  const runtime=html.slice(start,end);
  assert.match(runtime,/setTimeout\(\(\)=>bootstrapFinance\(\),financePriority\?0:1800\)/);
  assert.match(runtime,/ozonFboRefreshStatus\?\.\(\)/);
  assert.match(runtime,/\),3200\);setTimeout\(\(\)=>Promise\.resolve\(loadStorageStatus/);
  assert.match(runtime,/loadStorageStatus\(\{silent:true\}\)\)\.catch\(\(\)=>\{\}\),6500/);
  assert.match(runtime,/setTimeout\(\(\)=>maybeAutoGoogleBackup\(\),10000\)/);
  assert.ok(runtime.indexOf('openView(startupView,false)')<runtime.indexOf('ozonFboRefreshStatus?.()'));
  assert.doesNotMatch(runtime,/hydrateWarehouseFromLocalCache\(\);hydrateHomeCache\(\)/);
});

test('static assets can revalidate while API responses stay no-store',()=>{
  assert.match(server,/frontendRevalidateHeaders = \{ 'Cache-Control': 'public, max-age=0, must-revalidate' \}/);
  assert.match(server,/app\.use\('\/api', noStore\)/);
  assert.doesNotMatch(server,/app\.use\(noStore\)/);
  const staticAt=server.indexOf("app.get(['/', '/index.html']");
  const apiNoStoreAt=server.indexOf("app.use('/api', noStore)");
  assert.ok(staticAt>0&&apiNoStoreAt>staticAt);
});

test('bell is present immediately and does not pulse on first paint',()=>{
  assert.match(html,/id="stockAlertBell"/);
  assert.match(html,/stock-alerts-rescue-v1\.js\?v=20260924-stable-header/);
  assert.match(bell,/let lastSignature=null/);
  assert.match(bell,/const hadPrevious=lastSignature!==null/);
  assert.match(bell,/if\(hadPrevious&&unread\.length\)/);
});

test('compact status renderer paints Ozon without rebuilding the header',()=>{
  assert.match(cloud,/document\.querySelector\('\.sync\.sync-compact\[data-compact-built="1"\]'\)/);
  assert.match(cloud,/paint\('Ozon','dotOzonTop','ozonTopStatus'\)/);
});
