const DAY=86400000;
const fail=(s,status=400)=>Object.assign(Error(s),{status});
export function experimentPlan(input,members){
 const ids=Array.isArray(input.campaignIds)?input.campaignIds.map(Number):null,startDate=String(input.startDate||''),switchTime=String(input.switchTime||'00:00'),days=Number(input.days);
 if(!Array.isArray(ids)||ids.length<2||ids.length>3||new Set(ids).size!==ids.length||ids.some(x=>!Number.isSafeInteger(x)||!members.includes(x)))throw fail('Выберите 2–3 разные кампании этой группы в порядке чередования.');
 if(!/^\d{4}-\d{2}-\d{2}$/.test(startDate)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(switchTime))throw fail('Проверьте дату и время начала.');
 const startAt=Date.parse(startDate+'T'+switchTime+':00+05:00');
 if(!Number.isFinite(startAt)||new Date(startAt+5*3600000).toISOString().slice(0,10)!==startDate||!Number.isInteger(days)||days<ids.length||days>90)throw fail('Длительность — от числа кампаний до 90 дней. Проверьте дату.');
 return {campaignIds:ids,startDate,switchTime,days,startAt};
}
export function experimentSlot(plan,now=Date.now()){
 const index=Math.floor((now-plan.startAt)/DAY);
 if(index<0)return {state:'waiting',campaignId:null,nextAt:plan.startAt,day:0};
 if(index>=plan.days)return {state:'finished',campaignId:null,nextAt:0,day:plan.days};
 return {state:'running',campaignId:plan.campaignIds[index%plan.campaignIds.length],nextAt:plan.startAt+(index+1)*DAY,day:index+1};
}
// IO is injected: unit/integration tests never call WB or modify production campaigns.
export async function advanceExperiment(plan,previous,io,now,stopping=false){
 const slot=experimentSlot(plan,now),out={...previous,...slot,checkedAt:now,error:'',retryAt:0};
 if(!stopping&&slot.state==='waiting')return out;
 if(Number(previous.retryAt)>now)return previous;
 const ids=plan.campaignIds;
 const read=async()=>{const rows=await io.read(ids);const map=new Map(rows.map(r=>[Number(r.id),Number(r.status)]));if(ids.some(id=>!Number.isFinite(map.get(id))))throw fail('Не удалось подтвердить статусы всех кампаний. Переключение остановлено.');return map;};
 try{
  let live=await read();
  // Manual pause, stock, budget and stale statistics gate every automatic start.
  const reason=slot.campaignId&&!stopping?await io.gate(slot.campaignId):'';
  const wanted=!reason&&!stopping?slot.campaignId:null;
  for(const id of ids)if(id!==wanted&&live.get(id)===9)await io.action(id,'pause');
  live=await read();
  if(ids.some(id=>id!==wanted&&live.get(id)===9))throw fail('WB ещё не подтвердил паузу предыдущей кампании. Новая не запускается.');
  if(stopping||slot.state==='finished')return {...out,state:stopping?'stopped':'finished',campaignId:null};
  if(reason)return {...out,state:'blocked',error:reason};
  // An unexpected pause in WB is an opt-out, never an instruction to restart it.
  if(previous.startedCampaignId===wanted&&previous.startedDay===slot.day&&live.get(wanted)!==9)return {...out,state:'blocked',error:'Кампания поставлена на паузу вне теста. Повторного запуска сегодня не будет.'};
  if(![4,9,11].includes(live.get(wanted)))return {...out,state:'blocked',error:'Кампания завершена или недоступна для запуска.'};
  if(live.get(wanted)!==9){const gate=await io.gate(wanted);if(gate)return {...out,state:'blocked',error:gate};await io.action(wanted,'start');}
  // Persist ownership before read-back so an ambiguous response cannot cause repeated starts.
  out.startedCampaignId=wanted;out.startedDay=slot.day;
  live=await read();
  if(live.get(wanted)!==9)throw fail('WB ещё не подтвердил запуск кампании. Проверьте статус и бюджет.');
  return {...out,state:'running',confirmedAt:now};
 }catch(e){return {...out,state:'error',error:String(e.message||e).slice(0,500),retryAt:Math.max(now+60000,Number(e.retryAt)||0)};}
}
export function createAdExperiments({db,snapshot,clock=Date.now,io}){
 const view=r=>r?{version:r.version,plan:r.plan,runtime:r.runtime,enabled:r.enabled,stopping:r.stopping,updatedAt:Number(r.updated_at)}:null;
 const list=async m=>(await db.query('SELECT * FROM wb_ad_experiments WHERE market=$1',[m])).rows;
 const managedIds=async m=>new Set((await list(m)).filter(r=>r.enabled||r.stopping).flatMap(r=>r.plan?.campaignIds||[]));
 async function transaction(fn){const c=await db.connect();try{await c.query('BEGIN');const out=await fn(c);await c.query('COMMIT');return out;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
 async function change(m,id,body){if(!['save','start','stop'].includes(body?.operation))throw fail('Неверная команда плана.');return transaction(async c=>{
  const group=(await c.query('SELECT * FROM wb_ad_groups WHERE market=$1 AND id=$2 FOR UPDATE',[m,id])).rows[0];if(!group)throw fail('Группа не найдена.',404);
  const old=(await c.query('SELECT * FROM wb_ad_experiments WHERE market=$1 AND group_id=$2 FOR UPDATE',[m,id])).rows[0];
  if(Number(body.version)!==Number(old?.version||0))throw fail('План уже изменён. Откройте его заново.',409);
  if(body.operation==='stop'){
   if(!old)throw fail('План не найден.',404);
   await c.query('UPDATE wb_ad_experiments SET enabled=FALSE,stopping=$3,version=version+1,updated_at=$4 WHERE market=$1 AND group_id=$2',[m,id,Boolean(old.enabled||old.stopping),clock()]);return;
  }
  if(old?.enabled||old?.stopping)throw fail('Сначала остановите тест и дождитесь подтверждения пауз.',409);
  const members=(await c.query('SELECT campaign_id FROM wb_ad_group_members WHERE market=$1 AND group_id=$2',[m,id])).rows.map(x=>Number(x.campaign_id));
  const plan=experimentPlan(body,members),enabled=body.operation==='start';
  if(enabled){
   if(plan.startAt<clock())throw fail('Для нового запуска выберите будущее время начала.');
   if(!io)throw fail('Исполнитель теста недоступен.',503);
   const snap=await snapshot(m),byId=new Map((snap?.campaigns||[]).map(x=>[Number(x.id),x]));
   for(const cid of plan.campaignIds){const row=byId.get(cid);if(!row||![4,11].includes(Number(row.status)))throw fail('Перед запуском поставьте все кампании теста на паузу.');}
   const verified=await io.validate(m,plan.campaignIds);if(verified?.nmId)plan.nmId=String(verified.nmId);
  }
  await c.query(`INSERT INTO wb_ad_experiments(market,group_id,plan,enabled,runtime,updated_at) VALUES($1,$2,$3,$4,'{}',$5)
   ON CONFLICT(market,group_id) DO UPDATE SET plan=$3,enabled=$4,stopping=FALSE,runtime='{}',version=wb_ad_experiments.version+1,updated_at=$5`,[m,id,JSON.stringify(plan),enabled,clock()]);
 });}
 async function blockEdit(c,m,id){if((await c.query('SELECT group_id FROM wb_ad_experiments WHERE market=$1 AND group_id=$2 AND (enabled OR stopping) FOR UPDATE',[m,id])).rows.length)throw fail('Сначала остановите тест группы и дождитесь подтверждения пауз.',409);}
 async function manualAction(m,cid,action){
  await transaction(async c=>{const rows=(await c.query('SELECT * FROM wb_ad_experiments WHERE market=$1 AND (enabled OR stopping) FOR UPDATE',[m])).rows;
   for(const r of rows)if(r.plan?.campaignIds?.includes(cid)){if(action==='start')throw fail('Сначала остановите тест группы.',409);await c.query('UPDATE wb_ad_experiments SET enabled=FALSE,stopping=TRUE,version=version+1,updated_at=$3 WHERE market=$1 AND group_id=$2',[m,r.group_id,clock()]);}
  });
 }
 async function run(m){
  if(!io)return;
  for(const row of (await list(m)).filter(r=>r.enabled||r.stopping))await transaction(async c=>{
   // Same lock order as plan edits/deletion. Skip a group already processed by another worker.
   if(!(await c.query('SELECT id FROM wb_ad_groups WHERE market=$1 AND id=$2 FOR UPDATE SKIP LOCKED',[m,row.group_id])).rows.length)return;
   const r=(await c.query('SELECT * FROM wb_ad_experiments WHERE market=$1 AND group_id=$2 FOR UPDATE',[m,row.group_id])).rows[0];if(!r||(!r.enabled&&!r.stopping))return;
   const runtime=await advanceExperiment(r.plan,r.runtime,io.forMarket(m,r.plan),clock(),r.stopping);
   const history=Array.isArray(r.runtime.history)?r.runtime.history:[];if(runtime.state!==r.runtime.state||runtime.campaignId!==r.runtime.campaignId||runtime.error!==r.runtime.error)history.push({at:clock(),state:runtime.state,day:runtime.day,campaignId:runtime.campaignId,error:runtime.error||''});runtime.history=history.slice(-200);
   const finished=['finished','stopped'].includes(runtime.state);
   if(finished&&io.finish)await io.finish(m,r.plan.campaignIds);
   await c.query('UPDATE wb_ad_experiments SET runtime=$3,enabled=$4,stopping=$5,updated_at=$6 WHERE market=$1 AND group_id=$2',[m,r.group_id,JSON.stringify(runtime),finished?false:r.enabled,finished?false:r.stopping,clock()]);
  });
 }
 return {view,list,managedIds,change,blockEdit,manualAction,run};
}
