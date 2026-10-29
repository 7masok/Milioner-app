import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../../business-dashboard-v1.js',import.meta.url),'utf8');
function fixture(){
 const elements=new Map(),el=id=>{if(!elements.has(id))elements.set(id,{innerHTML:'',style:{},dataset:{},setAttribute(){},querySelectorAll:()=>[],listeners:new Map(),addEventListener(type,fn){this.listeners.set(type,fn)},before(){},classList:{contains:()=>true,toggle(){}}});return elements.get(id)},calls=[],storage=new Map();
 class Clock extends Date{constructor(...args){super(...(args.length?args:['2026-10-29T10:00:00+05:00']))}static now(){return Date.parse('2026-10-29T10:00:00+05:00')}}
 const c={window:{renderReports:()=>calls.push({preset:c.reportPeriod,from:c.reportCustomFrom,to:c.reportCustomTo,market:c.state.settings.reportMarket})},document:{readyState:'loading',addEventListener(){},getElementById:el,querySelectorAll:()=>[]},localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},state:{settings:{reportMarket:'Kaspi'}},Date:Clock,Intl,Map,Set,console,reportPeriod:7,reportPeriodPreset:7,reportCustomFrom:'2026-10-23',reportCustomTo:'2026-10-29',rememberReportPeriodUiPreference(){},setReportPeriod:n=>{c.reportPeriod=n;c.reportPeriodPreset=n;c.window.renderReports()}};
 el('reports').querySelector=selector=>selector==='.kpi'?el('totals'):null;
 vm.runInNewContext(source.replace(/\}\)\(\);\s*$/, 'window.installSwipe=businessInstallDaySwipe;})();'),c);c.window.installSwipe();c.window.renderBusinessDashboard=async()=>{};return{c,window:c.window,el,calls,storage};
}
test('upper calendar buttons drive exact lower report ranges and retain live today/yesterday modes',async()=>{
 const f=fixture();await f.window.setBusinessDashboardPeriod('week');assert.deepEqual(f.calls.at(-1),{preset:0,from:'2026-10-26',to:'2026-10-29',market:'Kaspi'});
 await f.window.shiftBusinessDashboardSelection(-1);assert.equal(f.calls.at(-1).from,'2026-10-19');assert.equal(f.calls.at(-1).to,'2026-10-25');
 await f.window.setBusinessDashboardPeriod('month');assert.equal(f.calls.at(-1).from,'2026-10-01');await f.window.shiftBusinessDashboardSelection(-1);assert.equal(f.calls.at(-1).from,'2026-09-01');assert.equal(f.calls.at(-1).to,'2026-09-30');
 await f.window.setBusinessDashboardPeriod('year');assert.equal(f.calls.at(-1).from,'2026-01-01');await f.window.shiftBusinessDashboardSelection(-1);assert.equal(f.calls.at(-1).from,'2025-01-01');assert.equal(f.calls.at(-1).to,'2025-12-31');
 await f.window.setBusinessDashboardYesterday();assert.equal(f.calls.at(-1).preset,-1);assert.equal(f.calls.at(-1).from,'2026-10-28');await f.window.shiftBusinessDashboardSelection(-1);assert.equal(f.calls.at(-1).preset,0);assert.equal(f.calls.at(-1).from,'2026-10-27');
 await f.window.setBusinessDashboardPeriod('day');assert.equal(f.calls.at(-1).preset,1);assert.equal(f.calls.at(-1).from,'2026-10-29');assert.match(f.el('reportPeriod').innerHTML,/Свой период/);assert.doesNotMatch(f.el('reportPeriod').innerHTML,/7 дней|30 дней|Сегодня/);assert.equal(f.el('reportCustomRange').style.display,'none');
});
test('manual custom dates remain editable across renders and shop changes; upper selection returns to common calendar',async()=>{
 const f=fixture();await f.window.setBusinessDashboardPeriod('week');f.window.openBusinessCustomPeriod();f.c.reportCustomFrom='2026-09-05';f.c.reportCustomTo='2026-09-12';f.window.renderReports();assert.equal(f.calls.at(-1).from,'2026-09-05');assert.equal(f.el('reportCustomRange').style.display,'grid');assert.equal(JSON.parse(f.storage.get('milioner_business_dashboard_v1')).customActive,true);
 f.c.state.settings.reportMarket='WB2';f.window.renderReports();assert.equal(f.calls.at(-1).market,'WB2');assert.equal(f.calls.at(-1).to,'2026-09-12');await f.window.setBusinessDashboardPeriod('week');assert.equal(f.calls.at(-1).from,'2026-10-26');assert.equal(f.el('reportCustomRange').style.display,'none');assert.equal(JSON.parse(f.storage.get('milioner_business_dashboard_v1')).customActive,false);
});

test('custom dates chosen in an existing store detail remain intact when the main report rerenders',async()=>{
 const f=fixture();await f.window.setBusinessDashboardPeriod('month');f.c.reportPeriod=0;f.c.reportPeriodPreset=0;f.c.reportCustomFrom='2026-07-02';f.c.reportCustomTo='2026-07-09';f.window.renderReports();assert.equal(f.calls.at(-1).from,'2026-07-02');assert.equal(f.calls.at(-1).to,'2026-07-09');assert.equal(f.el('reportCustomRange').style.display,'grid');await f.window.setBusinessDashboardPeriod('day');assert.equal(f.calls.at(-1).preset,1);
});

test('lower cards swipe the shared calendar without treating scrolling, taps or cancelled touches as navigation',async()=>{
 const f=fixture(),listeners=f.el('totals').listeners;
 const touch=(x,y,id=1)=>({clientX:x,clientY:y,identifier:id});
 const send=(type,touches=[],changedTouches=[])=>{let prevented=false;listeners.get(type)({touches,changedTouches,cancelable:true,preventDefault(){prevented=true}});return prevented};
 const swipe=(dx,dy=0)=>{send('touchstart',[touch(100,100)]);const prevented=send('touchmove',[touch(100+dx,100+dy)]);send('touchend',[],[touch(100+dx,100+dy)]);return prevented};
 await f.window.setBusinessDashboardPeriod('week');assert.equal(swipe(80),true);assert.equal(f.calls.at(-1).from,'2026-10-19');assert.equal(f.calls.at(-1).to,'2026-10-25');
 let blocked=false;listeners.get('click')({preventDefault(){blocked=true},stopImmediatePropagation(){}});assert.equal(blocked,true);
 const n=f.calls.length;assert.equal(swipe(10),false);assert.equal(swipe(60,100),false);assert.equal(f.calls.length,n);
 send('touchstart',[touch(0,0)]);send('touchcancel');send('touchend',[],[touch(100,0)]);assert.equal(f.calls.length,n);
 send('touchstart',[touch(0,0)]);send('touchmove',[touch(80,0),touch(0,0,2)]);send('touchend',[],[touch(100,0)]);assert.equal(f.calls.length,n);
 blocked=false;send('touchstart',[touch(0,0)]);send('touchend',[],[touch(1,0)]);listeners.get('click')({preventDefault(){blocked=true},stopImmediatePropagation(){}});assert.equal(blocked,false);
 swipe(-80);assert.equal(f.calls.at(-1).from,'2026-10-26');swipe(-80);assert.equal(f.calls.at(-1).from,'2026-10-26');
 await f.window.setBusinessDashboardPeriod('month');swipe(80);assert.equal(f.calls.at(-1).from,'2026-09-01');
 await f.window.setBusinessDashboardPeriod('year');swipe(80);assert.equal(f.calls.at(-1).from,'2025-01-01');
 await f.window.setBusinessDashboardPeriod('day');swipe(80);assert.equal(f.calls.at(-1).preset,-1);
 f.window.openBusinessCustomPeriod();swipe(80);assert.equal(f.calls.at(-1).from,'2026-10-27');assert.equal(f.el('reportCustomRange').style.display,'none');
 const before=listeners.get('touchstart');f.window.installSwipe();assert.equal(listeners.get('touchstart'),before);
});
