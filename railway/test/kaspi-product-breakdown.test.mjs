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
 vm.createContext(ctx);vm.runInContext(['rateForName','skuOf','qtyOf','lineTotal','localProduct','savedSalesMap','localOrderGroups','addRow'].map(line).join('\n')+'\n'+build+'\n'+['reportProfitView','paintKaspiSheet','paintStoreSheet'].map(line).join('\n'),ctx);
 const snapshot={orders:orders?[{id:'order',totalPrice:1000,deliveryCostForSeller:delivery,lines:[{merchantCode:'pink',entryId:'entry',quantity:1,totalPrice:1000}]}]:[],returns};
 const model=ctx.buildModel(snapshot,0);
 return {ctx,state,model,get sheet(){return sheet},paint(days=0){ctx.paintKaspiSheet(model,days);return sheet}};
}
const clean=s=>s.replaceAll('\u00a0',' ');
test('Kaspi product press reveals the actual period row articles inline, with no WB route or double fee subtotal',()=>{
 const f=fixture(),before=JSON.stringify(f.state);let view;const paint=f.ctx.paintStoreSheet;
 f.ctx.paintStoreSheet=(_market,days,v)=>{assert.equal(_market,'Kaspi');assert.equal(days,0);view=v;paint(_market,days,v)};
 const html=clean(f.paint()),card=view.products[0];
 assert.match(html,/<details class="item" data-kaspi-period-breakdown/);assert.ok(!html.includes('data-wb-period-breakdown'));assert.ok(!html.includes('По ШК'));
 assert.match(html,/<summary[^>]*>[\s\S]*Расчёт прибыли ▾[\s\S]*<\/summary>/);assert.ok(!html.match(/<summary[^>]*>[\s\S]*?<\/summary>/)[0].includes('onclick='));
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
