import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {withGrowthAnalyticsPage} from '../src/growth-analytics-page.js';
const read=p=>readFileSync(new URL('../../'+p,import.meta.url),'utf8');
const ctx={};vm.runInNewContext(read('growth-analytics-model.js'),ctx);const M=ctx.GrowthAnalyticsModel;
test('calculator accounts for buyout, margin, target profit, returns and click conversion',()=>{
 const input={price:10000,cost:4000,fees:1500,delivery:500,returns:200,target:800,buyout:80,conversion:5};
 const x=M.economics(input);assert.equal(x.margin,3800);assert.equal(x.order,2400);assert.equal(x.click,120);assert.equal(x.breakEven,3040);assert.equal(x.drr,24);
 for(const [k,v]of [['price',''],['fees',null],['buyout',101],['conversion',-1],['cost','bad']])assert.equal(M.economics({...input,[k]:v}),null);
 assert.equal(M.economics({...input,cost:20000}).order,0);
});
test('unknown demand never becomes zero and inventory risk has priority',()=>{
 assert.equal(M.opportunity(null,50,7).qty,null);
 assert.equal(M.opportunity({status:'known',current:70,pct:50},0,7).key,'stock');
 assert.equal(M.opportunity({status:'known',current:70,pct:-40},50,7).key,'stock');
 assert.equal(M.opportunity({status:'known',current:70,pct:-40},100,7).key,'decline');
 assert.equal(M.opportunity({status:'empty',current:0,pct:null},100,7).key,'idle');
 assert.equal(M.opportunity({status:'new',current:70,pct:null},100,7).key,'growth');
});
test('campaign history requires distinct days and handles missing denominators',()=>{
 const d=date=>({date,spend:100,revenue:1000,orders:2,clicks:10,views:200,cartAdds:3});const a=d('2026-10-26'),b=d('2026-10-27');
 const x=M.campaign({periodMetrics:[a,b,d('2026-10-28')]},a.date,b.date,2);assert.equal(x.complete,true);assert.equal(x.spend,200);assert.equal(x.ctr,5);assert.equal(x.cr,20);assert.equal(x.cpc,10);assert.equal(x.cpo,50);
 assert.equal(M.campaign({periodMetrics:[a,a]},a.date,b.date,2).complete,false);
 assert.equal(M.campaign({periodMetrics:[{...a,orders:0}]},a.date,a.date,1).cpo,null);
});
test('one marketplace history gap does not contaminate another marketplace',async()=>{
 const NOW=Date.parse('2026-10-28T12:00:00+05:00');class Clock extends Date{static now(){return NOW}}
 const p={id:'one',kaspi:'k',wb:'w'},c={window:{loadOzonProductOrderSeries:async()=>({rows:[],history:[]})},Date:Clock,console,state:{products:[p]},MILLIONER_API:'',apiJson:async()=>({rows:[{productId:'one',market:'Kaspi',day:'2026-10-26',qty:10}],history:[{market:'Kaspi',firstDate:1,lastDate:NOW}]}),document:{getElementById:()=>null}};
 vm.runInNewContext(read('product-sales-trend-v1.js'),c);await c.window.ensureProductSalesTrends({days:7});const f=c.window.productSalesTrendMetric;
 assert.equal(f(p,{days:7},'all').current,null);assert.equal(f(p,{days:7},'Kaspi').current,10);assert.equal(f(p,{days:7},'WB').current,null);
});
test('page extension installs all assets before authentication and preserves template',()=>{
 const html=withGrowthAnalyticsPage(read('index.html')),server=read('railway/src/server.js');assert.match(html,/data-view="analytics"/);assert.match(html,/'reports','analytics','ads','settings'/);assert.match(html,/activeView==='analytics'/);assert.equal((html.match(/data-view="analytics"/g)||[]).length,1);
 for(const file of ['growth-analytics.css','growth-analytics-model.js','growth-analytics-v1.js']){assert.ok(server.includes("'"+file+"'"));assert.ok(html.indexOf('./'+file)<html.lastIndexOf('initOwnerAuth();'))}
 assert.match(server,/withGrowthAnalyticsPage\(await readFile/);assert.doesNotMatch(read('growth-analytics-v1.js'),/\bsave\(|pushWarehouse|method:\s*['"](?:POST|PUT|DELETE)/);
});
test('view renders, escapes product titles, filters and persists local preferences',async()=>{
 const elements=new Map(),el=id=>{if(!elements.has(id))elements.set(id,{dataset:{},innerHTML:'',textContent:'',querySelectorAll:()=>[],classList:{contains:()=>true}});return elements.get(id)};
 const saved=new Map(),c={window:{GrowthAnalyticsModel:M,productSalesTrendMetric:()=>({status:'known',current:14,previous:7,pct:100}),ensureProductSalesTrends:async()=>{}},document:{getElementById:el},localStorage:{getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v)},state:{products:[{id:'x',name:'<unsafe>',kaspi:'x'}]},productAvailableStock:()=>100,adsApi:async()=>({campaigns:[]}),console,Date,Map,Promise,AbortSignal,setTimeout,openProduct(){},openView(){}};
 vm.runInNewContext(read('growth-analytics-v1.js'),c);c.window.renderGrowthAnalytics();await new Promise(r=>setTimeout(r,0));assert.match(el('gaProducts').innerHTML,/&lt;unsafe&gt;/);c.window.growthAnalyticsSearch('missing');assert.match(el('gaProducts').innerHTML,/Нет товаров/);c.window.growthAnalyticsPeriod(14);await new Promise(r=>setTimeout(r,0));assert.equal(JSON.parse(saved.get('growthAnalyticsUiV1')).days,14);c.window.growthAnalyticsMarket('Kaspi');assert.match(el('gaAds').textContent,/доступна для WB/);
});
