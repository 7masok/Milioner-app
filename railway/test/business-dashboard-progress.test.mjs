import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {historyProgress,readBusinessProgress} from '../src/business-dashboard-progress.js';
const DAY=86400000,NOW=Date.parse('2026-10-23T20:27:00+05:00'),TODAY=Date.parse('2026-10-23T00:00:00+05:00'),GOAL=TODAY-364*DAY;
test('persisted metadata distinguishes active, paused, waiting, unknown and completed history',()=>{
 const current={from:GOAL+DAY,to:NOW,goal:GOAL,updatedAt:NOW-60000};assert.equal(historyProgress(current,NOW).status,'loading');assert.equal(historyProgress({...current,updatedAt:NOW-10*60000},NOW).status,'unknown');
 const paused=historyProgress({...current,error:'Ozon HTTP 429',nextAt:NOW+3600000},NOW);assert.equal(paused.status,'paused');assert.equal(paused.nextAt,NOW+3600000);assert.equal(paused.error,'Ozon HTTP 429');
 assert.equal(historyProgress({...current,nextAt:NOW+12*3600000},NOW).status,'waiting');assert.equal(historyProgress({...current,from:GOAL,complete:true},NOW).status,'ready');assert.notEqual(historyProgress({...current,from:GOAL,complete:false},NOW).status,'ready');assert.notEqual(historyProgress({...current,from:GOAL,complete:true,to:TODAY-DAY},NOW).status,'ready');
});
test('Ozon progress reads bounded metadata and TEXT settings, without exposing source rows or making requests',async()=>{
 const sql=[],client={query:async(query)=>{sql.push(query);if(query.includes('warehouse_state'))return{rows:[{payload:JSON.stringify({settings:{reportStoreStarts:{Ozon:'2026-01-01'}}})}]};if(query.includes('ozon_fbo_cache'))return{rows:[{account:'private-account-id',updated_at:NOW,orders_from:new Date(GOAL).toISOString(),orders_to:new Date(NOW).toISOString(),orders_at:NOW,finance_from:'2026-05-19T19:00:00Z',finance_to:new Date(NOW).toISOString(),finance_at:NOW-10000}]};assert.fail(query)}};
 const result=await readBusinessProgress(client,'Ozon',NOW);assert.equal(result.sources.length,2);assert.equal(result.sources[0].status,'ready');assert.equal(result.sources[1].status,'loading');assert.equal(result.sources[1].from,Date.parse('2026-05-20T00:00:00+05:00'));assert.equal(result.sources[1].targetFrom,Date.parse('2026-01-01T00:00:00+05:00'));assert.ok(sql.every(s=>s.startsWith('SELECT')));assert.equal(sql.length,2);assert.doesNotMatch(JSON.stringify(result),/private-account-id|rows|credentials|token/);assert.doesNotMatch(sql[0],/payload->/);
});
test('WB and Kaspi progress remain separate; absent sources stay unknown and WB finance respects its saved slot',async()=>{
 const client={query:async sql=>sql.includes('warehouse_state')?{rows:[{payload:'{}'}]}:sql.includes('wb_finance_history')?{rows:[{market:'WB',state:{archive:{complete:false,dateFrom:'2025-10-24',dateTo:'2026-10-23'},nextAllowedAt:NOW+12*3600000,updatedAt:NOW}}]}:sql.includes('wb_order_history_state')?{rows:[{market:'WB',payload:{coveredFrom:GOAL,anchor:NOW,complete:true},updated_at:NOW}]}:{rows:[]}};
 const result=await readBusinessProgress(client,'all',NOW);assert.equal(result.sources.length,8);assert.equal(result.sources.find(x=>x.market==='WB'&&x.kind==='orders').status,'ready');assert.equal(result.sources.find(x=>x.market==='WB'&&x.kind==='finance').status,'waiting');assert.ok(result.sources.filter(x=>x.market==='Kaspi'||x.market==='Ozon'||x.market==='WB2').every(x=>x.status==='unknown'));
});
const script=readFileSync(new URL('../../business-dashboard-v1.js',import.meta.url),'utf8');
function fixture(){
 class Clock extends Date{constructor(...args){super(...(args.length?args:[NOW]))}static now(){return NOW}}
 const active={value:true},state={settings:{reportMarket:'Ozon'}},timers=[],box={dataset:{},querySelector(){return null}},ctx={Date:Clock,Intl,console,window:{setTimeout:(fn,ms)=>{timers.push({fn,ms});return timers.length},clearTimeout(){}},state,document:{readyState:'loading',getElementById:id=>id==='businessLoadProgress'?box:id==='reports'?{classList:{contains:()=>active.value}}:null,querySelectorAll:()=>[],addEventListener(){}},localStorage:{getItem:()=>null,setItem(){}},MILLIONER_API:'https://fixture.invalid'};
 vm.createContext(ctx);vm.runInContext(script.replace(/\}\)\(\);\s*$/,'window.api={businessSyncMarket,businessProgressInfo,businessDays,businessProgressSnapshots,businessPreparation,businessPollLoadProgress,setMetric:m=>businessMetric=m};})();'),ctx);ctx.window.api.businessSyncMarket();return{ctx,api:ctx.window.api,state,active,timers,box};
}
test('the visible counter uses actual days; a spinner cannot be created from an old heartbeat',()=>{
 const f=fixture();for(let i=0;i<7;i++)f.api.businessDays.set(TODAY-i*DAY,{data:{period:'day',bounds:{start:TODAY-i*DAY,end:TODAY+(1-i)*DAY},ordersReady:true,pending:true,summary:{revenue:null,qty:null}}});
 f.api.businessProgressSnapshots.set('Ozon',{checkedAt:NOW,sources:[{kind:'orders',market:'Ozon',status:'loading',from:GOAL}]});let info=f.api.businessProgressInfo();assert.equal(info.ready,7);assert.equal(info.total,365);assert.equal(info.state,'loading');assert.match(info.label,/7 из 365/);
 f.api.setMetric('buyouts');info=f.api.businessProgressInfo();assert.equal(info.ready,0);assert.notEqual(info.state,'ready');
 f.api.setMetric('orders');f.api.businessProgressSnapshots.set('Ozon',{checkedAt:NOW-90000,sources:[{kind:'orders',status:'loading'}]});assert.equal(f.api.businessProgressInfo().state,'unknown');
});
test('all prepared days show ready, while a saved provider cooldown shows its real retry time and reason',()=>{
 const f=fixture();for(let t=GOAL;t<=TODAY;t+=DAY)f.api.businessDays.set(t,{data:{ordersReady:true,summary:{revenue:0,qty:0}}});assert.equal(f.api.businessProgressInfo().state,'ready');f.api.businessDays.delete(GOAL);
 f.api.businessProgressSnapshots.set('Ozon',{checkedAt:NOW,sources:[{kind:'orders',market:'Ozon',status:'paused',error:'HTTP 429',nextAt:NOW+3600000}]});const info=f.api.businessProgressInfo();assert.equal(info.state,'paused');assert.match(info.detail,/429.*повтор/);assert.doesNotMatch(info.detail,/Z$/);
});
test('completed orders stay ready during finance preparation, while an unsaved-write warning remains visible',()=>{
 const f=fixture();for(let t=GOAL;t<=TODAY;t+=DAY)f.api.businessDays.set(t,{data:{ordersReady:true,pending:true,summary:{revenue:null,qty:null}}});
 f.api.businessPreparation.set(1,{active:true,at:NOW,error:'Финансовая история ещё не готова'});
 assert.equal(f.api.businessProgressInfo().state,'ready');assert.match(f.api.businessProgressInfo().detail,/финансовая часть/);
 f.api.setMetric('buyouts');assert.equal(f.api.businessProgressInfo().ready,0);assert.equal(f.api.businessProgressInfo().state,'paused');
 f.api.setMetric('orders');f.api.businessPreparation.set(1,{active:true,at:NOW,error:'Дни не сохранены: HTTP 409',saveError:true});assert.equal(f.api.businessProgressInfo().state,'paused');assert.match(f.api.businessProgressInfo().detail,/409/);
});
test('a late poll cannot show a different store or keep polling after leaving Reports',async()=>{
 const f=fixture();let resolve,requests=0;f.ctx.fetch=()=>{requests++;return new Promise(r=>{resolve=r})};const first=f.api.businessPollLoadProgress();assert.equal(f.api.businessPollLoadProgress(),first);assert.equal(requests,1);
 f.state.settings.reportMarket='WB';f.api.businessSyncMarket();resolve({ok:true,json:async()=>({ok:true,market:'Ozon',sources:[{kind:'orders',status:'loading'}]})});await first;assert.equal(f.api.businessProgressSnapshots.has('Ozon'),false);assert.equal(f.timers.length,0);
 f.ctx.fetch=async()=>{throw Error('offline')};await f.api.businessPollLoadProgress();assert.equal(f.api.businessProgressInfo().state,'unknown');assert.equal(f.timers.at(-1).ms,15000);f.active.value=false;await f.api.businessPollLoadProgress();assert.equal(f.timers.length,1);
});
