import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../../business-dashboard-v1.js',import.meta.url),'utf8');
const NOW=Date.parse('2026-11-03T10:22:00+05:00'),DAY=86400000;
function fixture(){
 class Clock extends Date{constructor(...args){super(...(args.length?args:[NOW]))}static now(){return NOW}}
 const elements=new Map(),storage=new Map(),selection=['Kaspi','WB','WB2','Ozon'];let packs=0;
 const el=id=>{if(!elements.has(id))elements.set(id,{innerHTML:'',textContent:'',dataset:{},classList:{contains:()=>true,toggle(){}},setAttribute(){},addEventListener(){}});return elements.get(id)};
 for(const id of ['reports','businessDashboard','businessChart','businessPeriodTitle','businessPeriodSub','businessDayDate','businessDayPrevious','businessDayNext','businessValueMetric','businessValueLabel','businessValue','businessValueMeta','businessYesterdayLabel','businessYesterdayValue','businessYesterdayMeta','businessYesterdayCompare'])el(id);
 const ctx={Date:Clock,Intl,console,Map,Set,WeakMap,JSON:{...JSON,parse:JSON.parse,stringify(value,...args){if(value?.data?.packedHours)packs++;return JSON.stringify(value,...args)}},state:{settings:{}},WAREHOUSE_SCOPE_CONFIG:{enabled:true},unifiedWarehouseEnabled:true,
  selectedStoreIds:()=>selection,getReportMarket:()=>selection.length===1?selection[0]:'all',
  document:{readyState:'loading',getElementById:id=>elements.get(id)||null,querySelectorAll:()=>[],addEventListener(){}},
  localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},fmt:n=>String(n)+' ₸',
  financialSales:()=>[],groupMarketplaceOrders:rows=>rows,marketplaceLifecycleStage:()=>'',
  setTimeout:(fn,ms)=>ms?setTimeout(fn,ms).unref():fn(),clearTimeout};
 ctx.window=ctx;vm.createContext(ctx);
 vm.runInContext(source.replace(/\}\)\(\);\s*$/,'window.api={businessSyncMarket,businessStamp,businessScopeMatches,businessPaint,businessDayBounds,businessYearBounds,businessMakeDay,businessMissingComparison,businessModelFromDays,businessDays,businessRememberModel,businessModelKey,businessSaveDays,businessBuckets};})();'),ctx);
 ctx.api.businessSyncMarket();return{ctx,api:ctx.api,el,selection,storage,packs:()=>packs};
}
function seed(f){
 for(let offset=-1;offset<=0;offset++){
  const start=f.api.businessDayBounds(offset).start,day=f.api.businessMakeDay(start,[],{revenue:100,qty:1,profit:10});
  f.api.businessDays.set(start,{data:day,at:NOW});
 }
 const day=f.api.businessModelFromDays('day',0);f.api.businessRememberModel(f.api.businessModelKey(),day);
 f.ctx.loadBusinessMarketplaceDaily=async()=>{throw Error('ready days must be reused')};return day;
}
test('unified reports replace a year chart with Today immediately, including a warm daily basis',async()=>{
 const f=fixture(),day=seed(f);
 const year=f.api.businessStamp({...f.api.businessMissingComparison('year',0),unavailable:false,yesterday:f.api.businessMissingComparison('year',-1),yesterdayCompare:f.api.businessMissingComparison('year',-1)});
 // Reproduce an old year chart already on screen when the day control changes.
 f.el('businessValueLabel').textContent='2026 · этот год';f.el('businessChart').innerHTML='old year bars';
 await f.ctx.renderBusinessDashboard();
 assert.match(f.el('businessValueLabel').textContent,/3 нояб.*сегодня/);
 assert.equal((f.el('businessChart').innerHTML.match(/class="business-hour"/g)||[]).length,24);
 assert.equal(f.api.businessScopeMatches(day),true);
 const current=f.el('businessChart').innerHTML;f.api.businessPaint(year);
 assert.equal(f.el('businessChart').innerHTML,current,'a late year paint must not overwrite Today');
});
test('native four-store saved history is reusable while another store subset stays isolated',()=>{
 const f=fixture(),native={market:'all',period:'day',bounds:f.api.businessDayBounds(0)};
 assert.equal(f.api.businessScopeMatches(native),true);
 f.selection.splice(0,f.selection.length,'WB3');f.api.businessSyncMarket();
 assert.equal(f.api.businessScopeMatches(native),false);
 const day=f.api.businessMakeDay(f.api.businessDayBounds(0).start,[],{revenue:0,qty:0,profit:null});
 assert.equal(f.api.businessScopeMatches(day),true);
 f.selection.splice(0,f.selection.length,'Kaspi','WB');f.api.businessSyncMarket();
 assert.equal(f.api.businessScopeMatches(native),false);assert.equal(f.api.businessScopeMatches(day),false);
});
test('day, week, month and year switches reuse the same prepared unified days with matching chart scales',async()=>{
 const f=fixture();
 for(let n=0;n<365;n++){const start=f.api.businessDayBounds(-n).start;f.api.businessDays.set(start,{data:f.api.businessMakeDay(start,[],{revenue:10,qty:1,profit:1}),at:NOW})}
 f.ctx.loadBusinessMarketplaceDaily=async()=>assert.fail('prepared periods must not fetch source history');
 for(const period of ['year','month','week','day']){
  const model=f.api.businessModelFromDays(period,0);f.api.businessRememberModel(period+':'+model.bounds.start,model);
  await f.ctx.setBusinessDashboardPeriod(period);
  const expected=period==='year'?12:period==='month'?31:period==='week'?7:24; // Includes October 31 in the comparison.
  assert.equal((f.el('businessChart').innerHTML.match(/class="business-hour"/g)||[]).length,expected,period);
  assert.equal(f.el('businessPeriodTitle').textContent,{year:'Год',month:'Месяц',week:'Неделя',day:'Сегодня'}[period]);
 }
});
test('saving unchanged daily history does not repack every hour on each render',()=>{
 const f=fixture();for(let n=0;n<100;n++){const start=f.api.businessDayBounds(-n).start;f.api.businessDays.set(start,{data:f.api.businessMakeDay(start,[],{revenue:10,qty:1,profit:1}),at:NOW})}
 f.api.businessSaveDays();const count=f.packs();assert.equal(count,100);
 f.api.businessSaveDays();assert.equal(f.packs(),count);
 const start=f.api.businessDayBounds(0).start,row=f.api.businessDays.get(start);row.unsaved='HTTP 409';f.api.businessSaveDays();assert.equal(f.packs(),count+1);
 const stored=[...f.storage.values()].find(text=>text.includes('packedHours'));assert.match(stored,/HTTP 409/);
});
