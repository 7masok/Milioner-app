import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {PGlite} from '@electric-sql/pglite';
process.env.APP_ADMIN_TOKEN='ad-groups-tests-only';
const {adGroupInput,createWbAdGroups}=await import('../src/wb-ad-groups.js');
const {createSessionToken}=await import('../src/auth.js');
const express=(await import('express')).default;
const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
const migration=readFileSync(new URL('../migrations/154_wb_ad_groups.sql',import.meta.url),'utf8');
async function fixture(){
 const db=new PGlite();await db.exec(migration);await db.exec(readFileSync(new URL('../migrations/155_wb_ad_experiments.sql',import.meta.url),'utf8'));
 const pg={query:(...a)=>db.query(...a),connect:async()=>({query:(...a)=>db.query(...a),release(){}})};
 const controller=createWbAdGroups({db:pg,snapshot:async m=>({campaigns:(m==='WB'?[1,2,3,4]:[1,5]).map(id=>({id}))})});
 const app=express();app.use(express.json());app.use('/groups',controller.router);app.use((e,req,res,next)=>res.status(e.status||500).json({error:e.message}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.on('listening',r));const base='http://127.0.0.1:'+server.address().port,headers={Origin:base,Authorization:'Bearer '+createSessionToken().token,'Content-Type':'application/json'};
 return {db,controller,base,request:async(path,method='GET',body,patch={})=>{const r=await fetch(base+'/groups/'+path,{method,headers:{...headers,...patch},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json()};},close:async()=>{await new Promise(r=>server.close(r));await db.close();}};
}
test('group validation rejects empty names, duplicate IDs and malformed selections',()=>{
 assert.deepEqual(adGroupInput({name:'  Лимон  ',campaignIds:[1,2,3]}),{name:'Лимон',campaignIds:[1,2,3]});
 for(const input of [{name:'',campaignIds:[1]},{name:'x',campaignIds:[]},{name:'x',campaignIds:[1,1]},{name:'x',campaignIds:[-1]},{name:'x',campaignIds:[1.1]}])assert.throws(()=>adGroupInput(input));
});
test('real SQL groups three campaigns, persists across controller reload and isolates WB stores',async()=>{
 const f=await fixture();try{
  const out=await f.request('WB','POST',{name:'Форма лимон',campaignIds:[1,2,3]});assert.equal(out.status,200);const g=out.data.groups[0];assert.equal(g.name,'Форма лимон');assert.deepEqual(g.campaignIds,[1,2,3]);
  const other=await f.request('WB2','POST',{name:'Другой кабинет',campaignIds:[1,5]});assert.equal(other.status,200);assert.deepEqual(other.data.groups[0].campaignIds,[1,5]);
  const reloaded=createWbAdGroups({db:f.db,snapshot:async()=>null});assert.deepEqual((await reloaded.list('WB'))[0].campaignIds,[1,2,3]);assert.equal((await f.request('WB')).data.groups.length,1);
  assert.equal((await f.request('WB','POST',{name:'Чужой ID',campaignIds:[5]})).status,400);
 }finally{await f.close();}
});
test('campaign can belong to one group; conflicts roll back edits and stale versions cannot overwrite',async()=>{
 const f=await fixture();try{
  const first=(await f.request('WB','POST',{name:'A',campaignIds:[1,2,3]})).data.groups[0];
  const second=(await f.request('WB','POST',{name:'B',campaignIds:[4]})).data.groups.find(g=>g.name==='B');
  assert.equal((await f.request('WB/'+second.id,'PUT',{name:'Не сохранить',campaignIds:[1,4],version:second.version})).status,409);
  const groups=(await f.request('WB')).data.groups;assert.equal(groups.find(g=>g.id===second.id).name,'B');assert.deepEqual(groups.find(g=>g.id===second.id).campaignIds,[4]);
  const edit=await f.request('WB/'+first.id,'PUT',{name:'Новое имя',campaignIds:[1,2],version:first.version});assert.equal(edit.status,200);
  assert.equal((await f.request('WB/'+first.id,'PUT',{name:'Старое окно',campaignIds:[1,3],version:first.version})).status,409);
  assert.equal((await f.request('WB/'+first.id,'DELETE',{version:first.version})).status,409);
  const updated=edit.data.groups.find(g=>g.id===first.id);assert.equal((await f.request('WB/'+first.id,'DELETE',{version:updated.version})).status,200);
  assert.deepEqual((await f.request('WB')).data.groups.map(g=>g.name),['B']);assert.equal((await f.db.query('SELECT * FROM wb_ad_group_members WHERE group_id=$1',[first.id])).rows.length,0);
 }finally{await f.close();}
});
test('group endpoints require session and trusted Origin without external marketplace requests',async()=>{
 const f=await fixture();try{
  assert.equal((await fetch(f.base+'/groups/WB')).status,401);
  assert.equal((await f.request('WB','POST',{name:'A',campaignIds:[1]},{Origin:'https://evil.invalid'})).status,403);
  assert.equal((await f.request('Kaspi')).status,400);
 }finally{await f.close();}
});
function extract(name){const start=html.indexOf('function '+name+'(');assert.ok(start>=0);return html.slice(start,html.indexOf('\nfunction ',start+10));}
test('group renderer keeps individual campaign cards, escapes names, filters membership and marks partial totals',()=>{
 const ctx={Set,Map,Number,adsMarket:'WB',wbAdOpenGroups:new Set(['WB:g']),adsDashboardQuery:'',adsDashboardFilter:'all',esc:x=>String(x).replaceAll('<','&lt;').replaceAll('>','&gt;'),adsNumber:String,wbAdsMoneyText:x=>x+' ₸',adsMetricsForRow:r=>r.metric};vm.createContext(ctx);vm.runInContext(extract('wbAdGroupMetric')+'\n'+extract('wbAdGroupedCards'),ctx);
 const rows=[{row:{id:1,name:'Клик',paymentType:'cpc',metric:{complete:true,spend:100,cartAdds:2}}},{row:{id:2,name:'Показы',paymentType:'cpm',metric:{complete:true,spend:200,cartAdds:3}}},{row:{id:4,name:'Вне группы',metric:{complete:true,spend:10,cartAdds:0}}}];
 const cards=new Map([[1,'CARD1'],[2,'CARD2'],[4,'CARD4']]);let out=ctx.wbAdGroupedCards(rows,cards,[{id:'g',name:'<Лимон>',campaignIds:[1,2,3]}]);
 assert.match(out,/&lt;Лимон&gt;/);assert.doesNotMatch(out,/<Лимон>/);assert.match(out,/2 из 3 кампаний/);assert.match(out,/Расход 300 ₸/);for(const text of ['CARD1','CARD2','CARD4','Без группы','Цена корзины'])assert.ok(out.includes(text));
 ctx.wbAdOpenGroups.clear();out=ctx.wbAdGroupedCards(rows,cards,[{id:'g',name:'Лимон',campaignIds:[1,2]}]);assert.match(out,/wb-ad-group-body" hidden/);
 rows[0].row.metric.complete=false;out=ctx.wbAdGroupedCards(rows,cards,[{id:'g',name:'Лимон',campaignIds:[1,2]}]);assert.match(out,/Статистика группы неполная/);
});
test('test plan endpoint is opt-in/versioned and active tests block editing/deleting the group',async()=>{
 const f=await fixture();try{
 const g=(await f.request('WB','POST',{name:'Нож777',campaignIds:[1,2,3]})).data.groups[0],path='WB/'+g.id+'/test',plan={version:0,campaignIds:[1,2,3],startDate:'2030-01-01',switchTime:'00:00',days:21,operation:'save'};
 assert.equal((await fetch(f.base+'/groups/'+path,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(plan)})).status,401);
 assert.equal((await f.request(path,'PUT',plan,{Origin:'https://evil.invalid'})).status,403);
 const saved=await f.request(path,'PUT',plan);assert.equal(saved.status,200);assert.equal(saved.data.groups[0].test.enabled,false);assert.equal((await f.request(path,'PUT',plan)).status,409);
 await f.db.query("UPDATE wb_ad_experiments SET enabled=TRUE WHERE market='WB' AND group_id=$1",[g.id]);
 assert.equal((await f.request('WB/'+g.id,'PUT',{name:'Изменить',campaignIds:[1,2],version:g.version})).status,409);
 assert.equal((await f.request('WB/'+g.id,'DELETE',{version:g.version})).status,409);
 assert.equal((await f.request('WB2')).data.groups.length,0);
 }finally{await f.close();}
});
