import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../../kaspi-report-v2.js',import.meta.url),'utf8');
const line=name=>source.split('\n').find(s=>s.startsWith('function '+name+'('));
const build=source.slice(source.indexOf('function buildModel('),source.indexOf('\nfunction reportProfitView('));
const money=n=>new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2}).format(Number(n)||0)+' ₸';
function fixture({delivery=80,ads=20,cost=100,orders=true,returns=[]}={}){
 let sheet='';const state={products:[{id:'pink',name:'Сладкий набор розовый',kaspi:'pink',cost}],sales:[]};
 const ctx={state,window:{},prod:id=>state.products.find(p=>p.id===id),groupMarketplaceOrders:()=>[],isPendingMarketplaceLine:()=>false,
  reportSaleUnitCost:id=>state.products.find(p=>p.id===id)?.cost||0,kaspiAdsNameKey:x=>String(x).toLowerCase(),
  kaspiAdsBreakdown:()=>({byProduct:new Map([['pink',ads]]),unmatched:0}),productNameById:()=> 'Сладкий набор розовый',
  money,fmt:money,esc:x=>String(x??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),storeTitle:()=> 'Kaspi',
  detailPeriodHtml:(_market,days)=>'<div data-test-days="'+days+'"></div>',reportCustomRangeHtml:()=>'<div>Мой период</div>',showSheet:s=>{sheet=s},
  apiJson(){throw Error('Opening a product disclosure must not request data');},
 };
 vm.createContext(ctx);vm.runInContext(['rateForName','skuOf','qtyOf','lineTotal','localProduct','savedSalesMap','localOrderGroups','addRow','kaspiBuyoutRows'].map(line).join('\n')+'\n'+build+'\n'+['reportProfitView','paintKaspiSheet','paintStoreSheet'].map(line).join('\n'),ctx);
 const snapshot={orders:orders?[{id:'order',totalPrice:1000,deliveryCostForSeller:delivery,lines:[{merchantCode:'pink',entryId:'entry',quantity:1,totalPrice:1000}]}]:[],returns};
 const model=ctx.buildModel(snapshot,0);
 return {ctx,state,model,snapshot,get sheet(){return sheet},paint(days=0){ctx.paintKaspiSheet(model,days);return sheet}};
}
const clean=s=>s.replaceAll('\u00a0',' ');
test('Kaspi product press reveals the actual period row articles inline, with no WB route or double fee subtotal',()=>{
 const f=fixture(),before=JSON.stringify(f.state);let view;const paint=f.ctx.paintStoreSheet;
 f.ctx.paintStoreSheet=(_market,days,v)=>{assert.equal(_market,'Kaspi');assert.equal(days,0);view=v;paint(_market,days,v)};
 const html=clean(f.paint()),card=view.products[0];
 assert.match(html,/<details class="item" data-kaspi-period-breakdown/);assert.ok(!html.includes('data-wb-period-breakdown'));assert.ok(!html.includes('По ШК'));
 assert.match(html,/<summary[^>]*>[\s\S]*Расчёт прибыли <span class="arrow">▾<\/span>[\s\S]*<\/summary>/);assert.ok(!html.match(/<summary[^>]*>[\s\S]*?<\/summary>/)[0].includes('onclick='));
 assert.ok(html.includes('Мой период'));assert.ok(html.includes('data-test-days="0"'));
 assert.deepEqual(Array.from(card.breakdown,r=>r.label),['Выручка','Себестоимость','Комиссия Kaspi','Kaspi Pay · эквайринг','Логистика','Сервисные удержания','Реклама']);
 const expected=[1000,-100,-145.586,-9.5,-80,-.8,-20];
 const parse=t=>Number(t.replace(/[^0-9,.−-]/g,'').replace('−','-').replace(',','.'));
 for(let i=0;i<expected.length;i++)assert.ok(Math.abs(parse(card.breakdown[i].text)-expected[i])<.0051);
 assert.equal(clean(card.profit),'≈ 644,11 ₸');assert.equal(clean(card.fees),'≈ 235,89 ₸');
 assert.ok(Math.abs(card.breakdown.reduce((sum,r)=>sum+parse(r.text),0)-parse(card.profit))<1e-8);
 assert.equal(JSON.stringify(f.state),before);assert.ok(html.includes('по расчётным ставкам'));
});
test('explicit seller delivery stays known while fallback delivery and rate-based fees retain approximation',()=>{
 for(const delivery of [80,0]){const f=fixture({delivery});let view;f.ctx.paintStoreSheet=(_m,_d,v)=>{view=v};f.paint(7);const lines=view.products[0].breakdown;
  assert.equal(lines.find(x=>x.label==='Логистика').text,(delivery?'':'≈ ')+money(-(delivery||57)));
  for(const label of ['Комиссия Kaspi','Kaspi Pay · эквайринг','Сервисные удержания'])assert.match(lines.find(x=>x.label===label).text,/^≈ /);
 }
});
test('unknown Kaspi cost keeps both compact and expanded cost/profit unknown without hiding known charges',()=>{
 const f=fixture({cost:0});let view;f.ctx.paintStoreSheet=(_m,_d,v)=>{view=v};f.paint();const card=view.products[0];
 assert.equal(card.cost,'—');assert.equal(card.profit,'—');assert.equal(card.breakdown.find(x=>x.label==='Себестоимость').text,'—');
 assert.equal(card.breakdown.find(x=>x.label==='Реклама').text,money(-20));assert.match(card.breakdown.find(x=>x.label==='Комиссия Kaspi').text,/145,59/);
});
test('return fee reversals and ad-only expense keep their signs and the same underlying Kaspi totals',()=>{
 const f=fixture({orders:false,returns:[{id:'returned',amount:1000,code:'123'}]}),before=JSON.stringify(f.model);let view;f.ctx.paintStoreSheet=(_m,_d,v)=>{view=v};f.paint(-1);
 const returned=view.products.find(x=>x.qty===-1),adOnly=view.products.find(x=>x.qty===0);
 assert.equal(returned.breakdown.find(x=>x.label==='Выручка').text,money(-1000));
 assert.equal(returned.breakdown.find(x=>x.label==='Комиссия Kaspi').text,'≈ + '+money(145.586));
 assert.equal(returned.breakdown.find(x=>x.label==='Kaspi Pay · эквайринг').text,'≈ + '+money(9.5));
 assert.equal(adOnly.breakdown.find(x=>x.label==='Реклама').text,money(-20));assert.equal(adOnly.profit,'≈ '+money(-20));
 assert.equal(JSON.stringify(f.model),before);
});

test('individual Kaspi buyouts reconcile with product totals before advertising without changing warehouse data',()=>{
 const f=fixture(),before=JSON.stringify(f.state);f.snapshot.orders.push({id:'second',code:'002',completionDate:5,totalPrice:2000,deliveryCostForSeller:0,lines:[{merchantCode:'pink',entryId:'two',quantity:2,totalPrice:2000}]});
 const plain=f.ctx.buildModel(f.snapshot,7),detailed=f.ctx.buildModel(f.snapshot,7,null,null,true);
 assert.equal(plain.buyouts,undefined);assert.equal(detailed.buyouts.length,2);assert.equal(detailed.buyouts[0].id,'second');
 for(const key of ['qty','revenue','cost','fees'])assert.ok(Math.abs(detailed.buyouts.reduce((n,o)=>n+o[key],0)-plain[key])<1e-8,key);
 assert.ok(Math.abs(detailed.buyouts.reduce((n,o)=>n+o.profit,0)-(plain.profit+plain.ads))<1e-8);
 assert.equal(detailed.buyouts.find(x=>x.id==='second').lines[0].delivery,0,'Preserve the existing explicit delivery pool; do not invent a new fee');
 assert.equal(JSON.stringify(f.state),before);
});
test('fallback delivery, revenue normalization and pending/unknown cost stay honest for each buyout',()=>{
 const f=fixture({delivery:0});f.snapshot.orders[0].totalPrice=2000;f.snapshot.orders[0].lines[0].quantity=2;
 let model=f.ctx.buildModel(f.snapshot,7,null,null,true),order=model.buyouts[0];
 assert.equal(order.revenue,2000);assert.equal(order.lines[0].delivery,114);assert.equal(order.cost,200);
 f.snapshot.orders.push({id:'pending',totalPrice:300,lines:[]});model=f.ctx.buildModel(f.snapshot,7,null,null,true);
 assert.equal(model.buyouts.find(x=>x.id==='pending').unknownCost,true);
 const noCost=fixture({cost:0});assert.equal(noCost.ctx.buildModel(noCost.snapshot,1,null,null,true).buyouts[0].unknownCost,true);
});
test('buyout summary exposes profit before disclosure and escapes order and product text',()=>{
 const f=fixture();vm.runInContext(source.slice(source.indexOf('function kaspiBuyoutCard('),source.indexOf('\nwindow.paintKaspiBuyouts=')),f.ctx);
 const model=f.ctx.buildModel(f.snapshot,1,null,null,true),order=model.buyouts[0];order.code='<order>';order.lines[0].name='<product>';
 const html=clean(f.ctx.kaspiBuyoutCard(order)),summary=html.slice(0,html.indexOf('</summary>'));
 assert.match(summary,/До рекламы/);assert.match(summary,/≈ 664,11 ₸/);assert.ok(!summary.includes('<order>'));assert.ok(html.includes('&lt;product>'));
 assert.match(html,/report-disclosure-body/);assert.match(html,/class="arrow"/);
 order.unknownCost=true;assert.match(f.ctx.kaspiBuyoutCard(order),/До рекламы<\/div><b>—<\/b>/);
});

test('Kaspi buyout pages use one snapshot, keep at most 15 cards and discard late responses after closing',async()=>{
 const f=fixture();let sheet='',open=true,loads=0,finish;const node={scrollTop:99};
 Object.assign(f.ctx,{storeDetailSeq:0,reportPeriod:7,reportCustomFrom:'2026-10-01',reportCustomTo:'2026-10-20',reportAdsPeriodLabel:()=> '7 дней',periodCacheKey:days=>String(days),
  showSheet:html=>{sheet=html},document:{getElementById:id=>id==='modal'?{classList:{contains:()=>open}}:id==='sheet'?node:id==='kaspiBuyoutLoading'&&sheet.includes('kaspiBuyoutLoading')?{dataset:{request:sheet.match(/data-request="(\d+)"/)[1]}}:null},
  loadKaspiOrders:()=>{loads++;return new Promise(resolve=>{finish=resolve})}});
 f.ctx.window=f.ctx;vm.runInContext(source.slice(source.indexOf('let kaspiBuyoutView='),source.indexOf('function paintKaspiSheet(')),f.ctx);
 const pending=f.ctx.openKaspiBuyouts(7);open=false;finish(f.snapshot);await pending;assert.match(sheet,/Готовлю список/);
 open=true;const next=f.ctx.openKaspiBuyouts(7),snapshot={...f.snapshot,orders:Array.from({length:32},(_,i)=>({...f.snapshot.orders[0],id:'order'+i,code:String(i),completionDate:i+1}))};finish(snapshot);await next;
 assert.equal((sheet.match(/data-kaspi-buyout /g)||[]).length,15);assert.match(sheet,/Страница 1 из 3/);assert.match(sheet,/Реклама учитывается в общем отчёте/);
 f.ctx.paintKaspiBuyouts(3);assert.equal(loads,2);assert.equal((sheet.match(/data-kaspi-buyout /g)||[]).length,2);assert.match(sheet,/Страница 3 из 3/);assert.equal(node.scrollTop,0);
});
