import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const api=readFileSync(new URL('../src/prices.js',import.meta.url),'utf8');
const ui=readFileSync(new URL('../../prices-v1.js',import.meta.url),'utf8');
function source(name,next){const a=api.indexOf('function '+name+'(');assert.ok(a>=0);return api.slice(a,api.indexOf(next,a)).replaceAll('export ','');}
const ctx={Date,Number,Set,Array,ALMATY_OFFSET_MS:5*3600000};
runInNewContext(source('normalizeWbNightWeekdays','async function wbPriceState'),ctx);
const at=(s)=>Date.parse(s+'+05:00');
const window=(s,e,t,days)=>ctx.wbNightWindowState(s,e,at(t),days);
test('Almaty selected start weekdays and exact boundaries',()=>{
 assert.equal(window(240,300,'2026-10-19T04:00:00',[1]).inWindow,true);
 assert.equal(window(240,300,'2026-10-19T03:59:59',[1]).inWindow,false);
 assert.equal(window(240,300,'2026-10-19T05:00:00',[1]).inWindow,false);
 assert.equal(window(240,300,'2026-10-20T04:30:00',[1]).inWindow,false);
 assert.equal(window(240,300,'2026-10-18T04:30:00',[7]).inWindow,true);
 assert.equal(window(240,300,'2026-10-18T04:30:00',[1]).inWindow,false);
});
test('overnight Friday includes Saturday morning and Sunday wraps into Monday',()=>{
 for(const [time,days,key] of [['2026-10-16T23:00:00',[5],'2026-10-16'],['2026-10-17T04:59:59',[5],'2026-10-16'],['2026-10-19T00:00:00',[7],'2026-10-18']]){
  const w=window(1380,300,time,days);assert.equal(w.inWindow,true);assert.equal(w.windowKey,key);
 }
 assert.equal(window(1380,300,'2026-10-17T05:00:00',[5]).inWindow,false);
 assert.equal(window(1380,300,'2026-10-17T23:00:00',[5]).inWindow,false);
 assert.equal(window(1380,300,'2026-10-19T00:00:00',[1]).inWindow,false);
});
test('legacy schedules remain daily; invalid selections rejected',()=>{
 assert.equal(window(240,300,'2026-10-18T04:30:00').inWindow,true);
 assert.equal(window(240,240,'2026-10-18T04:00:00').inWindow,false);
 assert.deepEqual(Array.from(ctx.normalizeWbNightWeekdays([7,1,7])),[1,7]);
 for(const input of [[],[0],[8],[1.5],['1'],'1'])assert.throws(()=>ctx.normalizeWbNightWeekdays(input),/Выберите/);
});
test('save passes validated weekdays to both upserts, preserves old clients and in-flight/base fields',async()=>{
 const calls=[];const client={query:async(sql,args)=>{calls.push({sql,args});return{rows:[]}},release(){}};
 const saveCtx={Number,Set,Array,Map,Date,normalizeWbNightWeekdays:ctx.normalizeWbNightWeekdays,pool:{connect:async()=>client},timeToMinute:v=>Number(v.slice(0,2))*60+Number(v.slice(3)),number:Number,wbPriceSnapshot:async()=>({rows:[{remoteId:10}]}),protectionFor:async()=>({}),syncWbNightSchedules:async()=>{},wbPriceSchedules:async()=>[]};
 runInNewContext('async '+source('saveWbNightSchedules',"pricesRouter.post('/market-prices/night-schedule'"),saveCtx);
 for(const enabled of [true,false]){
  calls.length=0;await saveCtx.saveWbNightSchedules('WB',{remoteId:10,enabled,start:'23:00',end:'05:00',price:2000,weekdays:[5,7]});
  const q=calls.find(x=>x.sql.startsWith('INSERT INTO wb_price_schedules'));assert.deepEqual(Array.from(q.args[6]),[5,7]);
  const conflict=q.sql.split('ON CONFLICT')[1];assert.match(conflict,/weekdays=COALESCE\(\$7::integer\[\],wb_price_schedules.weekdays\)/);assert.doesNotMatch(conflict,/base_price\s*=|window_key\s*=/);assert.ok(!calls.some(x=>/DELETE FROM wb_price_update_queue/.test(x.sql)));
 }
 calls.length=0;await saveCtx.saveWbNightSchedules('WB2',{remoteId:10,enabled:true,price:2000});assert.equal(calls.find(x=>x.sql.startsWith('INSERT')).args[6],null);
 calls.length=0;await assert.rejects(saveCtx.saveWbNightSchedules('WB',{remoteId:10,enabled:true,price:2000,weekdays:[]}),/Выберите/);assert.equal(calls.length,0);
});
test('bulk and single pickers preselect saved days, expose seven accessible choices and read exact selection',()=>{
 const dom={getElementById:id=>id==='picked'?{querySelectorAll:()=>[{value:'2'},{value:'5'}]}:null};
 const u={document:dom};const a=ui.indexOf('function priceNightWeekdays('),b=ui.indexOf('window.savePriceCardNight=',a);runInNewContext(ui.slice(a,b),u);
 const html=u.priceNightDaysPicker('picked',[2,5]);assert.equal((html.match(/type="checkbox"/g)||[]).length,7);assert.equal((html.match(/ checked/g)||[]).length,2);assert.match(html,/value="2" checked aria-label="Вт"/);assert.equal(u.priceNightDaysLabel([2,5]),'Вт, Пт');assert.equal(u.priceNightDaysLabel(), 'Ежедневно');assert.deepEqual(Array.from(u.readPriceNightWeekdays('picked')),[2,5]);
 assert.ok(ui.includes("priceNightDaysPicker('priceNightCardDays',row.nightPriceWeekdays)"));assert.ok(ui.includes("priceNightDaysPicker('priceNightDays',first.nightPriceWeekdays)"));
});
