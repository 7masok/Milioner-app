import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
function extract(name){const start=html.indexOf('function '+name+'(');assert.ok(start>=0);return html.slice(start,html.indexOf('\nfunction ',start+10));}
function fixture(saved={},products=[
 {id:'red',name:'Леденец красный',category:'Брелки',sku:'101'},
 {id:'blue',name:'Леденец синий',category:' брелки ',sku:'102'},
 {id:'knife',name:'Нож',category:'Ножи',sku:'201'},
 {id:'empty',name:'Тетрис',category:'   ',sku:'301'},
 {id:'similar',name:'Леденец игрушка',category:'Брелки и игрушки',sku:'401'}
]){
 const elements=new Map();
 const element=id=>{if(!elements.has(id))elements.set(id,{value:'',innerHTML:'',textContent:'',classList:{toggle(){}},removeAttribute(name){this.removed=name;}});return elements.get(id);};
 let storage=JSON.stringify(saved),renders=0;
 const stats={products,searchMap:new Map(products.map(p=>[p.id,(p.name+' '+p.sku).toLowerCase()])),fboMap:new Map([['blue',3],['empty',2]])};
 const metrics=new Map(products.map((p,i)=>[p.id,{qty:i+1}]));
 const ctx={console,Map,Set,Number,String,Math,JSON,KEY:'fixture',PRODUCT_UI_KEY:'fixture_product_ui_v1',PRODUCT_PAGE_SIZE:2,productPage:1,
  state:{products,settings:{}},document:{getElementById:element},
  localStorage:{getItem:()=>storage,setItem:(key,value)=>{storage=value;}},
  productUiFrame:fn=>fn(),productPeriodRequests:new Map(),currentProductPeriodStats:()=>metrics,
  productRenderStatsCache:stats,buildProductRenderStats:()=>{throw new Error('category choice must reuse the warehouse snapshot');},
  renderProductSummary(){},syncProductRankButton(){},scheduleProductHeavyMetrics(){},
  normalizeName:x=>String(x).toLowerCase(),esc:x=>String(x).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c])),
  productInventoryRow:()=>({available:0}),productCard:p=>p.id+'|',
  compareProductsForList:(a,b,sort,direction,stats,metrics)=>(metrics.get(a.id).qty-metrics.get(b.id).qty)*(direction==='asc'?1:-1),
  save(){throw new Error('category filter must not write warehouse data');}
 };
 vm.createContext(ctx);
 const start=html.indexOf('function readProductUi('),end=html.indexOf('\nfunction productRankSpec(',start);
 vm.runInContext(html.slice(start,end)+'\n'+extract('productRankSpec')+'\n'+extract('renderProducts'),ctx);
 return {ctx,element,stats,saved:()=>JSON.parse(storage),render(){renders++;ctx.renderProducts(false);},list:()=>element('productList').innerHTML};
}

test('category filter uses exact normalized categories and intersects with SKU search and FBO',()=>{
 const f=fixture();f.render();f.ctx.setProductCategory('category:Брелки');
 assert.equal(f.list(),'red|blue|');
 assert.match(f.element('productCategoryLabel').textContent,/Брелки/);
 f.element('q').value='102';f.render();assert.equal(f.list(),'blue|');
 f.element('q').value='';vm.runInContext('productFboOnly=true',f.ctx);f.render();assert.equal(f.list(),'blue|');
 f.element('q').value='101';f.render();assert.match(f.list(),/В выбранной категории на FBO Ozon по этому запросу товаров нет/);
 assert.equal(f.element('productPager').innerHTML,'');
});

test('uncategorized and all-category choices reset pagination while preserving search and ranking',()=>{
 const f=fixture({rankSort:'sales',rankDays:60,rankDirection:'asc',q:'Леденец',page:3});
 f.ctx.setProductCategory('none');assert.equal(f.list(),'empty|');assert.equal(f.ctx.productPage,1);
 f.element('q').value='Леденец';f.ctx.setProductCategory('category:Брелки');assert.equal(f.list(),'red|blue|');
 f.ctx.setProductCategory('all');assert.equal(f.list(),'red|blue|');assert.match(f.element('productPager').innerHTML,/3 товаров/);
 assert.equal(f.element('q').value,'Леденец');
 assert.equal(f.saved().rankSort,'sales');assert.equal(f.saved().rankDays,60);assert.equal(f.saved().rankDirection,'asc');
 assert.equal(f.element('productCategoryPicker').removed,'open');
});

test('category choice survives reload and a missing selected category stays explicit',()=>{
 const f=fixture();f.ctx.setProductCategory('category:Ножи');
 const reload=fixture(f.saved());reload.render();assert.equal(reload.list(),'knife|');
 reload.stats.products=reload.stats.products.filter(p=>p.id!=='knife');reload.render();
 assert.match(reload.element('productCategoryLabel').textContent,/Ножи/);
 assert.match(reload.list(),/В выбранной категории товаров нет/);
 reload.ctx.setProductCategory('all');assert.doesNotMatch(reload.list(),/товаров нет/);
});

test('category menu deduplicates names, counts snapshot products and escapes user category text',()=>{
 const f=fixture();f.render();const menu=f.element('productCategoryOptions').innerHTML;
 assert.equal((menu.match(/data-value="category:Брелки"/g)||[]).length,1);
 assert.doesNotMatch(menu,/data-value="category: брелки /);
 assert.match(menu,/Без категории<\/span><span class="muted">1/);
 assert.match(menu,/Брелки<\/span><span class="muted">2/);
 f.stats.products.push({id:'hostile',name:'Товар',category:'<img src=x onerror="bad()">'});f.render();
 assert.doesNotMatch(f.element('productCategoryOptions').innerHTML,/<img/);
 assert.match(f.element('productCategoryOptions').innerHTML,/&lt;img/);
});

test('category menu sits below the existing search/ranking row and uses an independent local state key',()=>{
 const section=html.slice(html.indexOf('<section id="products"'),html.indexOf('<section id="prices"'));
 assert.ok(section.indexOf('id="productCategoryPicker"')>section.indexOf('id="productRankButton"'));
 assert.ok(section.indexOf('id="productCategoryPicker"')<section.indexOf('id="productList"'));
 assert.match(section,/<details id="productCategoryPicker"/);
 assert.match(html,/\.product-category-options\{[^}]*left:0;right:0;max-height:260px;overflow-y:auto/);
 assert.doesNotMatch(extract('setProductCategory'),/\bsave\(|ensureProductRankStats|invalidateProductRenderStats|fetch\(/);
});

test('store filters use explicit links and aliases, keep WB cabinets separate and ignore sale counts',()=>{
 const products=[{id:'a',name:'А',kaspi:'K1',wb:'W1'},{id:'b',name:'Б',wb2Aliases:['  B2  ']},{id:'c',name:'В',ozon:'O1'},{id:'d',name:'Г',wbAliases:['  ']},{id:'g',name:'Д',kind:'variant-group'},{id:'child',name:'Размер',variantGroupId:'g',wb2:'SIZE'}];
 const f=fixture({},products);f.stats.products=products.filter(p=>!p.variantGroupId);
 f.ctx.setProductStore('wb');assert.equal(f.list(),'a|');
 f.ctx.setProductStore('wb2');assert.equal(f.list(),'b|g|');
 f.ctx.setProductStore('ozon');assert.equal(f.list(),'c|');
 f.ctx.setProductStore('kaspi');assert.equal(f.list(),'a|');
 f.ctx.setProductStore('all');assert.match(f.element('productPager').innerHTML,/5 товаров/);
 assert.match(f.element('productStoreTabs').innerHTML,/aria-pressed="true"[^>]*>Все/);
});

test('store choice persists and intersects with category search FBO and ranking without writing inventory',()=>{
 const products=[{id:'red',name:'Красный',category:'Брелки',kaspi:'K1'},{id:'blue',name:'Синий',category:'Брелки',kaspiAliases:['K2']},{id:'knife',name:'Нож',category:'Ножи',wb2:'W'}];
 const f=fixture({rankSort:'sales',rankDays:60,rankDirection:'asc',page:3},products);
 f.ctx.setProductStore('kaspi');assert.equal(f.ctx.productPage,1);assert.equal(f.saved().storeFilter,'kaspi');assert.equal(f.saved().rankDays,60);
 f.ctx.setProductCategory('category:Брелки');vm.runInContext('productFboOnly=true',f.ctx);f.render();assert.equal(f.list(),'blue|');
 f.element('q').value='Красный';f.render();assert.match(f.list(),/Нет товаров с привязкой к Kaspi/);
 const reload=fixture(f.saved(),products);reload.render();assert.equal(reload.list(),'red|blue|');
 const invalid=fixture({storeFilter:'unknown'},products);invalid.render();assert.match(invalid.element('productPager').innerHTML,/3 товаров/);
});

test('store link badges escape identifiers, display selected store codes and handle unlinked products',()=>{
 const f=fixture();f.ctx.setProductStore('ozon');
 const text=f.ctx.productStoreLinksHtml({kaspi:'K',ozonAliases:['<img onerror="bad()">']});
 assert.match(text,/Kaspi/);assert.match(text,/class="selected">Ozon · &lt;img/);assert.doesNotMatch(text,/<img/);
 assert.match(f.ctx.productStoreLinksHtml({}),/Без привязок/);
 assert.doesNotMatch(extract('setProductStore'),/\bsave\(|fetch\(|invalidateProductRenderStats|ensureProductRankStats/);
});

test('unlinked button includes only products with no store codes, including aliases and size children',()=>{
 const products=[{id:'a',name:'А',kaspi:'K'},{id:'b',name:'Б',wb2Aliases:['B']},{id:'c',name:'В',wb:'  ',ozonAliases:['']},{id:'g',name:'Г',kind:'variant-group'},{id:'child',name:'Размер',variantGroupId:'g',ozon:'O'}];
 const f=fixture({},products);f.stats.products=products.filter(p=>!p.variantGroupId);
 f.ctx.setProductStore('unlinked');assert.equal(f.list(),'c|');assert.equal(f.saved().storeFilter,'unlinked');
 assert.equal(f.element('productStoreLinkMode').hidden,true);assert.match(f.element('productStoreTabs').innerHTML,/aria-pressed="true"[^>]*>Без привязки/);
 const reload=fixture(f.saved(),products);reload.stats.products=f.stats.products;reload.render();assert.equal(reload.list(),'c|');
 f.ctx.setProductStoreUnlinked(true);assert.equal(f.list(),'c|');
 f.element('q').value='Размер';f.render();assert.match(f.list(),/Товаров без привязок к магазинам по выбранным фильтрам нет/);
});

test('missing links for selected store invert only its links and preserve independent filters on reload',()=>{
 const products=[{id:'a',name:'А',category:'Брелки',kaspi:'K'},{id:'blue',name:'Б',category:'Брелки',wb2Aliases:['B']},{id:'c',name:'В',category:'Ножи'}];
 const f=fixture({rankSort:'sales',rankDays:60,rankDirection:'asc'},products);
 f.ctx.setProductStore('kaspi');f.ctx.setProductStoreUnlinked(true);assert.equal(f.list(),'blue|c|');
 assert.equal(f.element('productStoreLinkMode').hidden,false);assert.equal(f.ctx.productPage,1);assert.equal(f.saved().storeUnlinked,true);assert.equal(f.saved().rankDays,60);
 f.ctx.setProductCategory('category:Брелки');vm.runInContext('productFboOnly=true',f.ctx);f.render();assert.equal(f.list(),'blue|');
 const reload=fixture(f.saved(),products);reload.render();assert.equal(reload.list(),'blue|');
 f.ctx.setProductStore('wb2');assert.match(f.list(),/Товаров без привязки к WB 2/);
 f.ctx.setProductStoreUnlinked(false);assert.equal(f.list(),'blue|');
 f.ctx.setProductStore('all');assert.equal(f.element('productStoreLinkMode').hidden,true);
 assert.doesNotMatch(extract('setProductStoreUnlinked'),/\bsave\(|fetch\(|invalidateProductRenderStats/);
});
