import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
const ozon=readFileSync(new URL('../../ozon-fbo-v1.js',import.meta.url),'utf8');
const passport=readFileSync(new URL('../../docs/SITE-PASSPORT.md',import.meta.url),'utf8');

function between(start,end){
  const a=html.indexOf(start);
  assert.ok(a>=0,'missing '+start);
  const b=html.indexOf(end,a+start.length);
  assert.ok(b>a,'missing '+end);
  return html.slice(a,b);
}

test('Products inventory snapshot is one-pass and drives all stock filters',()=>{
  const source=[
    between('function isBundleProduct(','function bundleComponents('),
    between('function bundleComponents(','function stockProducts('),
    between('function purchaseStatus(','const MIN_PURCHASE_COVER_DAYS='),
    between('function productMapAdd(','function buildProductRenderStats('),
    between('function buildProductRenderStats(','function productInventoryRow('),
    between('function normalizeProductFilter(','function currentProductFilter('),
    between('function productMatchesStockFilter(','function productMapAdd(')
  ].join('\n');
  const context={
    PRODUCT_FILTER_VALUES:['all','sale','warehouse','fbo','transit','zero'],
    state:{
      products:[
        {id:'sale',name:'Sale',stock:5},
        {id:'warehouse',name:'Warehouse',stock:0},
        {id:'fbo',name:'FBO',stock:0,ozon:'fbo'},
        {id:'transit',name:'Transit',stock:0},
        {id:'zero',name:'Zero',stock:0},
        {id:'bundle',name:'Bundle',kind:'bundle',stock:0,components:[{productId:'sale',qty:2}]}
      ],
      reservations:[
        {productId:'sale',qty:1,active:true},
        {productId:'bundle',qty:1,active:true}
      ],
      purchases:[
        {productId:'warehouse',qty:4,status:'at_warehouse',unitCost:11},
        {productId:'transit',qty:2,status:'to_me'},
        {productId:'sale',qty:5,status:'received',receivedAt:100}
      ]
    },
    window:{ozonFboDataReady:()=>true,ozonFboQtyForProduct:p=>p.id==='fbo'?3:0},
    productSearchHaystack:p=>String(p?.name||'').toLowerCase(),
    reportPeriodStart:()=>0,
    isRealPurchase:()=>true,
    Math,Number,String,Map,Set
  };
  vm.runInNewContext(source,context);
  const stats=context.buildProductRenderStats();
  assert.equal(stats.stockMap.get('sale'),2);
  assert.equal(stats.reservedMap.get('sale'),3);
  assert.equal(stats.stockMap.get('bundle'),1);
  assert.equal(stats.atWarehouseMap.get('warehouse'),4);
  assert.equal(stats.atWarehouseCostMap.get('warehouse'),44);
  assert.equal(stats.transitMap.get('transit'),2);
  assert.equal(stats.fboMap.get('fbo'),3);
  const rows=context.state.products.filter(p=>p.id!=='bundle');
  const ids=filter=>rows.filter(p=>context.productMatchesStockFilter(filter,{
    sale:stats.physicalMap.get(p.id),
    warehouse:stats.atWarehouseMap.get(p.id),
    fbo:stats.fboMap.get(p.id),
    transit:stats.transitMap.get(p.id)
  })).map(p=>p.id);
  assert.deepEqual(ids('sale'),['sale']);
  assert.deepEqual(ids('warehouse'),['warehouse']);
  assert.deepEqual(ids('fbo'),['fbo']);
  assert.deepEqual(ids('transit'),['transit']);
  assert.deepEqual(ids('zero'),['zero']);
  assert.equal(stats.physicalMap.get('sale'),5);
  assert.equal(stats.stockMap.get('sale'),2);
  assert.ok(ids('sale').includes('sale'),'reserved stock still belongs to the physical «В продаже» location');
});

test('Products distinguish physical «В продаже» from free-to-sell stock',()=>{
  const render=between('function renderProducts(','function wbRelinkNotice(');
  assert.match(render,/productInventoryRow\(stats,p\)/);
  assert.doesNotMatch(render,/productMatchesStockFilter\(/);
  const metric=between('function productMetricForSort(','function compareProductsForList(');
  assert.match(metric,/if\(sort==='stock'\)return inventory\.physical/);
  const card=html.split('\n').find(row=>row.startsWith('function productCard('))||'';
  assert.match(card,/В продаже: \$\{physical\} шт\./);
  assert.match(card,/Свободно: \$\{forSale\} шт\./);
});

test('Products critical render stays lightweight with search and direct FBO snapshot filter',()=>{
  const render=between('function renderProducts(','function wbRelinkNotice(');
  assert.match(render,/const q=normalizeName\(document\.getElementById\('q'\)\?\.value\|\|''\)/);
  assert.match(render,/rows\.sort\(\(a,b\)=>String\(a\?\.name\|\|''\)\.localeCompare/);
  assert.match(render,/stats\.fboMap\?\.get\(String\(p\.id\)\)/);
  assert.doesNotMatch(render,/ozonFboQtyForProduct\(/);
  assert.doesNotMatch(render,/currentProductFilter\(/);
  assert.doesNotMatch(render,/currentProductSort\(/);
  assert.doesNotMatch(render,/productSortDirection\(/);
  assert.doesNotMatch(render,/syncProductPickerLabels\(/);
  assert.doesNotMatch(render,/syncProductPeriodControls\(/);
  assert.doesNotMatch(render,/updateProductSortDirectionButton\(/);
  assert.doesNotMatch(render,/productMatchesStockFilter\(/);
  assert.match(render,/product card render failed/);
  assert.match(render,/Карточка показана в безопасном режиме/);
});

test('Products sorting direction changes real comparator output',()=>{
  const source=[
    between('function productInventoryRow(','function productMetricForSort('),
    between('function productMetricForSort(','function compareProductsForList('),
    between('function compareProductsForList(','function renderProductSummary(')
  ].join('\n');
  const context={Math,Number,String,Map};
  vm.runInNewContext(source,context);
  const a={id:'a',name:'A'},b={id:'b',name:'B'};
  const stats={
    stockMap:new Map([['a',10],['b',2]]),
    reservedMap:new Map(),physicalMap:new Map([['a',10],['b',2]]),atWarehouseMap:new Map(),transitMap:new Map(),fboMap:new Map()
  };
  const periodStats=new Map([
    ['a',{qty:2,profit:20,unitProfit:10}],
    ['b',{qty:5,profit:10,unitProfit:2}]
  ]);
  const period={dayCount:7};
  assert.ok(context.compareProductsForList(a,b,'sales','desc',stats,periodStats,period,true)>0);
  assert.ok(context.compareProductsForList(a,b,'sales','asc',stats,periodStats,period,true)<0);
  assert.ok(context.compareProductsForList(a,b,'stock','desc',stats,periodStats,period,true)<0);
  assert.ok(context.compareProductsForList(a,b,'days','asc',stats,periodStats,period,true)>0);
  assert.ok(context.compareProductsForList(a,b,'name','asc',stats,periodStats,period,true)<0);
  assert.ok(context.compareProductsForList(a,b,'name','desc',stats,periodStats,period,true)>0);
});

test('Products remain usable while fixed-period finance is loading',()=>{
  const render=between('function renderProducts(','function wbRelinkNotice(');
  assert.match(render,/currentProductPeriodStats\(period\)\|\|new Map\(\)/);
  assert.match(render,/periodReady=currentProductPeriodStats\(period\) instanceof Map/);
  assert.doesNotMatch(render,/if\(!periodReady\).*return/);
  assert.doesNotMatch(render,/productMatchesStockFilter/);
  assert.match(html,/Загружаю продажи и прибыль · /);
  assert.match(html,/Остатки и поиск продолжают работать/);
});

test('Products first interaction avoids repeated reservation and purchase scans',()=>{
  const builder=between('function buildProductRenderStats(','function productInventoryRow(');
  assert.doesNotMatch(builder,/productAvailableStock\(/);
  assert.doesNotMatch(builder,/reserved\(/);
  assert.doesNotMatch(builder,/purchaseTransitQty\(/);
  assert.doesNotMatch(builder,/purchaseAtWarehouseQty\(/);
  const card=html.split('\n').find(row=>row.startsWith('function productCard('))||'';
  assert.match(card,/inventory=null/);
  assert.match(card,/inventory\?\.reserved/);
  assert.match(card,/inventory\?\.transit/);
  assert.match(card,/inventory\?\.warehouse/);
  const heavy=between('function productStockCostFromSnapshot(','function renderProducts(');
  assert.match(heavy,/productIdle\(run,1800\)/);
  assert.match(heavy,/productStockCostFromSnapshot\(stats\)/);
  assert.doesNotMatch(heavy,/warehouseInventoryCost\(\)/);
});

test('Products rebuild stale cache and Ozon does not invalidate it on every tap',()=>{
  const render=between('function renderProducts(','function wbRelinkNotice(');
  assert.match(render,/const didRebuild=rebuildStats\|\|!productRenderStatsCache;if\(didRebuild\)productRenderStatsCache=buildProductRenderStats\(\)/);
  assert.match(ozon,/if\(document\.getElementById\('products'\)\?\.classList\.contains\('active'\)\)\{if\(typeof invalidateProductRenderStats==='function'\)invalidateProductRenderStats\(\);baseRenderProducts\(false\);\}/);
  const wrapper=ozon.slice(ozon.indexOf('renderProducts=function'),ozon.indexOf('function reportBounds',ozon.indexOf('renderProducts=function')));
  assert.match(wrapper,/&& !?loading|&&\!loading/);
  assert.doesNotMatch(wrapper,/\.then\(\(\)=>\{updateFboMetric\(\);if\(typeof invalidateProductRenderStats/);
});

test('Products have no visible time-filter controls',()=>{
  assert.doesNotMatch(html,/data-product-period=/);
  assert.doesNotMatch(html,/id="productPeriod"/);
  assert.doesNotMatch(html,/id="productPeriodStatus"/);
  assert.doesNotMatch(html,/id="productCustomRange"/);
  assert.match(html,/let productPeriod='30';/);
});

test('Product opened from Products uses the fixed Products 30-day window',()=>{
  const detail=between("async function openProduct(","function openProductWarehouseRelease(");
  assert.match(html,/let productPeriod='30';/);
  assert.match(detail,/productListContext=!market&&\(days===null\|\|days===undefined\)/);
  assert.match(detail,/selectedSpec=productListContext\?productPeriodSpec\(\):null/);
  assert.match(detail,/currentProductPeriodStats\(selectedSpec\)/);
  assert.match(detail,/await ensureProductPeriodStats\(\)/);
  assert.match(detail,/Продано · \$\{esc\(selectedSpec\.label\)\}/);
});



test('Products period cache stays instant but refreshes stale finance in background',()=>{
  const current=between('function currentProductPeriodStats(','function syncProductPeriodControls(');
  const ensure=between('function ensureProductPeriodStats(','function productMatchesStockFilter(');
  assert.match(current,/cached\?\.data instanceof Map/);
  assert.match(current,/Date\.now\(\)-Number\(cached\.at\|\|0\)<60000/);
  assert.match(ensure,/ready instanceof Map&&productPeriodStatsFresh\(spec\)/);
  assert.match(ensure,/productPeriodRequests\.has\(spec\.key\)/);
  assert.match(ensure,/productPeriodUiCache\.set\(spec\.key,\{at:Date\.now\(\),data:map\}\)/);
});

test('Products CRUD and stock actions keep write guards and ledger-safe entry points',()=>{
  for(const name of ['saveProductEdit','createProduct','releaseProductWarehouseQty','delistProductQty','deleteProduct','createWriteoff','doInventory']){
    const marker='function '+name+'(';
    const start=html.indexOf(marker);
    assert.ok(start>=0,'missing '+name);
    const end=html.indexOf('\nfunction ',start+marker.length);
    const source=html.slice(start,end>start?end:start+10000);
    assert.match(source,/requireWarehouseEditReady\(\)/,name+' must keep the authoritative write guard');
  }
  assert.match(html,/function createProduct\(\)[\s\S]*log\('инвентаризация'/);
  assert.match(html,/function releaseProductWarehouseQty\(pid\)[\s\S]*log\('приход'/);
  assert.match(html,/function delistProductQty\(pid\)[\s\S]*log\('снятие с продажи'/);
  assert.match(html,/function createWriteoff\(\)[\s\S]*log\('списание'/);
  assert.match(html,/function doInventory\(\)[\s\S]*log\('инвентаризация'/);
  assert.match(html,/Нельзя удалить товар с остатком/);
});

test('Products audit contract is recorded for future AI changes',()=>{
  assert.match(passport,/PRODUCT-15/);
  assert.match(passport,/PRODUCT-16/);
  assert.match(passport,/PRODUCT-17/);
  assert.match(passport,/PRODUCT-22/);
  assert.match(passport,/PRODUCT-23/);
  assert.match(passport,/PRODUCT-24/);
  assert.match(passport,/PRODUCT-25/);
  assert.match(passport,/PRODUCT-26/);
  assert.match(passport,/PRODUCT-27/);
  assert.match(passport,/PRODUCT-28/);
  assert.match(passport,/PRODUCT-29/);
});
