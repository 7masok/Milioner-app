import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const report=readFileSync(new URL('../../kaspi-report-v2.js',import.meta.url),'utf8');
const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
const line=name=>report.split('\n').find(x=>x.startsWith('function '+name+'('));
const liveStats=report.slice(report.indexOf('function businessWbLiveStats('),report.indexOf('function resolvedWbReportStats('));
const liveSheet=report.slice(report.indexOf('function paintWbLiveSheet('),report.indexOf('function paintWbSheet('));
function fixture(model,live){
 const elements=new Map(),window={};let sheet='';
 Object.defineProperty(window,'allMarketUnitProfit30',{get(){throw Error('historical forecast used')}});
 const c={window,storeDetailSeq:0,reportPeriod:-1,marketplaceReportContext:null,console,
  document:{getElementById(id){if(!elements.has(id))elements.set(id,{textContent:'',innerHTML:''});return elements.get(id)}},
  esc:x=>String(x??'').replaceAll('"','&quot;').replaceAll('<','&lt;'),fmt:x=>String(x)+' ₸',
  storeTitle:()=> 'WB 2',detailPeriodHtml:()=>'',reportConfidenceNote(){},wbFinanceAvailabilityNote:()=>'',wbLiveCostCoverageNote:()=>'',
  wbLiveProductId:(_m,x)=>x.productId,productNameById:(_id,name)=>name||'Товар',wbRealizedFifoCost:()=>6655,
  wbLiveRealizedCostSummary:()=>({cost:6503,complete:true,knownUnits:38,totalUnits:38}),
  wbReportProductAuditAction:()=> 'openWbProductOperations()',
  warmWb:()=>model,loadWbModel:async()=>model,ensureWbLiveOverview:async()=>live,showSheet:x=>{sheet=x}
 };
 const functions=[line('wbReportProductCost'),line('wbReportAmount'),liveStats,line('resolvedWbReportStats'),line('paintStoreSheet'),line('paintWbSheet'),liveSheet,line('renderWbCompact'),
  report.split('\n').find(x=>x.startsWith('window.openStoreDetail='))].join('\n');
 vm.runInNewContext(functions,c);
 return {c,elements,get sheet(){return sheet}};
}
const finance={market:'WB2',financeAvailable:true,complete:true,revenue:48004,cost:6655,expenses:15850,
 ads:0,profit:25499,adjustment:0,products:[{productId:'a',vendorCode:'Пуля нож',qty:38,saleQty:38,retailAmount:48004,
  netBeforeCost:32154,advertising:0,wbExpenses:15850}]};
const operational={buyoutSum:9330,buyoutCount:38,products:[{productId:'a',vendorCode:'Пуля нож',qty:38,buyoutSum:9330,forPay:6466}]};

test('WB2 screenshot: summary and yesterday detail show the same financial profit without revenue scaling',async()=>{
 const f=fixture(finance,operational);f.c.renderWbCompact(finance,'WB2',-1,operational);
 assert.equal(f.elements.get('rProfit').textContent,'25499 ₸');
 await f.c.window.openStoreDetail('WB2',-1);
 assert.ok(f.sheet.includes('<b>25499 ₸</b>'));
 assert.ok(f.sheet.includes('48004 ₸'));assert.ok(f.sheet.includes('15850 ₸'));assert.ok(f.sheet.includes('6655 ₸'));
 assert.ok(!f.sheet.includes('-37 ₸'));assert.ok(!f.sheet.includes('9330 ₸'));assert.ok(!f.sheet.includes('Факт WB · к перечислению'));
 assert.ok(f.sheet.includes('openWbProductOperations'));
});

test('today detail also chooses the same financial model as the summary',async()=>{
 const f=fixture(finance,operational);const view=f.c.resolvedWbReportStats(finance,operational,'WB2',1);
 await f.c.window.openStoreDetail('WB2',1);
 assert.equal(view.useLive,false);assert.ok(f.sheet.includes('<b>'+view.profit+' ₸</b>'));
});

test('when finance has not arrived both summary and product details keep profit and expenses unknown',async()=>{
 const model={...finance,financeAvailable:false,revenue:0,cost:0,expenses:0,profit:null,products:[]};
 const f=fixture(model,operational);f.c.renderWbCompact(model,'WB2',-1,operational);
 assert.equal(f.elements.get('rProfit').textContent,'—');assert.equal(f.elements.get('rFees').textContent,'—');
 await f.c.window.openStoreDetail('WB2',-1);
 assert.ok(f.sheet.includes('≈ 9330 ₸'));assert.ok(f.sheet.includes('Чистая прибыль</b></span><b>—</b>'));
 assert.ok(f.sheet.includes('<span class="grow muted">Расходы</span><b>—</b>'));
 assert.ok(f.sheet.includes('<div class="label">Прибыль</div><b>—</b>'));
 assert.ok(!f.sheet.includes('Предв. прибыль'));assert.ok(!f.sheet.includes('Факт WB'));
});

test('a lagging financial snapshot cannot supply confirmed profit to larger operational buyouts',async()=>{
 const f=fixture({...finance,revenue:1000},operational);
 await f.c.window.openStoreDetail('WB2',-1);
 assert.ok(f.sheet.includes('Чистая прибыль</b></span><b>—</b>'));
 assert.ok(f.sheet.includes('≈ 9330 ₸'));assert.ok(!f.sheet.includes('25499 ₸'));
});

test('operational cache with missing product prices does not display fictitious zero sales for the product',async()=>{
 const model={...finance,financeAvailable:false,revenue:0,profit:null,products:[]};
 const f=fixture(model,{...operational,analyticsOnly:true,products:[{productId:'a',qty:38}]});
 await f.c.window.openStoreDetail('WB2',-1);
 assert.ok(f.sheet.includes('≈ 9330 ₸'));
 assert.ok(f.sheet.includes('38 шт. · продажи —'));
 assert.ok(!f.sheet.includes('38 шт. · продажи ≈ 0 ₸'));
});

test('legacy daily entry delegates without a separate calculation, and proportional currency guesses are removed',async()=>{
 const source=html.slice(html.indexOf('async function openWbFinanceReport('),html.indexOf('\nfunction openMarketplaceReport('));
 let args;const c={openStoreDetail:(...x)=>{args=x;return 'shared detail'}};
 vm.runInNewContext(source,c);assert.equal(await c.openWbFinanceReport('WB2',-1),'shared detail');assert.deepEqual(args,['WB2',-1]);
 assert.ok(!html.includes('wbFinanceKztNet'));assert.ok(!html.includes('netKzt'));assert.ok(!source.includes('apiJson'));
});

test('an older detail load cannot replace a newer selected store period',async()=>{
 const f=fixture(finance,operational);let resolve;
 f.c.loadWbModel=()=>new Promise(r=>{resolve=r});
 const first=f.c.window.openStoreDetail('WB2',-1);
 f.c.loadWbModel=async()=>({...finance,profit:100});
 await f.c.window.openStoreDetail('WB2',1);const latest=f.sheet;
 resolve(finance);await first;
 assert.equal(f.sheet,latest);assert.ok(f.sheet.includes('<b>100 ₸</b>'));
});
