import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {reportStoreStartDate} from '../src/report-history-range.js';
import {fetchFinanceHistory} from '../src/ozon-fbo.js';
import {validBusinessDay,reusableBusinessSnapshot,composeBusinessDays} from '../src/business-dashboard-cache.js';
const DAY=86400000,NOW=Date.parse('2026-10-23T12:00:00+05:00'),TODAY=Date.parse('2026-10-23T00:00:00+05:00');
const source=readFileSync(new URL('../../business-dashboard-v1.js',import.meta.url),'utf8');
function fixture({saved=new Map(),remote=new Map(),starts={},now=NOW,market='Ozon',financeError='',writeStatus=200,historyFrom=null,storeDays=null}={}){
 class Clock extends Date{constructor(...args){super(...(args.length?args:[now]))}static now(){return now}}
 const elements=new Map(),calls=[],timers=[],state={settings:{reportMarket:market,reportStoreStarts:starts},ozonOrderFeed:[]};
 for(let t=historyFrom??TODAY-364*DAY;t<=TODAY;t+=DAY)state.ozonOrderFeed.push({market:'Ozon',creationDate:t+3600000,status:'delivered',lines:[{productId:'p',qty:1,totalPrice:10}]});
 const el=id=>{if(!elements.has(id))elements.set(id,{id,textContent:'',innerHTML:'',dataset:{},classList:{contains:()=>true,toggle(){}},setAttribute(){},addEventListener(){}});return elements.get(id)};
 for(const id of ['reports','businessDashboard','businessChart','businessPeriodTitle','businessPeriodSub','businessDayNav','businessDayDate','businessDayPrevious','businessDayNext','businessValueMetric','businessValueLabel','businessValue','businessValueMeta','businessYesterdayLabel','businessYesterdayValue','businessYesterdayMeta','businessYesterdayCompare','businessCacheStatus'])el(id);
 const window={allMarketUnitProfit30:new Map(),setTimeout(fn,delay=0){if(delay>=1000){timers.push(fn);return 1}fn();return 0},clearTimeout(){},ozonFboOrderHistoryCovers:()=>true,ozonFboRefreshStatus:async()=>{},loadBusinessMarketplaceDaily:async range=>{calls.push({finance:range});if(financeError)throw Error(financeError);const out=[];for(let t=Date.parse(range.from+'T00:00:00+05:00');t<=Date.parse(range.to+'T00:00:00+05:00');t+=DAY)out.push({day:new Clock(t+18000000).toISOString().slice(0,10),summary:{revenue:5,qty:1,profit:2,sources:{[market]:{revenue:5,qty:1,profit:2}}}});return out}};
 const fetch=async(url,options)=>{const u=new URL(url);calls.push({url:u.pathname,method:options?.method||'GET'});if(options?.method==='PUT'){const body=JSON.parse(options.body);for(const day of body.days||[])assert.equal(validBusinessDay(day),true,'actual browser payload must pass the server validator');if(writeStatus!==200)return{ok:false,status:writeStatus,json:async()=>({error:'Данные обновились во время расчёта'})};for(const day of body.days||[])remote.set(day.bounds.start,{day:JSON.parse(JSON.stringify(day)),generatedAt:now,fresh:true});return{ok:true}}return{ok:true,json:async()=>u.pathname.endsWith('-days')?{ok:true,version:'calendar-v2',sourceRevision:'a'.repeat(64),days:storeDays&&market==='all'?composeBusinessDays(storeDays,Number(u.searchParams.get('from')),Number(u.searchParams.get('to')),{settings:{reportStoreStarts:starts}},'a'.repeat(64),now):[...remote.values()].filter(r=>r.day.bounds.start>=Number(u.searchParams.get('from'))&&r.day.bounds.start<Number(u.searchParams.get('to'))).map(r=>({...r,fresh:now-r.generatedAt<60000}))}:{ok:true,version:'calendar-v2',sourceRevision:'a'.repeat(64),snapshot:null,months:[]}}};
 const ctx={window,state,Date:Clock,Intl,console:{warn(){}},fetch,MILLIONER_API:'https://fixture.invalid',groupMarketplaceOrders:rows=>rows,marketplaceLifecycleStage:()=>'',financialSales:()=>[],apiJson:async url=>{assert.notEqual(market,'Ozon');calls.push({orders:String(url)});const u=new URL(url),from=Number(u.searchParams.get('after')),to=Number(u.searchParams.get('before'));return{ok:true,orders:state.ozonOrderFeed.filter(x=>x.creationDate>=from&&x.creationDate<to).map(x=>({...x,market})),historyCoverage:[{market,from:historyFrom??TODAY-400*DAY}]}},fmt:n=>n+' ₸',setTimeout:fn=>fn(),localStorage:{getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v),removeItem:k=>saved.delete(k)},document:{readyState:'loading',getElementById:id=>elements.get(id)||null,querySelectorAll:()=>[],addEventListener(){}}};
 vm.createContext(ctx);vm.runInContext(source.replace(/\}\)\(\);\s*$/,'window.api={businessStartAnnualWarm,businessModelFromDays,businessSyncMarket,businessDays,businessDaysBounds,businessModelKey,businessClosedReady,businessScopeMatches,businessPaint,businessPackDay,businessUnpackDay,businessLoadDayBase,businessReadSavedDays,businessProgressStats};})();'),ctx);window.api.businessSyncMarket();
 return{ctx,window,api:window.api,calls,remote,saved,el,state};
}
test('one annual preparation persists 365 individual days, then week/month/year use their exact sums',async()=>{
 const f=fixture();await f.api.businessStartAnnualWarm();assert.equal(f.remote.size,365);assert.equal(f.api.businessDays.size,365);
 assert.ok(f.calls.filter(c=>c.finance).every(c=>Date.parse(c.finance.to)-Date.parse(c.finance.from)<=27*DAY));
 const week=f.api.businessModelFromDays('week',-1),month=f.api.businessModelFromDays('month',-1),year=f.api.businessModelFromDays('year',0),before=f.calls.length;
 assert.equal(week.summary.revenue,35);assert.equal(week.orders.amount,70);assert.equal(month.summary.revenue,150);assert.equal(month.orders.amount,300);assert.equal(year.orders.amount,2960);assert.equal(year.summary.revenue,1480);assert.equal(f.calls.length,before);
 const reloaded=fixture({saved:f.saved,remote:f.remote});await reloaded.api.businessStartAnnualWarm();assert.equal(reloaded.calls.filter(c=>c.finance).length,0);assert.equal(reloaded.api.businessModelFromDays('month',-1).summary.revenue,150);
});
test('All reopens a full historical year from four saved stores without reading orders or finance again',async()=>{
 const begin=Date.parse('2025-01-01T00:00:00+05:00'),end=Date.parse('2026-01-01T00:00:00+05:00'),markets=['Kaspi','WB','WB2','Ozon'],starts=Object.fromEntries(markets.map(m=>[m,'2024-01-01']));
 const storeDays=[];for(const market of markets){const f=fixture({market,starts,historyFrom:begin});await f.api.businessLoadDayBase({start:begin,end:begin+DAY});const template=JSON.parse(JSON.stringify(f.remote.get(begin).day));
  for(let t=begin;t<end;t+=DAY){const shift=t-begin,day=JSON.parse(JSON.stringify(template));day.bounds.start+=shift;day.bounds.end+=shift;for(const h of day.buckets){h.start+=shift;h.end+=shift}for(const e of day.events)e[0]+=shift;storeDays.push({cache_key:'base:'+t+':'+market,version:'calendar-v2',source_revision:'a'.repeat(64),payload:day,generated_at:NOW})}
 }
 const stale=JSON.parse(JSON.stringify(storeDays[0].payload));stale.market='all';stale.storeStarts=JSON.stringify(starts);stale.pending=true;stale.summary={revenue:null,qty:null,profit:null};stale.orders.amount=1;
 const saved=new Map([['milioner_business_dashboard_v1',JSON.stringify({period:'year',yearDate:'2025-01-01'})],['milioner_business_days_v2',JSON.stringify({version:'calendar-v2',days:[{data:stale,at:NOW+1000}]})]]);
 for(let reload=0;reload<2;reload++){const f=fixture({market:'all',starts,storeDays,saved:reload?saved:new Map(saved),now:NOW+reload*DAY});f.el('businessLoadProgress');await f.window.renderBusinessDashboard();await f.api.businessStartAnnualWarm();
  assert.equal(f.calls.filter(c=>c.orders||c.finance).length,0);assert.equal(f.calls.filter(c=>c.method==='PUT').length,0);assert.equal(f.api.businessProgressStats().ready,365);assert.equal(f.api.businessProgressStats().total,365);const year=f.api.businessModelFromDays('year',-1);assert.equal(year.orders.amount,14600);assert.equal(year.summary.revenue,7300);assert.equal(year.summary.profit,2920);assert.equal(year.knownMonths,12);assert.equal(year.yearPartial,false);
 }
});
test('after TTL and a reload, only recent unsettled days are refreshed rather than the archived year',async()=>{
 const f=fixture();await f.api.businessStartAnnualWarm();const later=fixture({saved:f.saved,remote:f.remote,now:NOW+2*3600000});await later.api.businessStartAnnualWarm();const reads=later.calls.filter(c=>c.finance);assert.equal(reads.length,1);assert.equal(reads[0].finance.from,'2026-10-21');assert.equal(reads[0].finance.to,'2026-10-23');
});
test('WB2 restores legacy saved days after another store opening changes, refreshing only unsettled dates',async()=>{
 const oldStarts={WB2:'2026-04-01',WB:'2022-01-01',Ozon:'2026-01-01'},first=fixture({market:'WB2',starts:oldStarts});await first.api.businessStartAnnualWarm();
 const expected=first.api.businessModelFromDays('year',0).orders.amount;
 // Old releases stamped every store date into each WB2 day. Reuse those
 // records without rewriting user dates or asking the provider for the year.
 for(const row of first.remote.values())row.day.storeStarts=JSON.stringify(oldStarts);
 const reloaded=fixture({market:'WB2',saved:new Map([['milioner_business_dashboard_v1',JSON.stringify({period:'year'})]]),remote:first.remote,starts:{...oldStarts,Ozon:'2025-03-01'},now:NOW+DAY});await reloaded.api.businessStartAnnualWarm();
 const reads=reloaded.calls.filter(c=>c.finance||c.orders);
 assert.ok(reads.length>0);assert.ok(reads.every(c=>c.finance?c.finance.from>='2026-10-21':Number(new URL(c.orders).searchParams.get('after'))>=TODAY-2*DAY));
 assert.equal(reloaded.api.businessModelFromDays('year',0).orders.amount,expected);
 assert.equal(reloaded.api.businessProgressStats().ready,207);assert.equal(reloaded.api.businessProgressStats().total,207);
 assert.equal(reloaded.api.businessScopeMatches({market:'WB2',storeStarts:JSON.stringify({...oldStarts,WB2:'2026-05-01'})}),false);
});
test('orders are durable before finance fails; reopening with no browser cache preserves exact days without reading orders again',async()=>{
 const bounds={start:TODAY-30*DAY,end:TODAY-28*DAY},first=fixture({market:'WB2',financeError:'Finance unavailable'});
 await assert.rejects(first.api.businessLoadDayBase(bounds),/Finance unavailable/);assert.equal(first.remote.size,2);
 const amounts=[...first.remote.values()].map(r=>r.day.orders.amount);assert.deepEqual(amounts,[10,10]);assert.ok([...first.remote.values()].every(r=>r.day.pending&&r.day.ordersReady&&r.day.summary.revenue===null));
 const reloaded=fixture({market:'WB2',remote:first.remote,now:NOW+DAY});await reloaded.api.businessLoadDayBase(bounds);
 assert.equal(reloaded.calls.filter(c=>c.orders).length,0);assert.deepEqual([...reloaded.remote.values()].map(r=>r.day.orders.amount),amounts);
 for(let t=bounds.start;t<bounds.end;t+=DAY){const day=reloaded.api.businessDays.get(t).data;assert.equal(day.summary.revenue,5);assert.equal(day.pending,false);assert.equal(day.events.length,1)}
});
test('a missing neighbour does not reload or overwrite settled order days',async()=>{
 const bounds={start:TODAY-30*DAY,end:TODAY-27*DAY},first=fixture({market:'WB2',financeError:'Finance unavailable'});
 await assert.rejects(first.api.businessLoadDayBase(bounds));first.remote.delete(bounds.start+DAY);
 const reloaded=fixture({market:'WB2',remote:first.remote});await reloaded.api.businessLoadDayBase(bounds);
 const reads=reloaded.calls.filter(c=>c.orders);assert.equal(reads.length,1);const query=new URL(reads[0].orders).searchParams;assert.equal(Number(query.get('after')),bounds.start+DAY);assert.equal(Number(query.get('before')),bounds.start+2*DAY);
 assert.equal(reloaded.api.businessModelFromDays('day',-30).orders.amount,10);
});
test('a rejected durable write is explicit and retains the unsaved days without bypassing source revision checks',async()=>{
 const bounds={start:TODAY-30*DAY,end:TODAY-28*DAY},f=fixture({market:'WB2',writeStatus:409});
 await assert.rejects(f.api.businessLoadDayBase(bounds),error=>error.businessPersistence===true&&/HTTP 409/.test(error.message));assert.equal(f.remote.size,0);assert.equal(f.api.businessDays.get(bounds.start).data.orders.amount,10);
 assert.match(f.api.businessDays.get(bounds.start).unsaved,/409/);
 const retry=fixture({market:'WB2',saved:f.saved});await retry.api.businessLoadDayBase(bounds);assert.equal(retry.calls.filter(c=>c.orders).length,0);assert.equal(retry.remote.size,2);assert.equal(retry.api.businessDays.get(bounds.start).unsaved,undefined);
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
test('selecting 2025 prepares that whole year in bounded blocks, then reopens from durable days',async()=>{
 const start=Date.parse('2025-01-01T00:00:00+05:00'),end=Date.parse('2026-01-01T00:00:00+05:00'),ui=()=>new Map([['milioner_business_dashboard_v1',JSON.stringify({period:'year',yearDate:'2025-01-01'})]]);
 const f=fixture({market:'WB',historyFrom:start,saved:new Map([['milioner_business_dashboard_v1',JSON.stringify({period:'year'})]]),starts:{WB:'2022-01-01'}});f.el('businessLoadProgress');await f.window.shiftBusinessDashboardYear(-1);await f.api.businessStartAnnualWarm();
 const stats=f.api.businessProgressStats(),year=f.api.businessModelFromDays('year',-1);assert.equal(stats.from,start);assert.equal(stats.end,end);assert.equal(stats.ready,365);assert.equal(stats.total,365);assert.equal(year.knownMonths,12);assert.equal(year.orders.amount,3650);
 assert.ok(f.calls.filter(c=>c.finance).every(c=>c.finance.from>='2025-01-01'&&c.finance.to<='2025-12-31'&&Date.parse(c.finance.to)-Date.parse(c.finance.from)<=27*DAY));
 const reload=fixture({market:'WB',historyFrom:start,remote:f.remote,saved:ui(),starts:{WB:'2022-01-01'},now:NOW+DAY});await reload.api.businessStartAnnualWarm();assert.equal(reload.calls.filter(c=>c.finance||c.orders).length,0);assert.equal(reload.api.businessProgressStats().ready,365);assert.equal(reload.api.businessModelFromDays('year',-1).orders.amount,3650);
});
test('a slow saved-day read for 2025 cannot evict the newly selected 2026 daily window',async()=>{
 const start=Date.parse('2025-01-01T00:00:00+05:00'),seed=fixture({market:'WB',historyFrom:start});await seed.api.businessLoadDayBase({start,end:start+DAY});
 const f=fixture({market:'WB',historyFrom:start,saved:new Map([['milioner_business_dashboard_v1',JSON.stringify({period:'year',yearDate:'2025-01-01'})]])}),read=f.ctx.fetch;let finish;
 f.ctx.fetch=(url,options)=>{const u=new URL(url);if(u.pathname==='/api/business-dashboard-days'&&Number(u.searchParams.get('from'))===start)return new Promise(resolve=>{finish=()=>resolve({ok:true,json:async()=>({ok:true,version:'calendar-v2',sourceRevision:'a'.repeat(64),days:[...seed.remote.values()]})})});return read(url,options)};
 const old=f.window.renderBusinessDashboard();for(let i=0;i<100&&!finish;i++)await Promise.resolve();assert.ok(finish);await f.window.setBusinessDashboardPeriod('year');
 finish();await old;assert.equal(f.api.businessDays.has(start),false);assert.match(f.el('businessDayDate').innerHTML,/2026 год/);
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

test('store opening reads the deployed TEXT warehouse payload and rejects malformed or guessed dates',()=>{
 const state={settings:{reportStoreStarts:{Ozon:'2025-03-01'}}};assert.equal(reportStoreStartDate(JSON.stringify(state),'Ozon'),'2025-03-01');assert.equal(reportStoreStartDate(state,'Ozon'),'2025-03-01');assert.equal(reportStoreStartDate(JSON.stringify(state),'Kaspi'),'');
 for(const value of ['2025-02-30','2025-13-01','tomorrow','2099-01-01'])assert.equal(reportStoreStartDate(JSON.stringify({settings:{reportStoreStarts:{Ozon:value}}}),'Ozon'),'');
 assert.equal(reportStoreStartDate('{broken','Ozon'),'');assert.equal(reportStoreStartDate(null,'Ozon'),'');
});
