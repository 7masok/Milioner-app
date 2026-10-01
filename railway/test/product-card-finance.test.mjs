import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
const report=readFileSync(new URL('../../kaspi-report-v2.js',import.meta.url),'utf8');
const compat=readFileSync(new URL('../../kaspi-status-compat-v1.js',import.meta.url),'utf8');
const kaspiAds=readFileSync(new URL('../../kaspi-ads-v2-original.js',import.meta.url),'utf8');

test('product list uses one selected period for sales profit and stock days',()=>{
  const line=html.split('\n').find(row=>row.startsWith('function productCard('))||'';
  assert.match(line,/period=productRankSpec\(\)/);
  assert.match(line,/Продано · \$\{esc\(period\.label\)\}/);
  assert.match(line,/Прибыль · \$\{esc\(profitLabel\)\}/);
  assert.match(line,/profitLabel=period\?\.label\|\|'30 дней'/);
  assert.match(line,/avgPerDay=periodReady&&period\.dayCount>0\?qty\/period\.dayCount:0/);
  const start=html.indexOf('function renderProducts(rebuildStats=false){');
  const end=html.indexOf('\nfunction wbRelinkNotice(',start);
  const render=html.slice(start,end);
  assert.match(render,/period=productRankSpec\(\)/);
  assert.match(render,/rankSpec=period,rankStats=periodStats,rankReady=periodReady/);
  assert.match(render,/periodStats\.get\(String\(p\.id\)\).*periodStats\.get\(String\(p\.id\)\).*period\.label/);
  assert.doesNotMatch(html,/PRODUCT_CARD_PROFIT_SPEC/);
});

test('opening Products warms only the selected-period analytics payload',()=>{
  const start=html.indexOf('function openView(view,remember=true){');
  const end=html.indexOf("document.querySelectorAll('nav button').forEach(b=>b.onclick",start);
  const fn=html.slice(start,end);
  assert.match(fn,/if\(view==='products'\)setTimeout\(\(\)=>\{Promise\.resolve\(ensureProductRankStats\(\)\)/);
  assert.doesNotMatch(fn,/ensureProductPeriodStats\(\)/);
  assert.doesNotMatch(fn,/ensureProductCardProfitStats\(\)/);
});

test('projected stock profit uses the same selected-period unit profit as product cards',()=>{
  assert.match(html,/Ожидаемая прибыль с остатка/);
  assert.match(html,/onclick="openStockProfitBreakdown\(\)"/);
  assert.match(html,/function warehouseProjectedProfitRows\(profitStats,stockMap=null\)/);
  assert.match(html,/async function openStockProfitBreakdown\(\)\{try\{const spec=productRankSpec\(\);let periodStats=currentProductPeriodStats\(spec\)/);
  assert.match(html,/await ensureProductRankStats\(\)/);
  assert.match(html,/rows=warehouseProjectedProfitRows\(periodStats,productValuationStockMap\(inventory\)\)/);
  assert.match(html,/чистая прибыль на 1 проданную штуку за '\+esc\(label\)/);
  assert.match(html,/Чистая прибыль на 1 шт\. рассчитана за '\+esc\(label\)/);
});

test('buyer-transit profit uses the same selected-period average and opens a detailed breakdown',()=>{
  assert.match(html,/onclick="openToBuyerProfitBreakdown\(\)"/);
  assert.match(html,/function marketplaceToBuyerProfitRows\(periodStats,snapshot=marketplaceToBuyerSnapshot\(\)\)/);
  assert.match(html,/marketProductQtyMap=new Map\(\)/);
  assert.match(html,/projected=transitQty\*unitProfit/);
  assert.match(html,/const title='Прибыль в пути до покупателя',spec=productRankSpec\(\)/);
  assert.match(html,/let periodStats=currentProductPeriodStats\(spec\)/);
  assert.match(html,/await ensureProductRankStats\(\)/);
  assert.match(html,/количество в пути до покупателя × средняя чистая прибыль на 1 проданную штуку за '\+esc\(spec\.label\)/);
  assert.match(html,/Продано · '\+esc\(spec\.label\).*средняя прибыль \/ шт\./);
});

test('stock valuation uses sale plus covered reserve plus warehouse stock',()=>{
  assert.match(html,/function productValuationStockMap\(stats\)/);
  assert.match(html,/available\+coveredReserve\+warehouse/);
  assert.match(html,/atWarehouseCostMap=new Map\(\)/);
  assert.match(html,/productMapAdd\(atWarehouseCostMap,key,qty\*Math\.max\(0,Number\(row\.landedUnitCost\)\|\|Number\(row\.unitCost\)\|\|0\)\)/);
  assert.match(html,/total\+=value\+Math\.max\(0,Number\(stats\?\.atWarehouseCostMap\?\.get\(key\)\)\|\|0\)/);
  assert.match(html,/Для расчёта: '\+Math\.round\(x\.stock\).*доступно \+ резерв \+ на складе/);
});


test('Kaspi advertising uses deterministic links and exposes repair audit',()=>{
  assert.match(html,/function kaspiAdsMatchProduct\(line\)/);
  assert.match(html,/Array\.isArray\(p\?\.kaspiAliases\)\?p\.kaspiAliases:\[\]/);
  assert.match(html,/identityMatches=state\.products\.filter\(p=>\{const key=kaspiAdsIdentityKey\(p\.name\);return key&&identity&&key===identity\}\)/);
  assert.doesNotMatch(html,/key\.includes\(identity\)\|\|identity\.includes\(key\)/);
  assert.doesNotMatch(html,/nn\.includes\(x\.key\)\|\|x\.key\.includes\(nn\)/);
  assert.match(kaspiAds,/window\.kaspiAdsRepairLinksStrict = function \(\)/);
  assert.match(kaspiAds,/window\.kaspiAdsLinkAudit = function \(days = 'all', range = null\)/);
  assert.match(kaspiAds,/ambiguous_sku/);
  assert.match(kaspiAds,/stored_only/);
});

test('unmatched marketplace advertising is never spread across unrelated products',()=>{
  assert.match(report,/for\(const x of kaspiKnown\)add\(x\.productId,x\.qty,Number\(x\.profit\)\|\|0,'Kaspi',Math\.max\(0,Number\(x\.ads\)\|\|0\)\)/);
  assert.match(report,/productAds=Math\.max\(0,Number\(x\.advertising\)\|\|0\);add\(v\.pid,saleQty,Number\(x\.netBeforeCost\|\|0\)-cost,model\.market,productAds\)/);
  assert.doesNotMatch(report,/kaspiLooseAds|looseShare/);
  assert.doesNotMatch(report,/unmatchedAds=Math\.max\(0,Number\(model\.unmatchedAdvertising\)/);
});

test('product details opened from Products use the same selected period',()=>{
  assert.match(html,/async function openProduct\(pid,market='',days=null\)/);
  assert.match(html,/productListContext=!market&&\(days===null\|\|days===undefined\)/);
  assert.match(html,/selectedSpec=productListContext\?productRankSpec\(\):null/);
  assert.match(html,/await ensureProductRankStats\(\)/);
  assert.match(html,/Продано · \$\{esc\(selectedSpec\.label\)\}/);
  assert.match(html,/Чистая прибыль · '\+esc\(selectedSpec\.label\)/);
  assert.match(html,/Реклама Kaspi \+ WB1 \+ WB2 \+ Ozon · '\+esc\(selectedSpec\.label\)/);
  assert.match(html,/после себестоимости, комиссий, логистики, рекламы и возвратов/);
});

test('unified Product-period profit includes Ozon and supports an explicit custom range',()=>{
  assert.match(report,/window\.refreshProductPeriodStats=function/);
  assert.match(report,/loadOzonSummary\(days,\{range\}\)/);
  assert.match(report,/loadWbModel\('WB',days,\{range\}\)/);
  assert.match(report,/add\(pid,qty,Number\(x\?\.profit\)\|\|0,'Ozon'/);
  assert.match(report,/periodCacheKey\(days,range\)/);
  assert.match(compat,/window\.summarizeOzonReport=async function\(days,range=null\)/);
  assert.match(compat,/ozonProfitModel\(payload,days,range\)/);
  assert.match(html,/Не удалось загрузить расчёт за '\+esc\(spec\.label\)/);
  assert.match(report,/kaspi=buildModel\(kaspiSnapshot,days,range\)/);
  assert.match(report,/kaspiAdsBreakdown\(days,range\)/);
  assert.match(kaspiAds,/function breakdown\(days = reportPeriod, range = null\)/);
  assert.match(kaspiAds,/effectiveRows\(days, '', range\)/);
});


test('Ozon cross-docking is automatic from finance accruals and remains product-linked',()=>{
  assert.match(compat,/function ozonCrossdockFinanceRow\(row,maps\)/);
  assert.ok(compat.includes("crossdockByUnit.has(account+'|'+unit)"));
  assert.match(compat,/function ozonCrossdockTargets\(row,maps,directProduct\)/);
  assert.match(compat,/if\(ozonCrossdockFinanceRow\(row,maps\)\)/);
  assert.match(compat,/pr\.fbo\+=expense\*share;pr\.net\+=amount\*share/);
  assert.match(compat,/pr\.profit=pr\.net-pr\.cogs/);
  assert.match(compat,/platformFees=Math\.max\(0,deductions-ads-fbo\),fees=platformFees\+fbo/);
  assert.match(compat,/fees:Math\.max\(0,\(row\.sales\|\|0\)-\(row\.net\|\|0\)-Math\.abs\(financeAds\)-fbo\)/);
  assert.doesNotMatch(compat,/ozonFboUnitCost|ozonFboUnitCosts|openOzonFboCosts|saveOzonFboCosts|data-ozon-fbo-cost/);
  assert.doesNotMatch(report,/openOzonFboCosts|FBO расходы<\/button>/);
  assert.match(report,/x\.fbo!==undefined&&x\.fbo!==null\?'<div class="row"[^']*FBO \/ кросс-докинг/);
  assert.match(report,/\{label:'FBO \/ кросс-докинг',text:fmt\(fbo\)\}/);
  assert.match(report,/expenseText:empty\?'—':fmt\(cost\+fees\+fbo\+ads\)/);
  assert.match(report,/unallocatedFbo/);
});


test('Ozon product-profit sheet does not show advertising zero before Performance data is ready',()=>{
  assert.match(compat,/model\.performanceAdsConfigured=Boolean\(adPayload\?\.configured\)/);
  assert.match(compat,/model\.performanceAdsPending=Boolean\(adPayload\?\.configured&&adPayload\?\.pending\)/);
  assert.match(compat,/let ads=null;\s*try\{ads=await loadOzonSkuAds\(days,range\)\}/);
  assert.match(compat,/if\(ads\?\.configured&&!ads\?\.pending&&Array\.isArray\(ads\.rows\)\)return ozonSummaryFrom/);
  assert.match(compat,/model\.performanceAdsPending\?'загрузка…'/);
  assert.match(compat,/Реклама Ozon загружается из Performance API/);
  assert.match(compat,/if\(!ads\?\.configured\|\|!Array\.isArray\(ads\.rows\)\)return/);
  assert.match(report,/html\.includes\('Ozon FBO · прибыль по товарам'\)/);
  assert.match(report,/openOzonProductProfit\(\);requestAnimationFrame/);
});


test('Ozon SKU advertising uses the same selected period and reconciles to finance total',()=>{
  assert.match(compat,/model\.performanceAdsFrom=String\(adPayload\?\.from\|\|''\)/);
  assert.match(compat,/model\.performanceAdsTo=String\(adPayload\?\.to\|\|''\)/);
  assert.match(compat,/model\.performanceAdsTotal=Math\.max\(0,Number\(adPayload\?\.totalSpent\)\|\|0\)/);
  assert.match(compat,/unallocatedAds=adSource==='performance'\?Math\.max\(0,ads-performanceAdsTotal\)/);
  assert.match(compat,/performanceAdsOver=Math\.max\(0,performanceAdsTotal-ads\)/);
  assert.match(compat,/if\(ads\?\.configured&&ads\?\.pending\)watchOzonAds\(days,payload,range\)/);
  assert.match(compat,/window\.onOzonSummary\(Number\(days\),next,range\)/);
  assert.match(report,/window\.onOzonSummary=function\(days,summary,range=null\)/);
  assert.match(report,/const key=periodCacheKey\(days,range\)/);
  assert.match(report,/sameRange=range\?Number\(reportPeriod\)===0/);
  assert.match(report,/Реклама по SKU:/);
});
