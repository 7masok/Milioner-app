import test from 'node:test';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
const report=readFileSync(new URL('../../kaspi-report-v2.js',import.meta.url),'utf8');
const kaspiAds=readFileSync(new URL('../../kaspi-ads-v2-original.js',import.meta.url),'utf8');
const compat=readFileSync(new URL('../../kaspi-status-compat-v1.js',import.meta.url),'utf8');

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
  assert.match(html,/в том магазине, из которого идёт заказ/);
  assert.match(html,/средняя прибыль \/ шт\./);
});

test('stock valuation uses sale plus covered reserve plus warehouse stock',()=>{
  assert.match(html,/function productValuationStockMap\(stats\)/);
  assert.match(html,/available\+coveredReserve\+warehouse/);
  assert.match(html,/atWarehouseCostMap=new Map\(\)/);
  assert.match(html,/productMapAdd\(atWarehouseCostMap,key,qty\*purchaseDisplayUnitCost\(row\)\)/);
  assert.match(html,/total\+=value\+Math\.max\(0,Number\(stats\?\.atWarehouseCostMap\?\.get\(key\)\)\|\|0\)/);
  assert.match(html,/Для расчёта: '\+Math\.round\(x\.stock\).*доступно \+ резерв \+ на складе/);
});


test('Kaspi advertising still uses deterministic links and reports unallocated spend',()=>{
  assert.match(html,/function kaspiAdsMatchProduct\(line,batchId\)/);
  assert.match(html,/Array\.isArray\(p\.kaspiAliases\)\?p\.kaspiAliases:\[\]/);
  assert.match(report,/Есть реклама Kaspi без товара/);
  assert.match(report,/openReportAdsPanel\('Kaspi'\)/);
  assert.doesNotMatch(report,/kaspiSheetNote/);
  assert.match(html,/onclick="openReportAdsPanel\(\)"/);
  assert.match(report,/window\.openStoreDetail=async function\(market,days\)\{days=days===undefined\|\|days===null\?reportPeriod:Number\(days\);if\(!\['Kaspi','WB','WB2','WB3','Ozon'\]\.includes\(market\)\)return;marketplaceReportContext=\{market,days\}/);
  assert.doesNotMatch(html,/key\.includes\(identity\)\|\|identity\.includes\(key\)/);
  assert.doesNotMatch(html,/nn\.includes\(x\.key\)\|\|x\.key\.includes\(nn\)/);
});

test('Kaspi manual advertising links override inference and survive an updated report row',()=>{
  const products=[{id:'black',name:'Цветочные кошки ЦКЧ',kaspi:'seller-black'},
    {id:'white',name:'Цветочные кошки ЦКБ',kaspi:'seller-white'}];
  const links={},ctx={state:{products,settings:{kaspiAdProductLinks:links}},prod:id=>products.find(p=>p.id===id),
    adsSkuEqual:(a,b)=>String(a??'').trim()===String(b??'').trim()};
  vm.createContext(ctx);
  const start=html.indexOf('function kaspiAdLinkKey('),end=html.indexOf('function kaspiAdsBreakdown(');
  vm.runInContext(html.slice(start,end),ctx);
  const row={sku:'186427214',name:'Цветочные кошки ЦКЧ',productId:'black'};
  assert.equal(ctx.kaspiAdsMatchProduct(row),null);
  assert.equal(ctx.kaspiAdsMatchProduct({...row,sku:'seller-black'}).id,'black');
  links[ctx.kaspiAdLinkKey(row)]='white';
  assert.equal(ctx.kaspiAdsMatchProduct({...row,name:'Новое название',kaspiMerchantSkus:['seller-black']}).id,'white');
  const oldImport={name:'Цветочные кошки ЦКБ'};
  links[ctx.kaspiAdLinkKey(oldImport,'original')]='white';
  assert.equal(ctx.kaspiAdsMatchProduct(oldImport,'original').id,'white');
  assert.equal(ctx.kaspiAdsMatchProduct(oldImport,'different-import'),null);
});

test('confirmed Kaspi catalog identities match seller SKUs in a separate namespace and reject ambiguous variants',()=>{
 const products=[{id:'black',name:'Кошки цветы черный',kaspi:'897281226'},
   {id:'white',name:'Кошки цветы белый',kaspi:'288282987'},
   {id:'collision',name:'Unrelated seller SKU',kaspi:'186427214'}];
 const ctx={window:{},state:{products,kaspiOrderFeed:[]},prod:id=>products.find(p=>p.id===id),
   normalizeName:value=>String(value||'').toLowerCase(),adsSkuEqual:(a,b)=>String(a??'').trim()===String(b??'').trim()};
 vm.createContext(ctx);
 vm.runInContext(html.slice(html.indexOf('function kaspiAdsNameKey('),html.indexOf('function kaspiAdsBreakdown(')),ctx);
 const before=JSON.stringify(products);
 assert.equal(ctx.kaspiAdsMatchProduct({sku:'186427214',name:'Other title',kaspiMerchantSkus:['897281226']}).id,'black');
 assert.equal(ctx.kaspiAdsMatchProduct({sku:'186427214',kaspiMerchantSkus:['897281226','288282987']}),null);
 assert.equal(ctx.kaspiAdsMatchProduct({sku:'186427214',kaspiMerchantSkus:['missing']}),null);
 assert.equal(JSON.stringify(products),before);assert.equal(products[0].kaspiAliases,undefined);
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
  assert.match(compat,/ozonProfitModel\(payload,days,range,prepared\)/);
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
  assert.match(compat,/const ads=hit\?\.data\|\|\{configured:true,pending:true/);
  assert.match(compat,/return ozonSummaryFrom\(payload,days,ads,range\)/);
  const summary=compat.slice(compat.indexOf('  window.summarizeOzonReport='),compat.indexOf('  function ozonYieldUi'));assert.doesNotMatch(summary,/await loadOzonSkuAds/);
  assert.match(compat,/model\.performanceAdsPending\?'загрузка…'/);
  assert.match(compat,/model\.performanceAdsError/);
  assert.match(compat,/model\.performanceAdsLimited\?'лимит Ozon':'недоступно'/);
  assert.match(compat,/Реклама Ozon загружается из Performance API/);
  assert.match(report,/summary\?\.adsLimited\?'лимит Ozon':'недоступно'/);
  assert.match(report,/Общая реклама/);
  assert.match(report,/html\.includes\('Ozon FBO · прибыль по товарам'\)/);
  assert.match(report,/openOzonProductProfit\(\);requestAnimationFrame/);
});


test('Ozon SKU advertising uses the same selected period and reconciles to finance total',()=>{
  assert.match(compat,/model\.performanceAdsFrom=String\(adPayload\?\.from\|\|''\)/);
  assert.match(compat,/model\.performanceAdsTo=String\(adPayload\?\.to\|\|''\)/);
  assert.match(compat,/model\.performanceAdsTotal=Math\.max\(0,Number\(adPayload\?\.totalSpent\)\|\|0\)/);
  assert.match(compat,/unallocatedAds=adSource==='performance'\?Math\.max\(0,ads-performanceAdsTotal\)/);
  assert.match(compat,/performanceAdsOver=Math\.max\(0,performanceAdsTotal-ads\)/);
  assert.match(compat,/watchOzonAds\(days,payload,range\)/);
  assert.match(compat,/window\.onOzonSummary\(Number\(days\),next,range\)/);
  assert.match(report,/window\.onOzonSummary=function\(days,summary,range=null\)/);
  assert.match(report,/const key=periodCacheKey\(days,range\)/);
  assert.match(report,/sameRange=range\?Number\(reportPeriod\)===0/);
  assert.match(report,/if\(Number\(days\)===0&&!range&&reportCustomFrom&&reportCustomTo\)range=\{from:String\(reportCustomFrom\),to:String\(reportCustomTo\)\}/);
  assert.match(report,/Реклама по SKU:/);
});

test('buyer-transit profit is additive across stores with different margins for the same product', () => {
  const start=html.indexOf('function marketplaceToBuyerProfitRows(');
  const end=html.indexOf('async function openToBuyerProfitBreakdown(',start);
  const context=vm.createContext({Map,prod:id=>({id})});
  vm.runInContext(html.slice(start,end), context);
  const period=new Map([
    ['a',{qty:110,unitProfit:260/110,sources:{Kaspi:{qty:10,profit:1000},WB:{qty:100,profit:-740}}}],
    ['b',{qty:3,unitProfit:50,sources:{Kaspi:{qty:3,profit:150}}}],
  ]);
  const report=(pairs,orderUnits)=>context.marketplaceToBuyerProfitSummary(period,{
    orderUnits,marketProductQtyMap:new Map(pairs.map(([id,markets])=>[id,new Map(markets)])),
  });
  const kaspi=report([['a',[['Kaspi',5]]]],5);
  const wb=report([['a',[['WB',10]]],['b',[['WB',2]]]],12);
  const combined=report([['a',[['Kaspi',5],['WB',10]]],['b',[['WB',2]]]],17);
  assert.equal(kaspi.total,500);
  assert.equal(wb.total,-74);
  assert.equal(combined.total,kaspi.total+wb.total);
  assert.equal(combined.positive,500);
  assert.equal(combined.negative,-74);
  assert.equal(combined.knownUnits,15);
  assert.equal(combined.missingUnits,2);
  assert.equal(report([['b',[['WB',2]]]],2).total,null);
  assert.equal(report([],0).total,0);
});
