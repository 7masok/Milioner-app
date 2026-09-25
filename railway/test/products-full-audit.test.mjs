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
        {productId:'warehouse',qty:4,status:'at_warehouse'},
        {productId:'transit',qty:2,status:'to_me'},
        {productId:'sale',qty:5,status:'received',receivedAt:100}
      ]
    },
    window:{ozonFboDataReady:()=>true,ozonFboQtyForProduct:p=>p.id==='fbo'?3:0},
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
  assert.equal(stats.transitMap.get('transit'),2);
  assert.equal(stats.fboMap.get('fbo'),3);
  const rows=context.state.products.filter(p=>p.id!=='bundle');
  const ids=filter=>rows.filter(p=>context.productMatchesStockFilter(filter,{
    sale:stats.stockMap.get(p.id),
    warehouse:stats.atWarehouseMap.get(p.id),
    fbo:stats.fboMap.get(p.id),
    transit:stats.transitMap.get(p.id)
  })).map(p=>p.id);
  assert.deepEqual(ids('sale'),['sale']);
  assert.deepEqual(ids('warehouse'),['warehouse']);
  assert.deepEqual(ids('fbo'),['fbo']);
  assert.deepEqual(ids('transit'),['transit']);
  assert.deepEqual(ids('zero'),['zero']);
});

test('Products filtering sorting and periods do not rebuild inventory on every tap',()=>{
  const filter=between('function setProductFilter(','function setProductSort(');
  const sort=between('function setProductSort(','function setProductPeriod(');
  const period=between('function setProductPeriod(','function setProductCustomDate(');
  const arrow=between('function toggleProductSortDirection(','function setProductPage(');
  for(const source of [filter,sort,period,arrow]){
    assert.doesNotMatch(source,/invalidateProductRenderStats\(|renderProducts\(true\)/);
    assert.match(source,/productUiFrame\(/);
  }
  assert.match(filter,/renderProducts\(false\)/);
  assert.match(sort,/renderProducts\(false\)/);
  assert.match(period,/renderProducts\(false\);ensureProductPeriodStats\(\)/);
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
    reservedMap:new Map(),physicalMap:new Map(),atWarehouseMap:new Map(),transitMap:new Map(),fboMap:new Map()
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

test('Products remain usable while selected-period finance is loading',()=>{
  const render=between('function renderProducts(','function wbRelinkNotice(');
  assert.match(render,/currentProductPeriodStats\(period\)\|\|new Map\(\)/);
  assert.match(render,/periodReady=currentProductPeriodStats\(period\) instanceof Map/);
  assert.doesNotMatch(render,/if\(!periodReady\).*return/);
  assert.match(render,/rows=rows\.filter\(p=>productMatchesStockFilter/);
  assert.match(html,/Загружаю продажи и прибыль · /);
  assert.match(html,/Остатки, поиск и фильтры продолжают работать/);
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
  const heavy=between('function scheduleProductHeavyMetrics(','function renderProducts(');
  assert.match(heavy,/productIdle\(run,1800\)/);
  assert.match(heavy,/warehouseInventoryCost\(\)/);
});

test('Products rebuild stale cache even when wrapper calls renderProducts(false)',()=>{
  const render=between('function renderProducts(','function wbRelinkNotice(');
  assert.match(render,/const didRebuild=rebuildStats\|\|!productRenderStatsCache;if\(didRebuild\)productRenderStatsCache=buildProductRenderStats\(\)/);
  assert.match(ozon,/invalidateProductRenderStats\(\).*baseRenderProducts\(false\)/s);
});

test('Products mobile period controls never clip the fifth option',()=>{
  assert.match(html,/#productPeriod\{display:grid;grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(html,/#productPeriod \[data-product-period="custom"\]\{grid-column:span 2\}/);
  assert.match(html,/id="productPeriodStatus" class="muted product-period-status"/);
  for(const value of ['today','yesterday','7','30','custom'])assert.ok(html.includes('data-product-period="'+value+'"'));
});

test('Product opened from Products inherits the selected Product period',()=>{
  const detail=between("async function openProduct(","function openProductWarehouseRelease(");
  assert.match(detail,/productListContext=!market&&\(days===null\|\|days===undefined\)/);
  assert.match(detail,/selectedSpec=productListContext\?productPeriodSpec\(\):null/);
  assert.match(detail,/currentProductPeriodStats\(selectedSpec\)/);
  assert.match(detail,/await ensureProductPeriodStats\(\)/);
  assert.match(detail,/Продано · \$\{esc\(selectedSpec\.label\)\}/);
});

test('Products audit contract is recorded for future AI changes',()=>{
  assert.match(passport,/PRODUCT-15/);
  assert.match(passport,/PRODUCT-16/);
  assert.match(passport,/PRODUCT-17/);
});
