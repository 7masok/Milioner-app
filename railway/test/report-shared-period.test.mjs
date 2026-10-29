import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../../business-dashboard-v1.js',import.meta.url),'utf8');
function fixture(){
 const elements=new Map(),el=id=>{if(!elements.has(id))elements.set(id,{innerHTML:'',style:{},dataset:{},setAttribute(){},querySelectorAll:()=>[],addEventListener(){},before(){},classList:{contains:()=>true,toggle(){}}});return elements.get(id)},calls=[],storage=new Map();
 class Clock extends Date{constructor(...args){super(...(args.length?args:['2026-10-29T10:00:00+05:00']))}static now(){return Date.parse('2026-10-29T10:00:00+05:00')}}
 const c={window:{renderReports:()=>calls.push({preset:c.reportPeriod,from:c.reportCustomFrom,to:c.reportCustomTo,market:c.state.settings.reportMarket})},document:{readyState:'loading',addEventListener(){},getElementById:el,querySelectorAll:()=>[]},localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},state:{settings:{reportMarket:'Kaspi'}},Date:Clock,Intl,Map,Set,console,reportPeriod:7,reportPeriodPreset:7,reportCustomFrom:'2026-10-23',reportCustomTo:'2026-10-29',rememberReportPeriodUiPreference(){},setReportPeriod:n=>{c.reportPeriod=n;c.reportPeriodPreset=n;c.window.renderReports()}};
 vm.runInNewContext(source,c);c.window.renderBusinessDashboard=async()=>{};return{c,window:c.window,el,calls,storage};
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
