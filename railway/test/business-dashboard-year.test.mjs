import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {businessCacheKey,validBusinessSnapshot} from '../src/business-dashboard-cache.js';
const source=readFileSync(new URL('../../business-dashboard-v1.js',import.meta.url),'utf8');
const DAY=86400000,NOW=Date.parse('2026-10-17T13:13:00+05:00');
function fixture(saved={period:'year'}){
 let now=NOW;
 class Clock extends Date{constructor(...args){super(...(args.length?args:[now]))}static now(){return now}}
 const elements=new Map(),storage=new Map([['milioner_business_dashboard_v1',JSON.stringify(saved)]]);
 const el=id=>{if(!elements.has(id))elements.set(id,{id,innerHTML:'',textContent:'',dataset:{},classList:{contains:()=>true,toggle(){}},setAttribute(k,v){this[k]=v},addEventListener(){}});return elements.get(id)};
 for(const id of ['reports','businessDashboard','businessChart','businessPeriodTitle','businessPeriodSub','businessDayNav','businessDayDate','businessDayPrevious','businessDayNext','businessValueMetric','businessValueLabel','businessValue','businessValueMeta','businessYesterdayLabel','businessYesterdayValue','businessYesterdayMeta','businessYesterdayCompare'])el(id);
 const window={setTimeout:cb=>cb()};const ctx={window,Date:Clock,Intl,Map,Set,console:{warn(){}},state:{},localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},document:{readyState:'loading',getElementById:id=>elements.get(id)||null,querySelectorAll:()=>[],addEventListener(){}},fmt:n=>String(n)+' ₸'};
 vm.createContext(ctx);vm.runInContext(source.replace(/\}\)\(\);\s*$/, 'window.testApi={businessYearBounds,businessSelectedYearOffset,businessBuckets,businessBuildYearModel,businessYearFromMonths,businessPaint,businessPaintTabs,businessModelKey,businessLoadYearMonth,businessDays,businessMakeDay};})();'),ctx);
 return{ctx,window,api:window.testApi,el,storage,setNow:t=>{now=t}};
}
function monthData(bucket,n=100){return{period:'month',bounds:{start:bucket.start,end:bucket.end},buckets:[{...bucket,orders:n,orderQty:2,orderProfit:20,buyouts:n/2,buyoutQty:1,buyoutProfit:10}],orders:{amount:n,qty:2,profit:20,orderCount:1,coverage:1},summary:{revenue:n/2,qty:1,profit:10}}}
const loader=async bucket=>{const month=monthData(bucket);return{month,samePoint:{...month,orders:{...month.orders,amount:25},summary:{...month.summary,revenue:12.5}}}};
test('year boundaries, leap years, twelve month buckets, and Almaty saved selection',()=>{
 const f=fixture({period:'year',yearDate:'2025-01-01'});assert.equal(f.api.businessSelectedYearOffset(),-1);
 const leap=f.api.businessYearBounds(-2);assert.equal(leap.start,Date.parse('2024-01-01T00:00:00+05:00'));assert.equal(leap.days,366);
 const buckets=f.api.businessBuckets('year',leap);assert.equal(buckets.length,12);assert.equal((buckets[1].end-buckets[1].start)/DAY,29);
 f.api.businessPaintTabs();assert.match(f.el('businessDayDate').innerHTML,/2025 год/);assert.match(f.el('businessPeriodSub').textContent,/по месяцам/);
 f.setNow(Date.parse('2027-01-01T00:05:00+05:00'));assert.equal(f.api.businessSelectedYearOffset(),-2);
});
test('year aggregates months and compares the same calendar date rather than elapsed days of a leap year',async()=>{
 const f=fixture(),requests=[];const model=await f.api.businessBuildYearModel(false,0,async b=>{requests.push(b);return loader(b)});
 assert.equal(requests.length,22);assert.ok(requests.every(b=>b.end-b.start<=31*DAY));
 assert.equal(model.orders.amount,1000);assert.equal(model.summary.revenue,500);assert.equal(model.yesterday.orders.amount,1200);
 assert.equal(model.yesterdayCompare.orders.amount,925);assert.equal(model.yesterdayCompare.summary.revenue,462.5);
 assert.equal(model.yesterdayCompare.yearPartial,false);assert.equal(model.yesterdayCompare.comparisonCutoff,Date.parse('2025-10-17T13:13:00+05:00'));
 assert.equal(model.buckets[10].future,true);assert.equal(model.yearPartial,false);
 assert.ok(validBusinessSnapshot(JSON.parse(JSON.stringify(model)),'year',model.bounds.start));
 f.api.businessPaint(model);assert.match(f.el('businessYesterdayCompare').innerHTML,/прошлый год до 17 окт/);assert.match(f.el('businessYesterdayCompare').innerHTML,/%/);
 const html=f.el('businessChart').innerHTML;assert.equal((html.match(/class="business-x-label"/g)||[]).length,12);assert.match(html,/янв/);assert.match(html,/дек/);assert.doesNotMatch(html,/окт:00/);
});
test('missing months are gaps and partial totals, without invented zero history or percent',async()=>{
 const f=fixture();const model=await f.api.businessBuildYearModel(false,0,async b=>{
  if(b.start<Date.parse('2026-08-01T00:00:00+05:00'))throw Object.assign(Error('missing'),{businessHistoryPending:true});return loader(b);
 });
 assert.equal(model.knownMonths,3);assert.equal(model.expectedMonths,10);assert.equal(model.yearPartial,true);assert.equal(model.orders.amount,300);assert.equal(model.yesterday.unavailable,true);
 f.api.businessPaint(model);assert.match(f.el('businessValue').textContent,/≈ 300/);assert.match(f.el('businessValueMeta').textContent,/3 из 10/);assert.equal(f.el('businessYesterdayValue').textContent,'—');assert.doesNotMatch(f.el('businessYesterdayCompare').innerHTML,/%/);
 const chart=f.el('businessChart').innerHTML;assert.match(chart,/Нет полной истории/);assert.equal((chart.match(/class="business-bar /g)||[]).length,3);
 assert.ok(validBusinessSnapshot(JSON.parse(JSON.stringify(model)),'year',model.bounds.start));
});
test('empty history stays unknown while a confirmed empty month is a real zero',async()=>{
 const f=fixture();const unknown=await f.api.businessBuildYearModel(false,0,async()=>{throw Error('offline')});f.api.businessPaint(unknown);
 assert.equal(f.el('businessValue').textContent,'—');assert.equal((f.el('businessChart').innerHTML.match(/class="business-bar /g)||[]).length,0);
 const zero=await f.api.businessBuildYearModel(false,0,async b=>{const m=monthData(b,0);return{month:m,samePoint:m}});f.api.businessPaint(zero);
 assert.equal(f.el('businessValue').textContent,'0 ₸');assert.equal(zero.yearPartial,false);
});
test('completed selected years compare full years; year cache accepts only January 1 and twelve buckets',async()=>{
 const f=fixture({period:'year',yearDate:'2025-01-01'}),model=await f.api.businessBuildYearModel(false,-1,loader);
 assert.equal(model.orders.amount,1200);assert.equal(model.yesterdayCompare.orders.amount,1200);assert.equal(model.yearPartial,false);
 assert.equal(businessCacheKey('year',Date.parse('2026-01-01T00:00:00+05:00')),'year:'+Date.parse('2026-01-01T00:00:00+05:00'));
 assert.equal(businessCacheKey('year',Date.parse('2026-02-01T00:00:00+05:00')),null);
 assert.ok(validBusinessSnapshot(JSON.parse(JSON.stringify(model)),'year',model.bounds.start));
 model.buckets.pop();assert.equal(validBusinessSnapshot(JSON.parse(JSON.stringify(model)),'year',model.bounds.start),false);
});
test('year arrows, reset and restored selection use the selected year throughout rendering',async()=>{
 const f=fixture();f.ctx.yearLoader=loader;vm.runInContext('businessLoadYearMonth=yearLoader',f.ctx);
 await f.window.renderBusinessDashboard();assert.match(f.el('businessValueLabel').textContent,/2026/);
 await f.window.shiftBusinessDashboardSelection(-1);assert.match(f.el('businessDayDate').innerHTML,/2025/);assert.match(f.el('businessValueLabel').textContent,/2025/);
 assert.equal(JSON.parse(f.storage.get('milioner_business_dashboard_v1')).yearDate,'2025-01-01');
 await f.window.shiftBusinessDashboardSelection(-1);assert.equal(f.el('businessDayPrevious').disabled,true);
 await f.window.setBusinessDashboardPeriod('year');assert.match(f.el('businessDayDate').innerHTML,/2026/);assert.equal(f.el('businessDayNext').disabled,true);
});
test('year loader reuses ready daily data without a year-sized order or finance request',async()=>{
 const f=fixture(),bounds={start:Date.parse('2026-09-01T00:00:00+05:00'),end:Date.parse('2026-10-01T00:00:00+05:00')};
 f.window.loadBusinessMarketplaceDaily=()=>assert.fail('cached daily basis should be reused');
 for(let t=bounds.start;t<bounds.end;t+=DAY){const d=f.api.businessMakeDay(t,[],{revenue:10,qty:1,profit:2});f.api.businessDays.set(t,{data:d,at:NOW});}
 const out=await f.api.businessLoadYearMonth(bounds,false);assert.equal(out.month.summary.revenue,300);assert.equal(out.month.orders.amount,0);
});

test('February 29 aligns to February 28 at the same Almaty time in the previous year',async()=>{
 const f=fixture();f.setNow(Date.parse('2024-02-29T13:13:00+05:00'));
 const bounds={start:Date.parse('2023-02-01T00:00:00+05:00'),end:Date.parse('2023-03-01T00:00:00+05:00')};
 f.window.loadBusinessMarketplaceDaily=()=>assert.fail('use prepared days');
 for(let t=bounds.start;t<bounds.end;t+=DAY)f.api.businessDays.set(t,{data:f.api.businessMakeDay(t,[],{revenue:10,qty:1,profit:2}),at:Date.parse('2024-02-29T13:13:00+05:00')});
 const out=await f.api.businessLoadYearMonth(bounds,false);
 assert.equal(out.samePoint.comparisonCutoff,Date.parse('2023-02-28T13:13:00+05:00'));
 assert.ok(out.samePoint.summary.revenue<=out.month.summary.revenue);
});
test('leaving the year view cancels remaining month reads and cannot paint late results',async()=>{
 const f=fixture();let calls=0;
 await assert.rejects(f.api.businessBuildYearModel(false,0,async b=>{
  calls++;f.window.setBusinessDashboardPeriod('day');return loader(b);
 }),/Выбран другой период/);
 assert.equal(calls,1);assert.doesNotMatch(f.el('businessPeriodTitle').textContent,/Год/);
});
