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
 function element(id){if(!elements.has(id))elements.set(id,{id,innerHTML:'',textContent:'',dataset:{},classList:{contains:()=>true,toggle(){}},listeners:new Map(),addEventListener(type,handler){this.listeners.set(type,handler)}});return elements.get(id)}
 for(const id of ['reports','businessDashboard','businessChart','businessPeriodTitle','businessPeriodSub','businessDayNav','businessDayDate','businessDayPrevious','businessDayNext','businessValueMetric','businessValueLabel','businessValue','businessValueMeta','businessYesterdayLabel','businessYesterdayValue','businessYesterdayMeta','businessYesterdayCompare'])element(id);
 const state={kaspiOrderFeed:[],wbOrderFeed:[],ozonOrderFeed:[]},sales=[];
 for(let offset=-8;offset<=0;offset++){
  const amount=1000+offset*100,creationDate=offset===0?stamp(0,0)+5*60000:stamp(offset);
  state.kaspiOrderFeed.push({market:'Kaspi',creationDate,status:'NEW',lines:[{qty:2,totalPrice:amount,productId:'p'}]});
  sales.push({channel:'Kaspi',date:creationDate,qty:2,price:amount/2,cost:10,fee:0});
 }
 const window={allMarketUnitProfit30:new Map([['p',{qty:10,unitProfit:40}]]),loadBusinessMarketplaceSummary:async(days,options)=>{
  requests.push({days,...options});if(loader)return loader(days,options);
  const start=options.range?Date.parse(options.range.from+'T00:00:00+05:00'):days===-1?today-86400000:today;
  const revenue=1000+Math.round((start-today)/86400000)*100;
  return {revenue,qty:2,profit:80,sources:{Kaspi:{revenue,profit:80}}};
 }};
 const ctx={window,Date:Clock,Intl,Map,Set,console,state,financialSales:()=>sales,groupMarketplaceOrders:rows=>rows,marketplaceLifecycleStage:()=>'',fmt:n=>String(n)+' ₸',localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},document:{readyState:'loading',getElementById:id=>elements.get(id)||null,querySelectorAll:()=>[],addEventListener(){}},setTimeout() {}};
 vm.createContext(ctx);
 vm.runInContext(source.replace(/\}\)\(\);\s*$/, "window.testApi={businessDayBounds,businessSelectedDayOffset,businessBuildModel,businessInstallDaySwipe,businessModels,businessPaintTabs};})();"),ctx);
 const chart=element('businessChart');window.testApi.businessInstallDaySwipe();
 const touch=(x,y,id=1)=>({clientX:x,clientY:y,identifier:id});
 function event(type,touches,changedTouches=[]){let prevented=false;chart.listeners.get(type)({touches,changedTouches,cancelable:true,preventDefault(){prevented=true}});return prevented}
 function swipe(dx,dy=0){event('touchstart',[touch(100,100)]);const prevented=event('touchmove',[touch(100+dx,100+dy)]);event('touchend',[],[touch(100+dx,100+dy)]);return prevented}
 return {ctx,window,state,sales,requests,element,storage,event,touch,swipe,api:window.testApi,setNow:value=>{now=value}};
}
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve()};

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
 f.swipe(80);assert.equal(f.element('businessValueLabel').textContent,week);assert.equal(f.element('businessDayNav').hidden,true);
 await f.window.setBusinessDashboardPeriod('month');f.swipe(80);assert.equal(f.element('businessDayNav').hidden,true);
});

test('changing the metric while a day loads never paints the previous day',async()=>{
 const deferred=[];let block=false;
 const f=fixture({},async()=>{if(block)await new Promise(resolve=>deferred.push(resolve));return {revenue:100,qty:2,profit:80,sources:{Kaspi:{revenue:100,profit:80}}}});
 await f.window.renderBusinessDashboard();block=true;const pending=f.window.shiftBusinessDashboardDay(-1);await flush();
 f.window.setBusinessDashboardMetric('buyouts');await flush();assert.equal(f.element('businessValue').textContent,'…');
 for(const resolve of deferred.splice(0))resolve();await pending;await flush();
 assert.match(f.element('businessValueLabel').textContent,/7 окт.*весь день/);assert.equal(f.element('businessValueMetric').textContent,'Выкупы');
});
