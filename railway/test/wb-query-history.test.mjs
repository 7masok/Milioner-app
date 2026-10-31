import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {queryRule,queryVerdict,queryWindows,normalizeQueryStats} from '../src/wb-query-history-model.js';
process.env.APP_ADMIN_TOKEN='query-tests-only';
const {replaceQueryWindow,QUERY_TOTALS_SQL,createWbQueryHistory}=await import('../src/wb-query-history.js');
const {createSessionToken}=await import('../src/auth.js');
const express=(await import('express')).default;
const migration=readFileSync(new URL('../migrations/153_wb_query_history.sql',import.meta.url),'utf8');
async function fixture(){const db=new PGlite();await db.exec(migration);return db;}
const row=(query,views,carts)=>({query,views,clicks:views,cartAdds:carts,orders:0,spend:12,currency:'RUB'});
async function window(db,market,from,to,rows,now=100){const job={market,campaign_id:1,nm_id:2,date_from:from};await db.query('INSERT INTO wb_query_windows(market,campaign_id,nm_id,date_from,date_to) VALUES($1,1,2,$2,$3) ON CONFLICT DO NOTHING',[market,from,to]);await db.exec('BEGIN');try{await replaceQueryWindow(db,job,rows,now);await db.exec('COMMIT');}catch(e){await db.exec('ROLLBACK');throw e;}}

test('threshold is configurable, equality passes, 99 impressions keep collecting, CPC unknown is not zero',()=>{
 const r=queryRule({minSamples:100,minCartPercent:1});
 assert.equal(queryVerdict({views:99,cartAdds:0},r).state,'collecting');
 assert.equal(queryVerdict({views:100,cartAdds:1},r).state,'good');
 assert.equal(queryVerdict({views:100,cartAdds:0},r).state,'poor');
 assert.equal(queryVerdict({views:null,clicks:101,cartAdds:0},r).state,'unknown');
 assert.equal(queryVerdict({views:null,clicks:101,cartAdds:0},queryRule({...r,basis:'clicks'})).state,'poor');
 for(const v of [{minSamples:1.5},{minSamples:0},{minCartPercent:NaN},{basis:'other'}])assert.throws(()=>queryRule(v));
 assert.equal(queryRule().autoExclude,false);
});
test('segments have no overlaps or gaps across month/year/leap day and stay inside 7 days',()=>{
 const windows=queryWindows('2026-01-17','2026-03-04');assert.equal(windows[0].from,'2026-01-17');assert.equal(windows.at(-1).to,'2026-03-04');
 for(let i=0;i<windows.length;i++){const w=windows[i];assert.ok(Date.parse(w.to)-Date.parse(w.from)<=6*86400000);if(i)assert.equal(Date.parse(w.from)-Date.parse(windows[i-1].to),86400000);}
 assert.equal(queryWindows('2024-02-27','2024-03-02')[0].to,'2024-03-02');
});
test('malformed or missing campaign data cannot erase history; legitimate empty matched group is accepted',()=>{
 assert.throws(()=>normalizeQueryStats({stats:[]},1,2));assert.throws(()=>normalizeQueryStats({stats:[{advert_id:1,nm_id:2,stats:[{norm_query:'x',views:-1}]}]},1,2));
 assert.deepEqual(normalizeQueryStats({stats:[{advert_id:1,nm_id:2,stats:[]}]},1,2),[]);
 const out=normalizeQueryStats({stats:[{advert_id:1,nm_id:2,stats:[{norm_query:'x',views:null,clicks:100,atbs:1,orders:0,spend:10,currency:'RUB'}]}]},1,2);assert.equal(out[0].views,null);assert.equal(out[0].cartAdds,1);
});
test('real SQL retains sub-100 history across months, updates without double counting and isolates stores',async()=>{
 const db=await fixture();try{
  await window(db,'WB','2026-10-25','2026-10-31',[row('лимон',60,0)]);
  await window(db,'WB','2026-11-01','2026-11-07',[row('лимон',50,1)]);
  await window(db,'WB2','2026-11-01','2026-11-07',[row('лимон',900,90)]);
  let totals=(await db.query(QUERY_TOTALS_SQL,['WB',1])).rows;assert.equal(totals[0].views,110);assert.equal(totals[0].cartAdds,1);assert.equal(queryVerdict(totals[0],queryRule()).state,'poor');
  await window(db,'WB','2026-11-01','2026-11-07',[row('лимон',50,1)]);assert.equal((await db.query(QUERY_TOTALS_SQL,['WB',1])).rows[0].views,110);
  await window(db,'WB','2026-11-01','2026-11-07',[row('лимон',51,2)]);totals=(await db.query(QUERY_TOTALS_SQL,['WB',1])).rows;assert.equal(totals[0].views,111);assert.equal(totals[0].cartAdds,2);assert.equal((await db.query(QUERY_TOTALS_SQL,['WB2',1])).rows[0].views,900);
  await window(db,'WB','2026-11-08','2026-11-14',[row('лимон',null,1)]);assert.equal((await db.query(QUERY_TOTALS_SQL,['WB',1])).rows[0].views,null);
 }finally{await db.close();}
});
test('persistent endpoint slot is atomic and survives service recreation; history source begins only on save',async()=>{
 const db=await fixture();let calls=0;const now=Date.parse('2026-10-30T12:00:00Z'),pg={query:(...a)=>db.query(...a),connect:async()=>({query:(...a)=>db.query(...a),release(){}})};
 const factory=()=>createWbQueryHistory({db:pg,clock:()=>now,tokenFor:async()=> 'test-token',snapshot:async()=>({campaigns:[{id:1,nmIds:[2]}]}),request:async()=>{calls++;return {stats:[{advert_id:1,nm_id:2,stats:[{norm_query:'x',views:60,clicks:2,atbs:1,orders:0}]}]};}});
 const app=express();app.use(express.json());app.use('/q',factory().router);app.use((e,req,res,next)=>res.status(e.status||500).json({error:e.message}));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.on('listening',r));const url='http://127.0.0.1:'+server.address().port,headers={Origin:url,Authorization:'Bearer '+createSessionToken().token,'Content-Type':'application/json'};
 try{
  assert.equal((await fetch(url+'/q/WB/1')).status,401);
  assert.equal((await fetch(url+'/q/WB/1',{headers})).status,200);assert.equal(calls,0);assert.equal((await db.query('SELECT * FROM wb_query_sources')).rows.length,0);
  const save=await fetch(url+'/q/WB/1',{headers,method:'PUT',body:JSON.stringify({minSamples:100,minCartPercent:2,basis:'views'})});assert.equal(save.status,200);assert.equal((await save.json()).rule.minCartPercent,2);
  await factory().tick();assert.equal(calls,1);await factory().tick();assert.equal(calls,1);
  const data=await (await fetch(url+'/q/WB/1',{headers})).json();assert.equal(data.rows[0].views,60);assert.equal(data.rows[0].state,'collecting');assert.equal(data.history.dateFrom,'2026-10-01');
  await db.query("INSERT INTO wb_query_exclusions(market,campaign_id,nm_id,query,source,updated_at) VALUES('WB',1,2,'x','auto',$1)",[now]);
  await fetch(url+'/q/WB/1',{headers,method:'PUT',body:JSON.stringify({minSamples:100,minCartPercent:2,basis:'views',autoExclude:false})});
  assert.equal((await db.query('SELECT state FROM wb_query_exclusions')).rows[0].state,'cancelled');
  assert.equal((await fetch(url+'/q/WB/1',{headers:{...headers,Origin:'https://evil.invalid'},method:'PUT',body:'{}'})).status,403);
 }finally{await new Promise(r=>server.close(r));await db.close();}
});

test('exclusion preserves existing minus phrases, waits for WB read-back and resumes safely after restart',async()=>{
 const db=await fixture();let now=Date.parse('2026-10-30T12:00:00Z'),minus=['старый запрос'],posts=0,reads=0;
 const pg={query:(...a)=>db.query(...a),connect:async()=>({query:(...a)=>db.query(...a),release(){}})};
 const factory=()=>createWbQueryHistory({db:pg,clock:()=>now,tokenFor:async()=> 'same-token',snapshot:async()=>({campaigns:[]}),request:async(url,token,opts)=>{
  if(url.endsWith('/get-minus')){reads++;return {items:[{advert_id:1,nm_id:2,norm_queries:[...minus]}]};}
  if(url.endsWith('/set-minus')){posts++;minus=opts.body.norm_queries;return {};}
  throw Error('Unexpected request');
 }});
 try{
  await db.query("INSERT INTO wb_query_exclusions(market,campaign_id,nm_id,query,updated_at) VALUES('WB',1,2,'плохой запрос',$1)",[now]);
  await factory().tick();assert.equal(posts,1);assert.deepEqual(minus,['старый запрос','плохой запрос']);assert.equal((await db.query('SELECT state FROM wb_query_exclusions')).rows[0].state,'checking');
  await factory().tick();assert.equal(reads,1);assert.equal(posts,1);
  now+=13*60*1000;await factory().tick();assert.equal(reads,2);assert.equal(posts,1);assert.equal((await db.query('SELECT state FROM wb_query_exclusions')).rows[0].state,'confirmed');
 }finally{await db.close();}
});
test('429 extends persistent cooldown and partial replacement rolls back instead of losing old history',async()=>{
 const db=await fixture();const now=Date.parse('2026-10-30T12:00:00Z');let calls=0;
 const pg={query:(...a)=>db.query(...a),connect:async()=>({query:(...a)=>db.query(...a),release(){}})};
 try{
  await window(db,'WB','2026-10-25','2026-10-30',[row('сохранённый',60,1)],now);
  await assert.rejects(window(db,'WB','2026-10-25','2026-10-30',[row('новый',10,0),row(null,1,0)],now));
  assert.equal((await db.query(QUERY_TOTALS_SQL,['WB',1])).rows[0].views,60);
  await db.query("INSERT INTO wb_query_exclusions(market,campaign_id,nm_id,query,updated_at) VALUES('WB',1,2,'сохранённый',$1)",[now]);
  const c=createWbQueryHistory({db:pg,clock:()=>now,tokenFor:async()=> 'retry-token',snapshot:async()=>null,request:async()=>{calls++;throw Object.assign(Error('Rate limit'),{status:429,retryAt:now+3600000});}});
  await c.tick();assert.equal(calls,1);assert.equal(Number((await db.query('SELECT next_at FROM wb_query_cooldowns')).rows[0].next_at),now+3600000);
 }finally{await db.close();}
});


test('automatic exclusion requires full fresh stats, minimum samples and zero known orders',async()=>{
 const db=await fixture();const now=Date.parse('2026-10-30T12:00:00Z');let sent=[];
 const pg={query:(...a)=>db.query(...a),connect:async()=>({query:(...a)=>db.query(...a),release(){}})};
 try{
  await window(db,'WB','2026-10-25','2026-10-30',[row('без корзин',100,0),{...row('с заказом',100,0),orders:1},row('мало показов',99,0),row('неизвестные показы',null,0)],now);
  await db.query("INSERT INTO wb_query_rules(market,campaign_id,rule,updated_at) VALUES('WB',1,$1::jsonb,$2)",[JSON.stringify(queryRule({autoExclude:true})),now]);
  const controller=createWbQueryHistory({db:pg,clock:()=>now,tokenFor:async()=> 'auto-token',snapshot:async()=>null,request:async(url,token,opts)=>{
   if(url.endsWith('/get-minus'))return {items:[{advert_id:1,nm_id:2,norm_queries:['уже исключён']} ]};
   if(url.endsWith('/set-minus')){sent=opts.body.norm_queries;return {};}
   throw Error('Unexpected request');
  }});
  await controller.tick();assert.deepEqual(sent,['уже исключён','без корзин']);const rows=(await db.query('SELECT query,state,source FROM wb_query_exclusions')).rows;assert.equal(rows.length,1);assert.equal(rows[0].query,'без корзин');assert.equal(rows[0].source,'auto');assert.equal(rows[0].state,'checking');
 }finally{await db.close();}
});

test('opening collection tracks idempotently without saving rules or applying exclusions; newest segment loads first',async()=>{
 const db=await fixture(),now=Date.parse('2026-11-01T12:00:00Z'),tasks=[],calls=[];
 const pg={query:(...a)=>db.query(...a),connect:async()=>({query:(...a)=>db.query(...a),release(){}})};
 const controller=createWbQueryHistory({db:pg,clock:()=>now,schedule:fn=>tasks.push(fn),tokenFor:async()=> 'read-only-test-token',snapshot:async()=>({campaigns:[{id:1,nmIds:[2]}]}),request:async(url,token,opts)=>{calls.push({url,body:opts.body});assert.ok(url.endsWith('/normquery/stats'));return {stats:[{advert_id:1,nm_id:2,stats:[{norm_query:'кольцо нож',views:12,clicks:1,atbs:0,orders:0}]}]};}});
 const app=express();app.use(express.json());app.use('/q',controller.router);app.use((e,req,res,next)=>res.status(e.status||500).json({error:e.message}));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.on('listening',r));const url='http://127.0.0.1:'+server.address().port,headers={Origin:url,Authorization:'Bearer '+createSessionToken().token,'Content-Type':'application/json'};
 try{
  const call=(path,patch={})=>fetch(url+'/q/'+path,{method:'POST',headers:{...headers,...patch},body:'{}'});
  assert.equal((await fetch(url+'/q/WB/1/collect',{method:'POST'})).status,401);
  assert.equal((await call('WB/1/collect',{Origin:'https://evil.invalid'})).status,403);
  const r=await call('WB/1/collect');assert.equal(r.status,200);assert.equal((await r.json()).tracked,true);assert.equal(calls.length,0);
  assert.equal((await db.query('SELECT * FROM wb_query_rules')).rows.length,0);assert.equal((await db.query('SELECT * FROM wb_query_sources')).rows.length,1);
  await db.query("INSERT INTO wb_query_exclusions(market,campaign_id,nm_id,query,updated_at) VALUES('WB',1,2,'уже в очереди',$1)",[now]);
  await tasks.shift()();assert.equal(calls.length,1);assert.equal(calls[0].body.to,'2026-11-01');assert.ok(calls[0].body.from>'2026-10-20');
  let data=await (await fetch(url+'/q/WB/1',{headers})).json();assert.equal(data.rows[0].query,'кольцо нож');assert.equal(data.rows[0].state,'collecting');assert.equal(data.rule.autoExclude,false);
  assert.equal((await db.query('SELECT state FROM wb_query_exclusions')).rows[0].state,'pending');
  assert.equal((await call('WB/1/collect')).status,200);assert.equal((await db.query('SELECT * FROM wb_query_sources')).rows.length,1);await tasks.shift()();assert.equal(calls.length,1);
  const custom=queryRule({basis:'clicks',minSamples:222,minCartPercent:3,autoExclude:true});await db.query("INSERT INTO wb_query_rules(market,campaign_id,rule,updated_at) VALUES('WB',1,$1::jsonb,$2)",[JSON.stringify(custom),now]);
  assert.equal((await call('WB/1/collect')).status,200);data=await (await fetch(url+'/q/WB/1',{headers})).json();assert.deepEqual(data.rule,custom);
 }finally{await new Promise(r=>server.close(r));await db.close();}
});

test('opening the panel starts collection automatically but does not overwrite edits or enable automation',async()=>{
 const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8'),start=html.indexOf('async function openWbQueryHistory('),end=html.indexOf('\nfunction scheduleWbQueryPoll(',start),source=html.slice(start,end);
 for(const tracked of [false,true]){
  const calls=[],box={},saved={tracked,rule:{autoExclude:false,minSamples:100},rows:[]};let paints=0,polls=0;
  const ctx={wbQueryPollTimer:0,wbQueryRequest:0,wbQueryView:null,adsMarket:'WB2',clearTimeout(){},showSheet(){},document:{getElementById:id=>id==='wbQueryPanel'?box:null},paintWbQueryHistory:()=>paints++,scheduleWbQueryPoll:()=>polls++,adsApi:async(path,options)=>{calls.push({path,options});if(options){box.oninput({target:{id:'wbQueryMinimum'}});return {...saved,tracked:true};}return saved;}};
  vm.createContext(ctx);vm.runInContext(source,ctx);await ctx.openWbQueryHistory(777);
  assert.equal(calls.length,tracked?1:2);assert.equal(paints,1);assert.equal(polls,1);assert.equal(ctx.wbQueryView.data.rule.autoExclude,false);
  if(!tracked){assert.equal(calls[1].path,'/api/promotion/queries/WB2/777/collect');assert.equal(calls[1].options.method,'POST');assert.equal(ctx.wbQueryView.dirty,true);}
 }
});
