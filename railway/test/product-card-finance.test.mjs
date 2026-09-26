import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
const report=readFileSync(new URL('../../kaspi-report-v2.js',import.meta.url),'utf8');
const compat=readFileSync(new URL('../../kaspi-status-compat-v1.js',import.meta.url),'utf8');
const kaspiAds=readFileSync(new URL('../../kaspi-ads-v2-original.js',import.meta.url),'utf8');

test('product list keeps 30-day sales on the left and uses six-month profit on the right',()=>{
  const line=html.split('\n').find(row=>row.startsWith('function productCard('))||'';
  assert.match(line,/Себестоимость/);
  assert.match(line,/Продано · \$\{esc\(period\.label\)\}/);
  assert.match(line,/Прибыль · \$\{esc\(profitLabel\)\}/);
  assert.match(line,/Прибыль \/ шт\./);
  assert.match(line,/qty=periodReady\?Math\.max/);
  assert.match(line,/profitQty=profitReady\?Math\.max/);
  assert.match(line,/profitText=profitReady\?fmt/);
  assert.match(line,/unitProfitText=profitReady&&profitQty>0\?fmt/);
  assert.match(html,/const PRODUCT_CARD_PROFIT_SPEC=\{days:180,key:'card-profit-180',label:'6 мес\.',dayCount:180\}/);
  assert.match(html,/function ensureProductCardProfitStats\(force=false\)/);
  assert.match(html,/window\.refreshProductPeriodStats\(spec,\{force\}\)/);
  assert.match(html,/cardProfitStats\.get\(String\(p\.id\)\),cardProfitReady,PRODUCT_CARD_PROFIT_SPEC\.label/);
});

test('opening Products warms both 30-day operating stats and six-month card profit stats',()=>{
  assert.match(html,/if\(view==='products'\)setTimeout\(\(\)=>\{Promise\.resolve\(ensureProductPeriodStats\(\)\).*Promise\.resolve\(ensureProductCardProfitStats\(\)\)/);
  assert.match(html,/productCardProfitStats instanceof Map\?productCardProfitStats:new Map\(\)/);
  assert.match(html,/cardProfitReady=productCardProfitStats instanceof Map/);
});

test('projected stock profit uses the same six-month unit profit as product cards',()=>{
  assert.match(html,/Ожидаемая прибыль с остатка/);
  assert.match(html,/onclick="openStockProfitBreakdown\(\)"/);
  assert.match(html,/function warehouseProjectedProfitRows\(profitStats,stockMap=null\)/);
  assert.match(html,/\(доступно к продаже \+ резерв \+ «На складе»\) × чистая прибыль на 1 проданную штуку за 6 месяцев/);
  assert.match(html,/продано · '\+esc\(label\)/);
  assert.match(html,/cardProfitReady\?fmt\(warehouseProjectedProfit\(cardProfitStats,productValuationStockMap\(stats\)\)\):'—'/);
  assert.match(html,/const spec=PRODUCT_CARD_PROFIT_SPEC;let periodStats=productCardProfitStats/);
  assert.match(html,/await ensureProductCardProfitStats\(\)/);
  assert.match(html,/rows=warehouseProjectedProfitRows\(periodStats,productValuationStockMap\(inventory\)\)/);
  assert.match(html,/рассчитана за 6 месяцев: Kaspi \+ WB1 \+ WB2 \+ Ozon/);
});



test('buyer-transit profit uses the six-month average and opens a detailed breakdown',()=>{
  assert.match(html,/onclick="openToBuyerProfitBreakdown\(\)"/);
  assert.match(html,/function marketplaceToBuyerProfitRows\(periodStats,snapshot=marketplaceToBuyerSnapshot\(\)\)/);
  assert.match(html,/marketProductQtyMap=new Map\(\)/);
  assert.match(html,/buyer&&cardProfitReady\?fmt\(marketplaceToBuyerProfit\(cardProfitStats,buyer\)\):'—'/);
  assert.match(html,/async function openToBuyerProfitBreakdown\(\)/);
  assert.match(html,/const title='Прибыль в пути до покупателя',spec=PRODUCT_CARD_PROFIT_SPEC/);
  assert.match(html,/await ensureProductCardProfitStats\(\)/);
  assert.match(html,/количество в пути до покупателя × средняя чистая прибыль на 1 проданную штуку за 6 месяцев/);
  assert.match(html,/Продано · '\+esc\(spec\.label\).*средняя прибыль \/ шт\./);
  assert.match(html,/Нет товаров в пути до покупателя с рассчитанной прибылью за 6 месяцев/);
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

test('product details use combined 30-day net profit including Kaspi and WB advertising',()=>{
  assert.match(html,/async function openProduct\(pid,market='',days=null\)/);
  assert.match(html,/productListContext=!market&&\(days===null\|\|days===undefined\)/);
  assert.match(html,/selectedSpec=productListContext\?productPeriodSpec\(\):null/);
  assert.match(html,/await ensureProductPeriodStats\(\)/);
  assert.match(html,/window\.refreshAllMarketUnitProfit/);
  assert.match(html,/Реклама Kaspi \+ WB1 \+ WB2 \+ Ozon за 30 дней/);
  assert.match(html,/Чистая прибыль за 30 дней/);
  assert.match(html,/после себестоимости, комиссий, логистики, рекламы и возвратов/);
  assert.match(html,/combined30\?Math\.max\(0,Number\(combined30\.ads\)/);
  assert.match(html,/По магазинам/);
});


test('unified Product-period profit includes Ozon and supports an explicit custom range',()=>{
  assert.match(report,/window\.refreshProductPeriodStats=function/);
  assert.match(report,/loadOzonSummary\(days,\{range\}\)/);
  assert.match(report,/loadWbModel\('WB',days,\{range\}\)/);
  assert.match(report,/add\(pid,qty,Number\(x\?\.profit\)\|\|0,'Ozon'/);
  assert.match(report,/periodCacheKey\(days,range\)/);
  assert.match(compat,/window\.summarizeOzonReport=async function\(days,range=null\)/);
  assert.match(compat,/ozonProfitModel\(payload,days,range\)/);
  assert.match(html,/Не удалось загрузить единый расчёт прибыли за 6 месяцев/);
  assert.match(report,/kaspi=buildModel\(kaspiSnapshot,days,range\)/);
  assert.match(report,/kaspiAdsBreakdown\(days,range\)/);
  assert.match(kaspiAds,/function breakdown\(days = reportPeriod, range = null\)/);
  assert.match(kaspiAds,/effectiveRows\(days, '', range\)/);
});
