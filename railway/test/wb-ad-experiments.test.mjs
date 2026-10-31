import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {PGlite} from '@electric-sql/pglite';
import {experimentPlan,experimentSlot,advanceExperiment,createAdExperiments} from '../src/wb-ad-experiments.js';
const input={campaignIds:[1,2,3],startDate:'2026-11-02',switchTime:'00:00',days:21};
const plan=experimentPlan(input,[1,2,3]),DAY=86400000;
function ioFixture(initial={1:11,2:11,3:11}){const status=new Map(Object.entries(initial).map(([a,b])=>[Number(a),b])),calls=[];let gate='';const io={read:async ids=>ids.filter(x=>status.has(x)).map(id=>({id,status:status.get(id)})),gate:async()=>gate,action:async(id,action)=>{calls.push([id,action]);status.set(id,action==='start'?9:11);}};return {io,status,calls,setGate:s=>gate=s};}
test('plan validation and Almaty boundaries rotate 3 campaigns across 21 days and stop at the end',()=>{
 assert.equal(plan.startAt,Date.parse('2026-11-01T19:00:00Z'));assert.equal(experimentSlot(plan,plan.startAt-1).state,'waiting');
 for(let i=0;i<21;i++){const slot=experimentSlot(plan,plan.startAt+i*DAY);assert.equal(slot.day,i+1);assert.equal(slot.campaignId,[1,2,3][i%3]);}
 assert.equal(experimentSlot(plan,plan.startAt+21*DAY).state,'finished');
 for(const bad of [{campaignIds:[1,1]},{campaignIds:[1,4]},{campaignIds:[1]},{days:91},{days:1},{startDate:'2026-02-30'},{switchTime:'25:00'}])assert.throws(()=>experimentPlan({...input,...bad},[1,2,3]));
});
test('a future plan causes no marketplace calls; repeated checks do not repeat a start',async()=>{
 const f=ioFixture();let r=await advanceExperiment(plan,{},f.io,plan.startAt-1);assert.equal(f.calls.length,0);
 r=await advanceExperiment(plan,r,f.io,plan.startAt);assert.equal(r.state,'running');assert.deepEqual(f.calls,[[1,'start']]);
 r=await advanceExperiment(plan,r,f.io,plan.startAt+60000);assert.equal(r.state,'running');assert.equal(f.calls.length,1);
 r=await advanceExperiment(plan,r,f.io,plan.startAt+DAY);assert.deepEqual(f.calls.slice(1),[[1,'pause'],[2,'start']]);assert.equal(r.campaignId,2);
});
test('pause confirmation precedes a start; missing/ended campaigns and rate limits never lead to an unsafe start',async()=>{
 const f=ioFixture({1:9,2:11,3:11});f.io.action=async(id,a)=>{f.calls.push([id,a]);};
 const r=await advanceExperiment(plan,{},f.io,plan.startAt+DAY);assert.equal(r.state,'error');assert.deepEqual(f.calls,[[1,'pause']]);
 const missing=ioFixture();missing.status.delete(3);assert.equal((await advanceExperiment(plan,{},missing.io,plan.startAt)).state,'error');assert.equal(missing.calls.length,0);
 const ended=ioFixture({1:7,2:11,3:11});assert.equal((await advanceExperiment(plan,{},ended.io,plan.startAt)).state,'blocked');assert.equal(ended.calls.length,0);
 const limited=ioFixture({1:9,2:11,3:11});limited.io.action=async()=>{throw Object.assign(Error('WB 429'),{retryAt:plan.startAt+DAY+3600000});};
 const e=await advanceExperiment(plan,{},limited.io,plan.startAt+DAY);assert.equal(e.state,'error');assert.equal(e.retryAt,plan.startAt+DAY+3600000);
 let reads=0;limited.io.read=async()=>{reads++;return [];};await advanceExperiment(plan,e,limited.io,plan.startAt+DAY+60000);assert.equal(reads,0);
});
test('stock/budget/manual gates stop the current campaign without starting another; unexpected WB pause is not reversed',async()=>{
 const f=ioFixture({1:9,2:11,3:11});f.setGate('Нет остатка');let r=await advanceExperiment(plan,{},f.io,plan.startAt);assert.equal(r.state,'blocked');assert.deepEqual(f.calls,[[1,'pause']]);
 const g=ioFixture();r=await advanceExperiment(plan,{},g.io,plan.startAt);g.status.set(1,11);r=await advanceExperiment(plan,r,g.io,plan.startAt+60000);assert.equal(r.state,'blocked');assert.equal(g.calls.length,1);
});
test('stop and end pause every active owned campaign and wait for readback before finishing',async()=>{
 const f=ioFixture({1:9,2:9,3:11});let r=await advanceExperiment(plan,{},f.io,plan.startAt+60000,true);assert.equal(r.state,'stopped');assert.deepEqual(f.calls,[[1,'pause'],[2,'pause']]);
 const e=ioFixture({1:11,2:9,3:11});r=await advanceExperiment(plan,{},e.io,plan.startAt+21*DAY);assert.equal(r.state,'finished');assert.deepEqual(e.calls,[[2,'pause']]);
});
async function sqlFixture(){const pg=new PGlite();for(const p of ['154_wb_ad_groups.sql','155_wb_ad_experiments.sql'])await pg.exec(fs.readFileSync(new URL('../migrations/'+p,import.meta.url),'utf8'));const db={query:(...a)=>pg.query(...a),connect:async()=>({query:(...a)=>pg.query(...a),release(){}})};const id='00000000-0000-0000-0000-000000000001';await pg.query("INSERT INTO wb_ad_groups(market,id,name,created_at,updated_at) VALUES('WB2',$1,'Нож777',1,1)",[id]);for(const cid of [1,2,3])await pg.query("INSERT INTO wb_ad_group_members VALUES('WB2',$1,$2)",[id,cid]);const f=ioFixture();let validates=0;const api=createAdExperiments({db,snapshot:async()=>({campaigns:[1,2,3].map(id=>({id,status:11}))}),clock:()=>plan.startAt-60000,io:{validate:async()=>{validates++;},forMarket:()=>f.io}});return {pg,db,id,api,f,validates:()=>validates};}
test('real SQL draft persists without actions, activation is explicit/versioned and blocks group edits/manual starts',async()=>{
 const f=await sqlFixture();try{
 await f.api.change('WB2',f.id,{...input,version:0,operation:'save'});let r=(await f.api.list('WB2'))[0];assert.equal(r.enabled,false);assert.equal(f.validates(),0);await f.api.run('WB2');assert.equal(f.f.calls.length,0);
 assert.equal((await f.api.list('WB')).length,0);
 await assert.rejects(()=>f.api.change('WB2',f.id,{...input,version:0,operation:'start'}),/уже изменён/);
 await f.api.change('WB2',f.id,{...input,version:r.version,operation:'start'});r=(await f.api.list('WB2'))[0];assert.equal(r.enabled,true);assert.equal(f.validates(),1);assert.deepEqual([...(await f.api.managedIds('WB2'))],[1,2,3]);
 await assert.rejects(()=>f.api.blockEdit(f.db,'WB2',f.id),/остановите тест/);await assert.rejects(()=>f.api.manualAction('WB2',1,'start'),/остановите тест/);
 await f.api.manualAction('WB2',1,'pause');r=(await f.api.list('WB2'))[0];assert.equal(r.enabled,false);assert.equal(r.stopping,true);
 await f.api.run('WB2');r=(await f.api.list('WB2'))[0];assert.equal(r.stopping,false);assert.equal(r.runtime.state,'stopped');await f.api.blockEdit(f.db,'WB2',f.id);
 }finally{await f.pg.close();}
});
const html=fs.readFileSync(new URL('../../index.html',import.meta.url),'utf8');
function fn(n){const a=html.indexOf('function '+n+'(');return html.slice(a,html.indexOf('\n}',a)+2);}
test('freshness tolerates a normal 15-minute cycle and distinguishes WB retry from partial data',()=>{
 const ctx={Date,Number,Boolean,esc:String};vm.createContext(ctx);vm.runInContext(fn('adsFreshnessHtml'),ctx);const now=Date.parse('2026-11-01T00:00:00Z'),d={updatedAt:now-16*60000,campaigns:[]};assert.doesNotMatch(ctx.adsFreshnessHtml(d,now),/ad-warning/);assert.match(ctx.adsFreshnessHtml({...d,updatedAt:now-21*60000},now),/старше 20/);assert.match(ctx.adsFreshnessHtml({...d,nextAttemptAt:now+60000,lastError:'HTTP 429'},now),/ограничил запросы/);assert.match(ctx.adsFreshnessHtml({...d,lastError:'timeout'},now),/Часть статистики/);
});
test('a restarted SQL worker continues the saved rotation and persists confirmation/history',async()=>{
 const f=await sqlFixture();try{
 await f.api.change('WB2',f.id,{...input,version:0,operation:'start'});
 let now=plan.startAt;const worker=()=>createAdExperiments({db:f.db,snapshot:async()=>null,clock:()=>now,io:{forMarket:()=>f.f.io}});
 await worker().run('WB2');let r=(await f.api.list('WB2'))[0];assert.equal(r.runtime.state,'running');assert.equal(r.runtime.campaignId,1);assert.equal(r.runtime.history.length,1);
 now+=DAY;await worker().run('WB2');r=(await f.api.list('WB2'))[0];assert.equal(r.runtime.campaignId,2);assert.deepEqual(f.f.calls,[[1,'start'],[1,'pause'],[2,'start']]);assert.equal(r.runtime.history.length,2);
 }finally{await f.pg.close();}
});
test('test form and preview render three named slots, escape names and show the first seven days',()=>{
 const extract=n=>{const i=html.indexOf('function '+n+'('),end=html.slice(i+10).search(/\n(?:async )?function |\n(?:let|const) /);return html.slice(i,end<0?undefined:i+10+end);};
 let sheet='';const fields={wbTestCampaign0:{value:'1'},wbTestCampaign1:{value:'2'},wbTestCampaign2:{value:'3'},wbTestDate:{value:'2026-11-02'},wbTestTime:{value:'00:00'},wbTestDays:{value:'21'},wbTestPreview:{}};
 const ctx={Date,Number,String,Set,Math,wbAdTestEditor:null,adsMarket:'WB2',adsDashboardData:{campaigns:[1,2,3].map(id=>({id,name:'<Нож> '+id})),groups:[{id:'g',name:'<Нож777>',campaignIds:[1,2,3]}]},esc:x=>String(x).replaceAll('<','&lt;').replaceAll('>','&gt;'),showSheet:s=>sheet=s,document:{getElementById:n=>fields[n]}};
 vm.createContext(ctx);vm.runInContext(['wbAdTestStatus','openWbAdTest','rHistory','wbAdTestInput','previewWbAdTest'].map(extract).join('\n'),ctx);ctx.openWbAdTest('g');assert.match(sheet,/&lt;Нож777&gt;/);assert.doesNotMatch(sheet,/<Нож777>/);for(let i=0;i<3;i++)assert.ok(sheet.includes('id="wbTestCampaign'+i+'"'));assert.match(sheet,/Включить тест/);assert.equal(ctx.previewWbAdTest(),true);assert.match(fields.wbTestPreview.innerHTML,/Первые 7 дней/);fields.wbTestCampaign2.value='2';assert.equal(ctx.previewWbAdTest(),false);
});
