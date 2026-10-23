import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {fetchFinanceHistory} from '../src/ozon-fbo.js';
import {reusableBusinessSnapshot} from '../src/business-dashboard-cache.js';
const DAY=86400000,NOW=Date.parse('2026-10-23T12:00:00+05:00'),TODAY=Date.parse('2026-10-23T00:00:00+05:00');
const source=readFileSync(new URL('../../business-dashboard-v1.js',import.meta.url),'utf8');
function fixture({saved=new Map(),remote=new Map(),starts={},now=NOW}={}){
 class Clock extends Date{constructor(...args){super(...(args.length?args:[now]))}static now(){return now}}
 const elements=new Map(),calls=[],timers=[],state={settings:{reportMarket:'Ozon',reportStoreStarts:starts},ozonOrderFeed:[]};
 for(let t=TODAY-364*DAY;t<=TODAY;t+=DAY)state.ozonOrderFeed.push({market:'Ozon',creationDate:t+3600000,status:'delivered',lines:[{productId:'p',qty:1,totalPrice:10}]});
 const el=id=>{if(!elements.has(id))elements.set(id,{id,textContent:'',innerHTML:'',dataset:{},classList:{contains:()=>true,toggle(){}},setAttribute(){},addEventListener(){}});return elements.get(id)};
 for(const id of ['reports','businessDashboard','businessChart','businessPeriodTitle','businessPeriodSub','businessDayNav','businessDayDate','businessDayPrevious','businessDayNext','businessValueMetric','businessValueLabel','businessValue','businessValueMeta','businessYesterdayLabel','businessYesterdayValue','businessYesterdayMeta','businessYesterdayCompare','businessCacheStatus'])el(id);
 const window={allMarketUnitProfit30:new Map(),setTimeout(fn,delay=0){if(delay>=1000){timers.push(fn);return 1}fn();return 0},clearTimeout(){},ozonFboOrderHistoryCovers:()=>true,ozonFboRefreshStatus:async()=>{},loadBusinessMarketplaceDaily:async range=>{calls.push({finance:range});const out=[];for(let t=Date.parse(range.from+'T00:00:00+05:00');t<=Date.parse(range.to+'T00:00:00+05:00');t+=DAY)out.push({day:new Clock(t+18000000).toISOString().slice(0,10),summary:{revenue:5,qty:1,profit:2,sources:{Ozon:{revenue:5,qty:1,profit:2}}}});return out}};
 const fetch=async(url,options)=>{const u=new URL(url);calls.push({url:u.pathname,method:options?.method||'GET'});if(options?.method==='PUT'){const body=JSON.parse(options.body);for(const day of body.days||[])remote.set(day.bounds.start,{day,generatedAt:now,fresh:true});return{ok:true}}return{ok:true,json:async()=>u.pathname.endsWith('-days')?{ok:true,version:'calendar-v2',sourceRevision:'a'.repeat(64),days:[...remote.values()].filter(r=>r.day.bounds.start>=Number(u.searchParams.get('from'))&&r.day.bounds.start<Number(u.searchParams.get('to'))).map(r=>({...r,fresh:now-r.generatedAt<60000}))}:{ok:true,version:'calendar-v2',sourceRevision:'a'.repeat(64),snapshot:null,months:[]}}};
 const ctx={window,state,Date:Clock,Intl,console:{warn(){}},fetch,MILLIONER_API:'https://fixture.invalid',groupMarketplaceOrders:rows=>rows,marketplaceLifecycleStage:()=>'',financialSales:()=>[],apiJson:async()=>assert.fail('Ozon does not load another store'),fmt:n=>n+' ₸',setTimeout:fn=>fn(),localStorage:{getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v),removeItem:k=>saved.delete(k)},document:{readyState:'loading',getElementById:id=>elements.get(id)||null,querySelectorAll:()=>[],addEventListener(){}}};
 vm.createContext(ctx);vm.runInContext(source.replace(/\}\)\(\);\s*$/,'window.api={businessStartAnnualWarm,businessModelFromDays,businessSyncMarket,businessDays,businessDaysBounds,businessModelKey,businessClosedReady,businessScopeMatches,businessPaint,businessPackDay,businessUnpackDay};})();'),ctx);window.api.businessSyncMarket();
 return{ctx,window,api:window.api,calls,remote,saved,el,state};
}
test('one annual preparation persists 365 individual days, then week/month/year use their exact sums',async()=>{
 const f=fixture();await f.api.businessStartAnnualWarm();assert.equal(f.remote.size,365);assert.equal(f.api.businessDays.size,365);
 assert.ok(f.calls.filter(c=>c.finance).every(c=>Date.parse(c.finance.to)-Date.parse(c.finance.from)<=27*DAY));
 const week=f.api.businessModelFromDays('week',-1),month=f.api.businessModelFromDays('month',-1),year=f.api.businessModelFromDays('year',0),before=f.calls.length;
 assert.equal(week.summary.revenue,35);assert.equal(week.orders.amount,70);assert.equal(month.summary.revenue,150);assert.equal(month.orders.amount,300);assert.equal(year.orders.amount,2960);assert.equal(year.summary.revenue,1480);assert.equal(f.calls.length,before);
 const reloaded=fixture({saved:f.saved,remote:f.remote});await reloaded.api.businessStartAnnualWarm();assert.equal(reloaded.calls.filter(c=>c.finance).length,0);assert.equal(reloaded.api.businessModelFromDays('month',-1).summary.revenue,150);
});
test('after TTL and a reload, only recent unsettled days are refreshed rather than the archived year',async()=>{
 const f=fixture();await f.api.businessStartAnnualWarm();const later=fixture({saved:f.saved,remote:f.remote,now:NOW+2*3600000});await later.api.businessStartAnnualWarm();const reads=later.calls.filter(c=>c.finance);assert.equal(reads.length,1);assert.equal(reads[0].finance.from,'2026-10-21');assert.equal(reads[0].finance.to,'2026-10-23');
});
test('a confirmed opening in March 2025 gives an immediate 2024 zero with no network or finance requests',async()=>{
 const f=fixture({starts:{Ozon:'2025-03-01'}});f.saved.set('milioner_business_dashboard_v1',JSON.stringify({period:'year',yearDate:'2024-01-01'}));
 // Selection is loaded at script initialization.
 const g=fixture({saved:f.saved,starts:{Ozon:'2025-03-01'}});await g.window.renderBusinessDashboard();assert.equal(g.el('businessValue').textContent,'0 ₸');assert.match(g.el('businessValueMeta').textContent,/ещё не работал/);assert.equal(g.calls.length,0);
 assert.equal(f.api.businessModelFromDays('month',-20).beforeOpening,true);
});
test('an unconfirmed old year reads saved aggregates but starts no raw history calculation',async()=>{
 const saved=new Map([['milioner_business_dashboard_v1',JSON.stringify({period:'year',yearDate:'2024-01-01'})]]),f=fixture({saved});await f.window.renderBusinessDashboard();assert.equal(f.calls.filter(c=>c.finance).length,0);assert.equal(f.el('businessValue').textContent,'—');assert.match(f.el('businessCacheStatus').textContent,/нет сохранённой истории/);assert.ok(f.calls.every(c=>c.url?.includes('business-dashboard')));
});
test('a Kaspi warning cannot enter an Ozon snapshot, and changing the confirmed opening invalidates zero snapshots',()=>{
 const f=fixture(),bounds={start:TODAY-DAY,end:TODAY};assert.equal(f.api.businessScopeMatches({ordersPartialMarkets:['Kaspi']}),false);assert.equal(f.api.businessScopeMatches({market:'Kaspi'}),false);assert.equal(f.api.businessScopeMatches({market:'Ozon',storeStarts:'{"Ozon":"2025-03-01"}'}),false);assert.equal(f.api.businessScopeMatches({market:'Ozon',summary:{sources:{Ozon:{}}}}),true);
 assert.equal(reusableBusinessSnapshot({bounds,pending:false,summary:{}},NOW,NOW),false);const old={bounds:{start:TODAY-20*DAY,end:TODAY-19*DAY},summary:{profit:null}};assert.equal(reusableBusinessSnapshot(old,NOW,NOW+30*DAY),true);assert.equal(reusableBusinessSnapshot({...old,summary:{missingMarkets:['Ozon']}},NOW,NOW+30*DAY),false);
});
const utcDay=n=>new Date(Date.UTC(2026,9,23)-n*DAY).toISOString();
const almatyDay=n=>new Date(Date.parse(utcDay(n))-18000000).toISOString();
const operation=(day,amount=5)=>({operation_id:day,operation_date:day.slice(0,10)+'T12:00:00Z',amount});
test('Ozon financial backfill survives restarts, retains old days, and replaces corrected recent days once',async()=>{
 const calls=[],read=async(_,from,to)=>{calls.push([from,to]);const rows=[];for(let t=Date.parse(from);t<=Date.parse(to);t+=DAY)rows.push(operation(new Date(t).toISOString()));return rows};
 let result=await fetchFinanceHistory({},utcDay(0),{},read);assert.equal(result.rows.length,10);assert.equal(result.from,almatyDay(9));assert.equal(calls.length,2);
 for(let i=0;i<60&&result.from>almatyDay(364);i++)result=await fetchFinanceHistory({},utcDay(0),JSON.parse(JSON.stringify(result)),read,{archiveOnly:true});
 assert.equal(result.from,almatyDay(364));assert.equal(result.rows.length,365);const oldCalls=calls.length;await fetchFinanceHistory({},utcDay(0),result,read,{archiveOnly:true});assert.equal(calls.length,oldCalls);
 const updated=await fetchFinanceHistory({},utcDay(0),result,async(_,from,to)=>{assert.equal(from,utcDay(2));assert.equal(to,utcDay(0));return[operation(utcDay(0),9)]});assert.equal(updated.rows.length,363);assert.equal(updated.rows.find(r=>r.operation_id===utcDay(0)).amount,9);assert.ok(updated.rows.some(r=>r.operation_id===utcDay(364)));
});
test('Ozon financial failures cannot mutate saved coverage or turn missing days into zero',async()=>{
 const previous={rows:[operation(utcDay(20))],from:utcDay(30),to:utcDay(0)},before=JSON.stringify(previous);let calls=0;await assert.rejects(fetchFinanceHistory({},utcDay(0),previous,async()=>{if(++calls===2)throw Error('429');return[]}),/429/);assert.equal(JSON.stringify(previous),before);
 const opened=await fetchFinanceHistory({},utcDay(0),{},async()=>[],{start:Date.parse(utcDay(1))});assert.equal(opened.from,almatyDay(1));assert.equal(opened.targetFrom,almatyDay(1));
});

test('a long offline gap advances financial coverage in bounded seven-day windows',async()=>{
 const previous={rows:[operation(utcDay(80))],coveredFromDate:utcDay(100).slice(0,10),from:almatyDay(100),to:utcDay(60)},calls=[];
 const result=await fetchFinanceHistory({},utcDay(0),previous,async(_,from,to)=>{calls.push([from,to]);assert.ok(Date.parse(to)-Date.parse(from)<=6*DAY);return[]});
 assert.ok(Date.parse(result.to)<Date.parse(utcDay(0)));assert.ok(Date.parse(result.to)>Date.parse(previous.to));assert.ok(result.rows.some(r=>r.operation_id===utcDay(80)));assert.equal(calls.length,2);
});
