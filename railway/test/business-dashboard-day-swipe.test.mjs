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
 vm.runInContext(source.replace(/\}\)\(\);\s*$/, "window.testApi={businessDayBounds,businessSelectedDayOffset,businessWeekBounds,businessSelectedWeekOffset,businessMonthBounds,businessSelectedMonthOffset,businessBuildModel,businessInstallDaySwipe,businessModels,businessPaintTabs,businessRememberModel,businessModelMeta,businessModelFromDays,businessDays,businessAwait};})();"),ctx);
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
 assert.equal(f.api.businessSelectedDayOffset(),-9);assert.equal(f.element('businessDayPrevious').disabled,false);
 const reload=fixture(JSON.parse(f.storage.get('milioner_business_dashboard_v1')));assert.equal(reload.api.businessSelectedDayOffset(),-9);
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
 assert.equal(f.element('businessDayPrevious').disabled,false);
 const oldest=f.api.businessWeekBounds(-6).start;
 assert.ok(f.requests.some(row=>row.orderHistoryUrl?.endsWith('after='+oldest)));
 assert.ok(f.requests.some(row=>row.range?.from==='2026-08-24'&&row.range.to==='2026-08-30'));
 f.window.setBusinessDashboardMetric('buyouts');assert.equal(f.element('businessValue').textContent,expected(-5)+' ₸');
 await f.window.shiftBusinessDashboardWeek(-1);assert.equal(f.api.businessSelectedWeekOffset(),-6);assert.equal(f.element('businessDayPrevious').disabled,false);
 assert.equal(fixture(JSON.parse(f.storage.get('milioner_business_dashboard_v1'))).api.businessSelectedWeekOffset(),-6);
 await f.window.setBusinessDashboardPeriod('week');assert.equal(f.api.businessSelectedWeekOffset(),0);assert.match(f.element('businessValueLabel').textContent,/эта неделя/);
 f.swipe(-80);assert.equal(f.api.businessSelectedWeekOffset(),0);assert.equal(JSON.stringify(f.state),unchanged);
});

test('saved week retains its Monday across week/year boundaries and vertical gestures do not navigate',async()=>{
 const f=fixture({period:'week',weekDate:'2026-09-28'});await f.window.renderBusinessDashboard();
 assert.equal(f.api.businessSelectedWeekOffset(),-1);f.swipe(60,100);assert.equal(f.api.businessSelectedWeekOffset(),-1);
 await f.window.shiftBusinessDashboardWeek(-1);const saved=JSON.parse(f.storage.get('milioner_business_dashboard_v1'));assert.equal(saved.weekDate,'2026-09-21');
 const reload=fixture(saved);assert.equal(reload.api.businessSelectedWeekOffset(),-2);
 reload.setNow(Date.parse('2026-10-12T00:01:00+05:00'));assert.equal(reload.api.businessSelectedWeekOffset(),-3);
 reload.setNow(Date.parse('2027-01-01T00:01:00+05:00'));assert.equal(reload.api.businessWeekBounds(0).start,Date.parse('2026-12-28T00:00:00+05:00'));assert.equal(reload.api.businessSelectedWeekOffset(),-14);
});

test('late weekly history cannot replace the current week, and incomplete history is not shown as zero',async()=>{
 const f=fixture({period:'week'});await f.window.renderBusinessDashboard();const current=f.element('businessValue').textContent;
 let resolve;f.ctx.apiJson=()=>new Promise(done=>{resolve=done});const pending=f.window.shiftBusinessDashboardWeek(-1);await flush();
 await f.window.setBusinessDashboardPeriod('week');resolve({ok:true,orders:[]});await pending;assert.equal(f.element('businessValue').textContent,current);assert.match(f.element('businessValueLabel').textContent,/эта неделя/);
 const missing=fixture({period:'week'});missing.window.ozonFboOrderHistoryCovers=()=>false;await missing.window.shiftBusinessDashboardWeek(-1);assert.match(missing.element('businessValueLabel').textContent,/Нет полной истории Ozon/);assert.equal(missing.element('businessValue').textContent,'—');assert.equal(missing.element('businessChart').innerHTML,'');
 const truncated=fixture({period:'week'});truncated.ctx.apiJson=async()=>({ok:true,orders:Array(15000).fill({})});await truncated.window.shiftBusinessDashboardWeek(-1);assert.equal(truncated.element('businessValue').textContent,'—');assert.equal(truncated.element('businessChart').innerHTML,'');
});

test('monthly swipes use full historical calendar months, correct comparison dates and unlimited backward navigation',async()=>{
 const f=fixture({period:'month'});
 for(let offset=-180;offset<-50;offset++){const creationDate=stamp(offset),amount=500-offset*10;f.state.kaspiOrderFeed.push({market:'Kaspi',creationDate,status:'NEW',lines:[{qty:2,totalPrice:amount,productId:'p'}]})}
 await f.window.renderBusinessDashboard();assert.equal(f.element('businessDayNav').hidden,false);assert.equal(f.element('businessDayPrevious')['aria-label'],'Предыдущий месяц');
 f.swipe(80);await flush();assert.equal(f.api.businessSelectedMonthOffset(),-1);assert.match(f.element('businessValueLabel').textContent,/1 сент.*30 сент.*весь месяц/);assert.match(f.element('businessYesterdayCompare').innerHTML,/1 авг.*31 авг.*весь месяц/);assert.doesNotMatch(f.element('businessYesterdayCompare').innerHTML,/прошлый до/);assert.match(f.element('businessChart').innerHTML,/grid-template-columns:repeat\(31/);
 const b=f.api.businessMonthBounds(-1),total=f.state.kaspiOrderFeed.filter(r=>r.creationDate>=b.start&&r.creationDate<b.end).reduce((sum,r)=>sum+r.lines[0].totalPrice,0);assert.equal(f.element('businessValue').textContent,total+' ₸');
 assert.ok(f.requests.some(r=>r.orderHistoryUrl?.includes('before='+f.api.businessMonthBounds(-1).end)));
 f.swipe(60,100);assert.equal(f.api.businessSelectedMonthOffset(),-1);
 await f.window.shiftBusinessDashboardMonth(-1);await f.window.shiftBusinessDashboardMonth(-1);assert.equal(f.api.businessSelectedMonthOffset(),-3);assert.equal(f.element('businessDayPrevious').disabled,false);
 f.swipe(80);await flush();assert.equal(f.api.businessSelectedMonthOffset(),-4);
 assert.equal(fixture(JSON.parse(f.storage.get('milioner_business_dashboard_v1'))).api.businessSelectedMonthOffset(),-4);
 await f.window.setBusinessDashboardPeriod('month');assert.equal(f.api.businessSelectedMonthOffset(),0);assert.equal(f.element('businessDayNext').disabled,true);
});
test('month selections persist across years; Almaty boundaries and leap February are independent of browser timezone',async()=>{
 const f=fixture({period:'month',monthDate:'2026-09-01'});assert.equal(f.api.businessSelectedMonthOffset(),-1);assert.equal(f.api.businessMonthBounds(0).start,Date.parse('2026-10-01T00:00:00+05:00'));
 await f.window.shiftBusinessDashboardMonth(-1);assert.equal(JSON.parse(f.storage.get('milioner_business_dashboard_v1')).monthDate,'2026-08-01');
 f.setNow(Date.parse('2027-01-01T00:01:00+05:00'));assert.equal(f.api.businessMonthBounds(-1).start,Date.parse('2026-12-01T00:00:00+05:00'));
 f.setNow(Date.parse('2028-03-01T00:01:00+05:00'));assert.equal(f.api.businessMonthBounds(-1).days,29);assert.equal(f.api.businessMonthBounds(-1).end,Date.parse('2028-03-01T00:00:00+05:00'));
});
test('saved local snapshots paint synchronously after reload and survive an offline refresh',async()=>{
 const f=fixture({metric:'buyouts'});await f.window.renderBusinessDashboard();const saved=f.storage.get('milioner_business_snapshots_calendar_v2');assert.ok(saved);
 const reload=fixture({metric:'buyouts'},async()=>{throw Error('offline')});reload.storage.set('milioner_business_snapshots_calendar_v2',saved);reload.element('businessCacheStatus');reload.ctx.fetch=async()=>{throw Error('offline')};
 const pending=reload.window.renderBusinessDashboard();assert.equal(reload.element('businessValue').textContent,'1000 ₸');assert.match(reload.element('businessCacheStatus').textContent,/обновляю/);
 await pending;assert.equal(reload.element('businessValue').textContent,'1000 ₸');assert.match(reload.element('businessCacheStatus').textContent,/не удалось обновить/);
});
test('a fresh server snapshot skips marketplace summaries; stale snapshots stay visible while one shared rebuild runs',async()=>{
 const seed=fixture({metric:'buyouts'});await seed.window.renderBusinessDashboard();const snapshot=seed.api.businessModels.values().next().value;
 const ready=fixture({metric:'buyouts'},async()=>{throw Error('Should not recalculate a ready server snapshot')});let gets=0;
 ready.ctx.fetch=async()=>{gets++;return{ok:true,json:async()=>({ok:true,version:'calendar-v2',sourceRevision:'a'.repeat(64),snapshot,generatedAt:stamp(0,0),stale:false})}};
 await ready.window.renderBusinessDashboard();assert.equal(gets,1);assert.equal(ready.requests.length,0);assert.equal(ready.element('businessValue').textContent,'1000 ₸');
 const finish=[];let calculated=0,reads=0,writes=0;const stale=fixture({metric:'buyouts'},async()=>{calculated++;await new Promise(resolve=>finish.push(resolve));return{revenue:1200,qty:2,profit:null,sources:{Kaspi:{revenue:1200,profit:null}}}});
 stale.ctx.fetch=async(_url,options)=>{if(options?.method==='PUT'){writes++;return{ok:true}}reads++;return{ok:true,json:async()=>({ok:true,version:'calendar-v2',sourceRevision:'b'.repeat(64),snapshot,generatedAt:stamp(0,0),stale:true})}};
 const first=stale.window.renderBusinessDashboard(),second=stale.window.renderBusinessDashboard();await flush();assert.equal(stale.element('businessValue').textContent,'1000 ₸');assert.equal(reads,1);assert.equal(calculated,2);
 for(const resolve of finish.splice(0))resolve();await Promise.all([first,second]);assert.equal(stale.element('businessValue').textContent,'1200 ₸');assert.equal(writes,1);
});
test('a late month response cannot replace a subsequently selected cached day',async()=>{
 const f=fixture();await f.window.renderBusinessDashboard();await f.window.setBusinessDashboardPeriod('month');let finish;f.ctx.apiJson=()=>new Promise(resolve=>{finish=resolve});const pending=f.window.shiftBusinessDashboardMonth(-1);await flush();await f.window.setBusinessDashboardPeriod('day');assert.match(f.element('businessValueLabel').textContent,/сегодня/);finish({ok:true,orders:[]});await pending;assert.match(f.element('businessValueLabel').textContent,/сегодня/);
});
test('a historical month before the saved Kaspi/WB archive is unavailable instead of endlessly calculating',async()=>{
 for(const market of ['WB','Kaspi']){
  const f=fixture({period:'month'});f.element('businessCacheStatus');f.ctx.apiJson=async()=>({ok:true,orders:[],historyCoverage:[{market,from:Date.parse('2026-09-01T00:00:00+05:00')}]});
  await f.window.shiftBusinessDashboardMonth(-1);assert.match(f.element('businessValueLabel').textContent,market==='WB'?/Нет полной истории WB1/:/Нет полной истории Kaspi/);
  assert.equal(f.element('businessValue').textContent,'—');assert.equal(f.element('businessChart').innerHTML,'');assert.equal(f.element('businessValueMetric').textContent,'Заказы');assert.equal(f.element('businessYesterdayValue').textContent,'—');assert.equal(f.element('businessCacheStatus').textContent,'');
 }
});
test('a partial historical Ozon finance window stays marked in cached totals and cannot create a false growth percentage',async()=>{
 const f=fixture({period:'month',metric:'buyouts'});f.window.ozonFboFinanceHistoryCovers=()=>false;await f.window.renderBusinessDashboard();assert.match(f.element('businessValueMeta').textContent,/неполная история Ozon/);assert.match(f.element('businessValue').textContent,/≈/);assert.doesNotMatch(f.element('businessYesterdayCompare').innerHTML,/%/);
 const saved=JSON.parse(f.storage.get('milioner_business_snapshots_calendar_v2'));assert.equal(saved.entries[0][1].model.summary.partialOzonHistory,true);
 f.window.setBusinessDashboardMetric('orders');assert.doesNotMatch(f.element('businessValueMeta').textContent,/неполная история/);
});
function sharedFixture(block=false){const f=fixture({period:'week'});let loads=0,finish;const stored=new Map(),revision='c'.repeat(64);
 f.ctx.fetch=async(url,options)=>{if(options?.method==='PUT'){const body=JSON.parse(options.body);if(body.days)for(const day of body.days)stored.set(day.bounds.start,day);return{ok:true,json:async()=>({ok:true})}}if(url.includes('business-dashboard-days')){const q=new URL(url).searchParams,from=Number(q.get('from')),to=Number(q.get('to'));return{ok:true,json:async()=>({ok:true,version:'calendar-v2',sourceRevision:revision,days:[...stored].filter(([t])=>t>=from&&t<to).map(([,day])=>({day,generatedAt:Date.now(),fresh:true}))})}}return{ok:true,json:async()=>({ok:true,version:'calendar-v2',sourceRevision:revision,snapshot:null,stale:true})}};
 f.window.loadBusinessMarketplaceDaily=async range=>{loads++;if(block)await new Promise(resolve=>{finish=resolve});const out=[],from=Date.parse(range.from+'T00:00:00+05:00'),to=Date.parse(range.to+'T00:00:00+05:00');for(let t=from;t<=to;t+=86400000){const revenue=2000+Math.round((t-today)/86400000)*10;out.push({day:new Date(t+18000000).toISOString().slice(0,10),summary:{revenue,qty:2,profit:80,sources:{Kaspi:{revenue,profit:80}}}})}return out};return{...f,get loads(){return loads},finish(){block=false;finish?.()},stored};}
test('one loaded week prepares every included day and hour; day swipes reuse the same finance base',async()=>{
 const f=sharedFixture();await f.window.renderBusinessDashboard();assert.equal(f.loads,1);
 const week=f.api.businessModelFromDays('week',0),bounds=f.api.businessWeekBounds(0);let sum=0;for(let t=bounds.start;t<=today;t+=86400000)sum+=f.api.businessDays.get(t).data.summary.revenue;assert.equal(week.summary.revenue,sum);
 await f.window.setBusinessDashboardPeriod('day');f.window.setBusinessDashboardMetric('buyouts');assert.equal(f.element('businessValue').textContent,'2000 ₸');
 for(let i=1;i<=3;i++){const pending=f.window.shiftBusinessDashboardDay(-1);assert.equal(f.element('businessValue').textContent,(2000-i*10)+' ₸');await pending}
 assert.equal(f.loads,1);assert.ok(f.stored.size>=11);const day=f.api.businessDays.get(today-2*86400000).data;assert.equal(day.buckets[12].orders,800);
});
test('known orders render before finance, and switching to an included day joins the pending week request',async()=>{
 const f=sharedFixture(true),week=f.window.renderBusinessDashboard();await flush();assert.equal(f.loads,1);assert.equal(f.element('businessValueMetric').textContent,'Заказы');assert.doesNotMatch(f.element('businessValue').textContent,/…|—/);
 const day=f.window.setBusinessDashboardPeriod('day');await flush();assert.equal(f.loads,1);assert.equal(f.element('businessValue').textContent,'1000 ₸');f.window.setBusinessDashboardMetric('buyoutProfit');assert.equal(f.element('businessValue').textContent,'—');
 f.finish();await Promise.all([week,day]);assert.match(f.element('businessValueLabel').textContent,/сегодня/);assert.equal(f.element('businessValue').textContent,'80 ₸');assert.equal(f.loads,1);
});
test('a month and a week use matching shared day totals and survive reload without a finance read',async()=>{
 const f=sharedFixture();await f.window.setBusinessDashboardPeriod('month');const month=f.api.businessModelFromDays('month',0),days=[...f.api.businessDays.values()].filter(r=>r.data.bounds.start>=month.bounds.start&&r.data.bounds.start<month.bounds.end);assert.equal(month.summary.revenue,days.reduce((n,r)=>n+r.data.summary.revenue,0));
 const saved=f.storage.get('milioner_business_days_v2');assert.ok(saved);const reload=sharedFixture();reload.storage.set('milioner_business_days_v2',saved);const pending=reload.window.renderBusinessDashboard();assert.notEqual(reload.element('businessValue').textContent,'…');await pending;assert.equal(reload.loads,0);
});
test('moving between months keeps every day of the requested range when the bounded cache evicts older entries',async()=>{
 const f=sharedFixture();await f.window.setBusinessDashboardPeriod('month');await f.window.shiftBusinessDashboardMonth(-1);await f.window.shiftBusinessDashboardMonth(-1);assert.match(f.element('businessValueLabel').textContent,/авг/);assert.ok(f.api.businessModelFromDays('month',-2));assert.ok(f.api.businessDays.size<=80);assert.notEqual(f.element('businessValue').textContent,'—');
});
test('a recently generated server day with obsolete source revision still rebuilds instead of being trusted locally',async()=>{
 const seed=sharedFixture();await seed.window.renderBusinessDashboard();const stale=sharedFixture(),fetch=stale.ctx.fetch;stale.ctx.fetch=async(url,options)=>{if(!options&&url.includes('business-dashboard-days'))return{ok:true,json:async()=>({ok:true,version:'calendar-v2',sourceRevision:'d'.repeat(64),days:[...seed.stored.values()].map(day=>({day,generatedAt:today+20*60000,fresh:false}))})};return fetch(url,options)};await stale.window.renderBusinessDashboard();assert.equal(stale.loads,1);
});

test('first month build yields to actual UI tasks, permits switching day before completion and reads local financial sales once',async()=>{
 const f=sharedFixture();let yielded=0,salesReads=0,dayJob,switchedWhileBuilding=false,done=false;
 const read=f.ctx.financialSales;f.ctx.financialSales=()=>{salesReads++;return read()};
 f.window.clearTimeout=clearTimeout;f.window.setTimeout=(fn,delay=0)=>delay>0?setTimeout(fn,delay).unref():setImmediate(()=>{yielded++;if(yielded===2){dayJob=f.window.setBusinessDashboardPeriod('day');switchedWhileBuilding=!done&&f.element('businessPeriodTitle').textContent!=='Месяц'}fn()});
 const month=f.window.setBusinessDashboardPeriod('month');await month;done=true;await dayJob;
 assert.equal(switchedWhileBuilding,true);assert.ok(yielded>30);assert.equal(salesReads,1);assert.equal(f.loads,1);assert.match(f.element('businessValueLabel').textContent,/сегодня/);assert.equal(f.api.businessDays.get(today).data.orders.amount,1000);
});

test('September comparison prepares August; selecting August keeps it visible when July is unavailable',async()=>{
 const f=sharedFixture(),read=f.ctx.apiJson,archive=Date.parse('2026-07-19T00:00:00+05:00');f.ctx.apiJson=async url=>({...await read(url),historyCoverage:[{market:'WB',from:archive}]});
 await f.window.setBusinessDashboardPeriod('month');await f.window.shiftBusinessDashboardMonth(-1);
 const september=f.api.businessModelFromDays('month',-1),august=september.yesterday;assert.equal(august.unavailable,undefined);assert.ok(august.orders.amount>0);
 const pending=f.window.shiftBusinessDashboardMonth(-1);assert.equal(f.element('businessValue').textContent,august.orders.amount+' ₸');await pending;
 const selected=f.api.businessModelFromDays('month',-2);assert.equal(selected.orders.amount,august.orders.amount);assert.equal(selected.yesterday.unavailable,true);assert.equal(f.element('businessYesterdayValue').textContent,'—');assert.match(f.element('businessYesterdayMeta').textContent,/Нет полной истории/);assert.match(f.element('businessYesterdayCompare').textContent,/Нет полной истории/);assert.doesNotMatch(f.element('businessChart').innerHTML,/business-yesterday-bar/);assert.match(f.element('businessValueLabel').textContent,/авг/);
});
test('a missing optional preceding day cannot hide either complete calendar month',async()=>{
 const f=sharedFixture(),read=f.ctx.apiJson;f.ctx.apiJson=async url=>({...await read(url),historyCoverage:[{market:'WB',from:Date.parse('2026-08-01T00:00:00+05:00')}]});await f.window.setBusinessDashboardPeriod('month');await f.window.shiftBusinessDashboardMonth(-1);const model=f.api.businessModelFromDays('month',-1);assert.ok(model.orders.amount>0);assert.equal(model.yesterday.unavailable,undefined);assert.match(f.element('businessChart').innerHTML,/business-yesterday-bar/);
});
test('unknown selected month is never replaced by zeros or the preceding screen comparison',async()=>{
 const f=sharedFixture(),read=f.ctx.apiJson;f.ctx.apiJson=async url=>({...await read(url),historyCoverage:[{market:'WB',from:Date.parse('2026-09-01T00:00:00+05:00')}]});await f.window.setBusinessDashboardPeriod('month');await f.window.shiftBusinessDashboardMonth(-1);await f.window.shiftBusinessDashboardMonth(-1);assert.equal(f.element('businessValue').textContent,'—');assert.equal(f.element('businessYesterdayMeta').textContent,'');assert.match(f.element('businessValueLabel').textContent,/Нет полной истории WB1/);assert.equal(f.element('businessChart').innerHTML,'');
});

test('failed month navigation cannot restore a pending week under the month selection',async()=>{
 const f=sharedFixture(true),week=f.window.renderBusinessDashboard();
 for(let i=0;i<4;i++)await flush();
 assert.ok(f.api.businessModelFromDays('week',0)?.pending);
 f.ctx.apiJson=async()=>{throw Error('offline')};
 await f.window.setBusinessDashboardPeriod('month');
 await f.window.shiftBusinessDashboardMonth(-1);
 assert.equal(f.element('businessValue').textContent,'—');
 assert.equal(f.element('businessValueLabel').textContent,'Не удалось посчитать');
 assert.equal(f.element('businessChart').innerHTML,'');
 f.finish();await week;
 assert.equal(f.element('businessValueLabel').textContent,'Не удалось посчитать');
});

test('missing historical Ozon orders request the selected month and stop showing calculation placeholders',async()=>{
 const f=sharedFixture();let requested;
 f.window.ozonFboOrderHistoryCovers=()=>false;
 f.window.ozonFboRequestOrderHistory=async bounds=>{requested=bounds;return true};
 await f.window.setBusinessDashboardPeriod('month');for(let i=0;i<5;i++)await f.window.shiftBusinessDashboardMonth(-1);
 assert.ok(requested.start<=f.api.businessMonthBounds(-5).start);
 assert.match(f.element('businessValueLabel').textContent,/История Ozon.*догружается/);
 assert.equal(f.element('businessValue').textContent,'—');
 assert.equal(f.element('businessYesterdayValue').textContent,'—');
 assert.equal(f.element('businessValueMetric').textContent,'Заказы');
});
test('a hung dashboard request ends with unavailable values instead of infinite calculation',async()=>{
 const f=sharedFixture();f.window.clearTimeout=clearTimeout;
 f.window.setTimeout=(fn,delay)=>setTimeout(fn,delay?5:0);
 f.ctx.fetch=()=>new Promise(()=>{});
 await f.window.renderBusinessDashboard();
 assert.equal(f.element('businessValueMetric').textContent,'Заказы');
 assert.equal(f.element('businessValue').textContent,'—');assert.equal(f.element('businessYesterdayValue').textContent,'—');
 assert.doesNotMatch(f.element('businessValueLabel').textContent,/Считаю/);
});

test('a display timeout does not release the active build and start another background rebuild',async()=>{
 const f=sharedFixture(true),fetch=f.ctx.fetch;let cacheReads=0;
 f.ctx.fetch=(url,options)=>{if(url.includes('/business-dashboard-cache'))cacheReads++;return fetch(url,options)};
 f.window.clearTimeout=clearTimeout;f.window.setTimeout=(fn,delay=0)=>setTimeout(fn,delay?5:0);
 await f.window.renderBusinessDashboard();assert.equal(cacheReads,1);
 const second=f.window.renderBusinessDashboard();await flush();assert.equal(cacheReads,1);
 f.finish();await second;assert.equal(f.loads,1);
});


test('loading every month retains compact totals for immediate year display after daily eviction and reload',async()=>{
 const f=sharedFixture();await f.window.setBusinessDashboardPeriod('month');
 for(let i=0;i<9;i++)await f.window.shiftBusinessDashboardMonth(-1);
 assert.ok(f.api.businessDays.size<=80);
 const january=f.api.businessModelFromDays('month',-9);assert.ok(january&&!january.unavailable);
 const year=f.api.businessModelFromDays('year',0);assert.equal(year.knownMonths,10);assert.equal(year.yearPartial,false);
 const loads=f.loads,pending=f.window.setBusinessDashboardPeriod('year');
 assert.doesNotMatch(f.element('businessValueMeta').textContent,/неполный год/);
 assert.notEqual(f.element('businessValue').textContent,'…');await pending;assert.equal(f.loads,loads);
 const reloaded=sharedFixture();reloaded.storage.set('milioner_business_month_bases_v1',f.storage.get('milioner_business_month_bases_v1'));
 assert.equal(reloaded.api.businessModelFromDays('year',0).knownMonths,10);
 const september=reloaded.api.businessModelFromDays('month',-1);assert.ok(september.yesterday.orders);assert.equal(september.yesterday.unavailable,undefined);
 assert.ok(f.storage.get('milioner_business_month_bases_v1').length<1000000);
});

test('leaving Reports stops remaining daily calculations and prevents background cache writes',async()=>{
 const f=sharedFixture(true),pending=f.window.renderBusinessDashboard();await flush();assert.equal(f.loads,1);
 f.element('reports').classList.contains=()=>false;f.finish();await pending;
 assert.equal(f.stored.size,0);assert.ok([...f.api.businessDays.values()].every(r=>r.data.pending));
});
