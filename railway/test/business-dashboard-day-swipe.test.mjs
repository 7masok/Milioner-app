import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../../business-dashboard-v1.js',import.meta.url),'utf8');
const today=Date.parse('2026-10-08T00:00:00+05:00');
const stamp=(offset,hour=12)=>today+offset*86400000+hour*3600000;
function fixture(saved={},loader=null){
 let now=today+20*60000;
 class Clock extends Date{constructor(...args){super(...(args.length?args:[now]))}static now(){return now}}
 const elements=new Map(),storage=new Map([['milioner_business_dashboard_v1',JSON.stringify(saved)]]),requests=[];
 function element(id){if(!elements.has(id))elements.set(id,{id,innerHTML:'',textContent:'',dataset:{},classList:{contains:()=>true,toggle(){}},listeners:new Map(),setAttribute(name,value){this[name]=value},addEventListener(type,handler){this.listeners.set(type,handler)}});return elements.get(id)}
 for(const id of ['reports','businessDashboard','businessChart','businessPeriodTitle','businessPeriodSub','businessDayNav','businessDayDate','businessDayPrevious','businessDayNext','businessValueMetric','businessValueLabel','businessValue','businessValueMeta','businessYesterdayLabel','businessYesterdayValue','businessYesterdayMeta','businessYesterdayCompare'])element(id);
 const state={kaspiOrderFeed:[],wbOrderFeed:[],ozonOrderFeed:[]},sales=[];
 for(let offset=-50;offset<=0;offset++){
  const amount=offset<-8?500-offset*10:1000+offset*100,creationDate=offset===0?stamp(0,0)+5*60000:stamp(offset);
  state.kaspiOrderFeed.push({market:'Kaspi',creationDate,status:'NEW',lines:[{qty:2,totalPrice:amount,productId:'p'}]});
  sales.push({channel:'Kaspi',date:creationDate,qty:2,price:amount/2,cost:10,fee:0});
 }
 const window={allMarketUnitProfit30:new Map([['p',{qty:10,unitProfit:40}]]),loadBusinessMarketplaceSummary:async(days,options)=>{
  requests.push({days,...options});if(loader)return loader(days,options);
  const start=options.range?Date.parse(options.range.from+'T00:00:00+05:00'):days===-1?today-86400000:today;
  const revenue=1000+Math.round((start-today)/86400000)*100;
  return {revenue,qty:2,profit:80,sources:{Kaspi:{revenue,profit:80}}};
 }};
 const ctx={window,Date:Clock,Intl,Map,Set,console,state,financialSales:()=>sales,groupMarketplaceOrders:rows=>rows,marketplaceLifecycleStage:()=>'',MILLIONER_API:'https://fixture.invalid',apiJson:async url=>{requests.push({orderHistoryUrl:url});return {ok:true,orders:state.kaspiOrderFeed.map((row,i)=>({...row,entryId:String(i),orderId:String(i)}))}},fmt:n=>String(n)+' ₸',localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},document:{readyState:'loading',getElementById:id=>elements.get(id)||null,querySelectorAll:()=>[],addEventListener(){}},setTimeout() {}};
 vm.createContext(ctx);
 vm.runInContext(source.replace(/\}\)\(\);\s*$/, "window.testApi={businessDayBounds,businessSelectedDayOffset,businessWeekBounds,businessSelectedWeekOffset,businessMonthBounds,businessSelectedMonthOffset,businessBuildModel,businessInstallDaySwipe,businessModels,businessPaintTabs,businessRememberModel,businessModelMeta};})();"),ctx);
 const chart=element('businessChart');window.testApi.businessInstallDaySwipe();
 const touch=(x,y,id=1)=>({clientX:x,clientY:y,identifier:id});
 function event(type,touches,changedTouches=[]){let prevented=false;chart.listeners.get(type)({touches,changedTouches,cancelable:true,preventDefault(){prevented=true}});return prevented}
 function swipe(dx,dy=0){event('touchstart',[touch(100,100)]);const prevented=event('touchmove',[touch(100+dx,100+dy)]);event('touchend',[],[touch(100+dx,100+dy)]);return prevented}
 return {ctx,window,state,sales,requests,element,storage,event,touch,swipe,api:window.testApi,setNow:value=>{now=value}};
}
const flush=async()=>{for(let i=0;i<40;i++)await Promise.resolve()};

test('day navigation uses Almaty dates and restores an absolute saved date across midnight',async()=>{
 const f=fixture({dayDate:'2026-10-06',metric:'buyouts'});
 assert.equal(f.api.businessDayBounds(0).start,today);
 assert.equal(f.api.businessSelectedDayOffset(),-2);
 await f.window.renderBusinessDashboard();
 assert.match(f.element('businessValueLabel').textContent,/6 окт.*весь день/);
 assert.equal(f.element('businessValue').textContent,'800 ₸');
 f.setNow(today+86400000+20*60000);assert.equal(f.api.businessSelectedDayOffset(),-3);
 const future=fixture({dayDate:'2099-01-01'});assert.equal(future.api.businessSelectedDayOffset(),0);
 const invalid=fixture({dayDate:'broken'});assert.equal(invalid.api.businessSelectedDayOffset(),0);
});

test('historical snapshots request exact days and compare complete days; today retains same-time comparison',async()=>{
 const f=fixture();const original=JSON.stringify(f.state);
 await f.window.renderBusinessDashboard();
 assert.match(f.element('businessYesterdayCompare').innerHTML,/вчера до 00:20/);
 assert.equal(f.element('businessValue').textContent,'1000 ₸');
 await f.window.shiftBusinessDashboardDay(-1);
 assert.equal(f.element('businessValue').textContent,'900 ₸');
 assert.equal(f.element('businessYesterdayValue').textContent,'800 ₸');
 assert.match(f.element('businessYesterdayCompare').innerHTML,/100 ₸.*6 окт.*весь день/);
 assert.match(f.element('businessChart').innerHTML,/7 окт/);assert.doesNotMatch(f.element('businessChart').innerHTML,/сегодня|вчера/);
 await f.window.shiftBusinessDashboardDay(-1);
 assert.equal(f.element('businessValue').textContent,'800 ₸');assert.equal(f.element('businessYesterdayValue').textContent,'700 ₸');
 assert.ok(f.requests.some(r=>r.range?.from==='2026-10-06'&&r.range.to==='2026-10-06'));
 assert.ok(f.requests.some(r=>r.range?.from==='2026-10-05'&&r.range.to==='2026-10-05'));
 assert.equal(JSON.stringify(f.state),original);
 f.window.setBusinessDashboardMetric('orderProfit');assert.equal(f.element('businessValue').textContent,'80 ₸');
 await f.window.setBusinessDashboardPeriod('day');assert.match(f.element('businessValueLabel').textContent,/8 окт.*сегодня/);
 assert.equal(JSON.parse(f.storage.get('milioner_business_dashboard_v1')).metric,'orderProfit');
});

test('horizontal swipes change days while scroll, tap, cancellation and multiple touches do not',async()=>{
 const f=fixture();await f.window.renderBusinessDashboard();
 assert.equal(f.swipe(80),true);await flush();assert.equal(f.api.businessSelectedDayOffset(),-1);
 assert.equal(f.swipe(10),false);assert.equal(f.api.businessSelectedDayOffset(),-1);
 assert.equal(f.swipe(60,100),false);assert.equal(f.api.businessSelectedDayOffset(),-1);
 f.event('touchstart',[f.touch(0,0)]);f.event('touchmove',[f.touch(1,30)]);f.event('touchend',[],[f.touch(100,30)]);assert.equal(f.api.businessSelectedDayOffset(),-1);
 f.event('touchstart',[f.touch(0,0)]);f.event('touchcancel',[]);f.event('touchend',[],[f.touch(100,0)]);assert.equal(f.api.businessSelectedDayOffset(),-1);
 f.event('touchstart',[f.touch(0,0)]);f.event('touchmove',[f.touch(50,0),f.touch(0,0,2)]);f.event('touchend',[],[f.touch(100,0)]);assert.equal(f.api.businessSelectedDayOffset(),-1);
 f.swipe(-80);await flush();assert.equal(f.api.businessSelectedDayOffset(),0);
 f.swipe(-80);assert.equal(f.api.businessSelectedDayOffset(),0);
 for(let i=0;i<9;i++)await f.window.shiftBusinessDashboardDay(-1);
 assert.equal(f.api.businessSelectedDayOffset(),-7);assert.equal(f.element('businessDayPrevious').disabled,true);
});

test('a late response cannot replace a cached selected day or another period',async()=>{
 const deferred=[];let block=false;
 const f=fixture({},async(days,{range})=>{
  if(block)await new Promise(resolve=>deferred.push(resolve));
  const start=range?Date.parse(range.from+'T00:00:00+05:00'):days===-1?today-86400000:today;
  const revenue=1000+Math.round((start-today)/86400000)*100;
  return {revenue,qty:2,profit:80,sources:{Kaspi:{revenue,profit:80}}};
 });
 await f.window.renderBusinessDashboard();await f.window.shiftBusinessDashboardDay(-1);
 block=true;const pending=f.window.shiftBusinessDashboardDay(-1);await flush();
 await f.window.setBusinessDashboardPeriod('day');assert.match(f.element('businessValueLabel').textContent,/сегодня/);
 for(const resolve of deferred.splice(0))resolve();await pending;
 assert.match(f.element('businessValueLabel').textContent,/сегодня/);assert.equal(f.element('businessValue').textContent,'1000 ₸');
 block=false;await f.window.setBusinessDashboardPeriod('week');const week=f.element('businessValueLabel').textContent;
 await f.window.setBusinessDashboardPeriod('month');assert.equal(f.element('businessDayNav').hidden,false);f.swipe(80);await flush();assert.equal(f.element('businessDayNav').hidden,false);
 await f.window.setBusinessDashboardPeriod('month');assert.equal(f.element('businessDayNav').hidden,false);f.swipe(80);await flush();assert.equal(f.element('businessDayNav').hidden,false);
});

test('changing the metric while a day loads never paints the previous day',async()=>{
 const deferred=[];let block=false;
 const f=fixture({},async()=>{if(block)await new Promise(resolve=>deferred.push(resolve));return {revenue:100,qty:2,profit:80,sources:{Kaspi:{revenue:100,profit:80}}}});
 await f.window.renderBusinessDashboard();block=true;const pending=f.window.shiftBusinessDashboardDay(-1);await flush();
 f.window.setBusinessDashboardMetric('buyouts');await flush();assert.equal(f.element('businessValue').textContent,'…');
 for(const resolve of deferred.splice(0))resolve();await pending;await flush();
 assert.match(f.element('businessValueLabel').textContent,/7 окт.*весь день/);assert.equal(f.element('businessValueMetric').textContent,'Выкупы');
});

test('weekly swipes navigate five full weeks with exact histories and matching dates, totals and legends',async()=>{
 let f;
 f=fixture({period:'week'},async(days,{range})=>{
  const start=range?Date.parse(range.from+'T00:00:00+05:00'):days===-1?today-86400000:today;
  const end=range?Date.parse(range.to+'T00:00:00+05:00')+86400000:start+86400000;
  const sales=f.sales.filter(row=>row.date>=start&&row.date<end),revenue=sales.reduce((sum,row)=>sum+row.qty*row.price,0);
  return {revenue,qty:sales.length*2,profit:sales.length*80,sources:{Kaspi:{revenue,profit:sales.length*80}}};
 });
 const unchanged=JSON.stringify(f.state);
 await f.window.renderBusinessDashboard();
 assert.match(f.element('businessYesterdayCompare').innerHTML,/прошлая до Чт 00:20/);
 assert.equal(f.api.businessWeekBounds(0).start,Date.parse('2026-10-05T00:00:00+05:00'));
 f.swipe(80);await flush();
 assert.equal(f.api.businessSelectedWeekOffset(),-1);assert.equal(f.element('businessDayNav').hidden,false);
 assert.match(f.element('businessValueLabel').textContent,/28 сент.*4 окт.*вся неделя/);
 assert.match(f.element('businessYesterdayCompare').innerHTML,/21 сент.*27 сент.*вся неделя/);
 assert.doesNotMatch(f.element('businessYesterdayCompare').innerHTML,/прошлая до/);
 assert.match(f.element('businessChart').innerHTML,/28 сент.*4 окт/);
 const expected=(offset)=>{const b=f.api.businessWeekBounds(offset);return f.state.kaspiOrderFeed.filter(row=>row.creationDate>=b.start&&row.creationDate<b.end).reduce((sum,row)=>sum+row.lines[0].totalPrice,0)};
 assert.equal(f.element('businessValue').textContent,expected(-1)+' ₸');
 assert.equal(f.element('businessYesterdayValue').textContent,expected(-2)+' ₸');
 for(let i=0;i<4;i++)await f.window.shiftBusinessDashboardWeek(-1);
 assert.equal(f.api.businessSelectedWeekOffset(),-5);
 assert.equal(f.element('businessValue').textContent,expected(-5)+' ₸');assert.equal(f.element('businessYesterdayValue').textContent,expected(-6)+' ₸');
 assert.equal(f.element('businessDayPrevious').disabled,true);await f.window.shiftBusinessDashboardWeek(-1);assert.equal(f.api.businessSelectedWeekOffset(),-5);
 const oldest=f.api.businessWeekBounds(-6).start;
 assert.ok(f.requests.some(row=>row.orderHistoryUrl?.endsWith('after='+oldest)));
 assert.ok(f.requests.some(row=>row.range?.from==='2026-08-24'&&row.range.to==='2026-08-30'));
 f.window.setBusinessDashboardMetric('buyouts');assert.equal(f.element('businessValue').textContent,expected(-5)+' ₸');
 await f.window.setBusinessDashboardPeriod('week');assert.equal(f.api.businessSelectedWeekOffset(),0);assert.match(f.element('businessValueLabel').textContent,/эта неделя/);
 f.swipe(-80);assert.equal(f.api.businessSelectedWeekOffset(),0);assert.equal(JSON.stringify(f.state),unchanged);
});

test('saved week retains its Monday across week/year boundaries and vertical gestures do not navigate',async()=>{
 const f=fixture({period:'week',weekDate:'2026-09-28'});await f.window.renderBusinessDashboard();
 assert.equal(f.api.businessSelectedWeekOffset(),-1);f.swipe(60,100);assert.equal(f.api.businessSelectedWeekOffset(),-1);
 await f.window.shiftBusinessDashboardWeek(-1);const saved=JSON.parse(f.storage.get('milioner_business_dashboard_v1'));assert.equal(saved.weekDate,'2026-09-21');
 const reload=fixture(saved);assert.equal(reload.api.businessSelectedWeekOffset(),-2);
 reload.setNow(Date.parse('2026-10-12T00:01:00+05:00'));assert.equal(reload.api.businessSelectedWeekOffset(),-3);
 reload.setNow(Date.parse('2027-01-01T00:01:00+05:00'));assert.equal(reload.api.businessWeekBounds(0).start,Date.parse('2026-12-28T00:00:00+05:00'));assert.equal(reload.api.businessSelectedWeekOffset(),-5);
});

test('late weekly history cannot replace the current week, and incomplete history is not shown as zero',async()=>{
 const f=fixture({period:'week'});await f.window.renderBusinessDashboard();const current=f.element('businessValue').textContent;
 let resolve;f.ctx.apiJson=()=>new Promise(done=>{resolve=done});const pending=f.window.shiftBusinessDashboardWeek(-1);await flush();
 await f.window.setBusinessDashboardPeriod('week');resolve({ok:true,orders:[]});await pending;assert.equal(f.element('businessValue').textContent,current);assert.match(f.element('businessValueLabel').textContent,/эта неделя/);
 const missing=fixture({period:'week'});missing.window.ozonFboOrderHistoryCovers=()=>false;await missing.window.shiftBusinessDashboardWeek(-1);assert.match(missing.element('businessValueLabel').textContent,/История Ozon.*загружается/);assert.equal(missing.element('businessValue').textContent,'—');assert.equal(missing.element('businessChart').innerHTML,'');
 const truncated=fixture({period:'week'});truncated.ctx.apiJson=async()=>({ok:true,orders:Array(15000).fill({})});await truncated.window.shiftBusinessDashboardWeek(-1);assert.equal(truncated.element('businessValue').textContent,'—');assert.equal(truncated.element('businessChart').innerHTML,'');
});

test('monthly swipes use full historical calendar months, correct comparison dates and three-month navigation',async()=>{
 const f=fixture({period:'month'});
 for(let offset=-180;offset<-50;offset++){const creationDate=stamp(offset),amount=500-offset*10;f.state.kaspiOrderFeed.push({market:'Kaspi',creationDate,status:'NEW',lines:[{qty:2,totalPrice:amount,productId:'p'}]})}
 await f.window.renderBusinessDashboard();assert.equal(f.element('businessDayNav').hidden,false);assert.equal(f.element('businessDayPrevious')['aria-label'],'Предыдущий месяц');
 f.swipe(80);await flush();assert.equal(f.api.businessSelectedMonthOffset(),-1);assert.match(f.element('businessValueLabel').textContent,/1 сент.*30 сент.*весь месяц/);assert.match(f.element('businessYesterdayCompare').innerHTML,/1 авг.*31 авг.*весь месяц/);assert.doesNotMatch(f.element('businessYesterdayCompare').innerHTML,/прошлый до/);assert.match(f.element('businessChart').innerHTML,/grid-template-columns:repeat\(31/);
 const b=f.api.businessMonthBounds(-1),total=f.state.kaspiOrderFeed.filter(r=>r.creationDate>=b.start&&r.creationDate<b.end).reduce((sum,r)=>sum+r.lines[0].totalPrice,0);assert.equal(f.element('businessValue').textContent,total+' ₸');
 assert.ok(f.requests.some(r=>r.orderHistoryUrl?.includes('before='+f.api.businessMonthBounds(-1).end)));
 f.swipe(60,100);assert.equal(f.api.businessSelectedMonthOffset(),-1);
 await f.window.shiftBusinessDashboardMonth(-1);await f.window.shiftBusinessDashboardMonth(-1);assert.equal(f.api.businessSelectedMonthOffset(),-3);assert.equal(f.element('businessDayPrevious').disabled,true);
 await f.window.setBusinessDashboardPeriod('month');assert.equal(f.api.businessSelectedMonthOffset(),0);assert.equal(f.element('businessDayNext').disabled,true);
});
test('month selections persist across years; Almaty boundaries and leap February are independent of browser timezone',async()=>{
 const f=fixture({period:'month',monthDate:'2026-09-01'});assert.equal(f.api.businessSelectedMonthOffset(),-1);assert.equal(f.api.businessMonthBounds(0).start,Date.parse('2026-10-01T00:00:00+05:00'));
 await f.window.shiftBusinessDashboardMonth(-1);assert.equal(JSON.parse(f.storage.get('milioner_business_dashboard_v1')).monthDate,'2026-08-01');
 f.setNow(Date.parse('2027-01-01T00:01:00+05:00'));assert.equal(f.api.businessMonthBounds(-1).start,Date.parse('2026-12-01T00:00:00+05:00'));
 f.setNow(Date.parse('2028-03-01T00:01:00+05:00'));assert.equal(f.api.businessMonthBounds(-1).days,29);assert.equal(f.api.businessMonthBounds(-1).end,Date.parse('2028-03-01T00:00:00+05:00'));
});
test('saved local snapshots paint synchronously after reload and survive an offline refresh',async()=>{
 const f=fixture({metric:'buyouts'});await f.window.renderBusinessDashboard();const saved=f.storage.get('milioner_business_snapshots_calendar_v1');assert.ok(saved);
 const reload=fixture({metric:'buyouts'},async()=>{throw Error('offline')});reload.storage.set('milioner_business_snapshots_calendar_v1',saved);reload.element('businessCacheStatus');reload.ctx.fetch=async()=>{throw Error('offline')};
 const pending=reload.window.renderBusinessDashboard();assert.equal(reload.element('businessValue').textContent,'1000 ₸');assert.match(reload.element('businessCacheStatus').textContent,/обновляю/);
 await pending;assert.equal(reload.element('businessValue').textContent,'1000 ₸');assert.match(reload.element('businessCacheStatus').textContent,/не удалось обновить/);
});
test('a fresh server snapshot skips marketplace summaries; stale snapshots stay visible while one shared rebuild runs',async()=>{
 const seed=fixture({metric:'buyouts'});await seed.window.renderBusinessDashboard();const snapshot=seed.api.businessModels.values().next().value;
 const ready=fixture({metric:'buyouts'},async()=>{throw Error('Should not recalculate a ready server snapshot')});let gets=0;
 ready.ctx.fetch=async()=>{gets++;return{ok:true,json:async()=>({ok:true,version:'calendar-v1',sourceRevision:'a'.repeat(64),snapshot,generatedAt:stamp(0,0),stale:false})}};
 await ready.window.renderBusinessDashboard();assert.equal(gets,1);assert.equal(ready.requests.length,0);assert.equal(ready.element('businessValue').textContent,'1000 ₸');
 const finish=[];let calculated=0,reads=0,writes=0;const stale=fixture({metric:'buyouts'},async()=>{calculated++;await new Promise(resolve=>finish.push(resolve));return{revenue:1200,qty:2,profit:null,sources:{Kaspi:{revenue:1200,profit:null}}}});
 stale.ctx.fetch=async(_url,options)=>{if(options?.method==='PUT'){writes++;return{ok:true}}reads++;return{ok:true,json:async()=>({ok:true,version:'calendar-v1',sourceRevision:'b'.repeat(64),snapshot,generatedAt:stamp(0,0),stale:true})}};
 const first=stale.window.renderBusinessDashboard(),second=stale.window.renderBusinessDashboard();await flush();assert.equal(stale.element('businessValue').textContent,'1000 ₸');assert.equal(reads,1);assert.equal(calculated,2);
 for(const resolve of finish.splice(0))resolve();await Promise.all([first,second]);assert.equal(stale.element('businessValue').textContent,'1200 ₸');assert.equal(writes,1);
});
test('a late month response cannot replace a subsequently selected cached day',async()=>{
 const f=fixture();await f.window.renderBusinessDashboard();await f.window.setBusinessDashboardPeriod('month');let finish;f.ctx.apiJson=()=>new Promise(resolve=>{finish=resolve});const pending=f.window.shiftBusinessDashboardMonth(-1);await flush();await f.window.setBusinessDashboardPeriod('day');assert.match(f.element('businessValueLabel').textContent,/сегодня/);finish({ok:true,orders:[]});await pending;assert.match(f.element('businessValueLabel').textContent,/сегодня/);
});
test('a historical month before the saved Kaspi/WB archive is never reported as empty',async()=>{
 const f=fixture({period:'month'});f.ctx.apiJson=async()=>({ok:true,orders:[],historyCoverage:[{market:'WB',from:Date.parse('2026-09-01T00:00:00+05:00')}]});await f.window.shiftBusinessDashboardMonth(-1);assert.match(f.element('businessValueLabel').textContent,/Нет полной истории WB1/);assert.equal(f.element('businessValue').textContent,'—');assert.equal(f.element('businessChart').innerHTML,'');
});
test('a partial historical Ozon finance window stays marked in cached totals and cannot create a false growth percentage',async()=>{
 const f=fixture({period:'month',metric:'buyouts'});f.window.ozonFboFinanceHistoryCovers=()=>false;await f.window.renderBusinessDashboard();assert.match(f.element('businessValueMeta').textContent,/неполная история Ozon/);assert.match(f.element('businessValue').textContent,/≈/);assert.doesNotMatch(f.element('businessYesterdayCompare').innerHTML,/%/);
 const saved=JSON.parse(f.storage.get('milioner_business_snapshots_calendar_v1'));assert.equal(saved.entries[0][1].model.summary.partialOzonHistory,true);
 f.window.setBusinessDashboardMetric('orders');assert.doesNotMatch(f.element('businessValueMeta').textContent,/неполная история/);
});
