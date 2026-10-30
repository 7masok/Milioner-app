import express from 'express';
import {randomUUID} from 'node:crypto';
import {asyncRoute,noStore,requireTrustedOrigin} from './http.js';
import {requireConfiguredSession} from './auth.js';
const fail=(message,status=400)=>Object.assign(Error(message),{status});
export function adGroupInput(value={}){
 const name=String(value.name??'').trim();
 if(!name||name.length>120)throw fail('Укажите название группы до 120 символов.');
 if(!Array.isArray(value.campaignIds)||value.campaignIds.length<1||value.campaignIds.length>100)throw fail('Выберите от 1 до 100 кампаний.');
 const ids=value.campaignIds.map(Number);
 if(ids.some(n=>!Number.isSafeInteger(n)||n<1)||new Set(ids).size!==ids.length)throw fail('Проверьте выбранные кампании.');
 return {name,campaignIds:ids};
}
export function createWbAdGroups({db,snapshot,clock=Date.now}){
 const router=express.Router();router.use(noStore,requireConfiguredSession,requireTrustedOrigin);
 const market=value=>{if(!['WB','WB2'].includes(value))throw fail('Неверный магазин.');return value;};
 const groupId=value=>{if(!/^[0-9a-f-]{36}$/.test(String(value)))throw fail('Неверная группа.');return String(value);};
 async function list(m){return (await db.query(`SELECT g.id,g.name,g.version,g.updated_at::float8 AS "updatedAt",COALESCE(json_agg(m.campaign_id ORDER BY m.campaign_id) FILTER(WHERE m.campaign_id IS NOT NULL),'[]') AS "campaignIds" FROM wb_ad_groups g LEFT JOIN wb_ad_group_members m ON m.market=g.market AND m.group_id=g.id WHERE g.market=$1 GROUP BY g.market,g.id ORDER BY g.created_at,g.id`,[m])).rows;}
 async function tx(fn){const c=await db.connect();try{await c.query('BEGIN');const out=await fn(c);await c.query('COMMIT');return out;}catch(e){await c.query('ROLLBACK');if(e.code==='23505')throw fail('Одна из кампаний уже в другой группе. Обновите список.',409);throw e;}finally{c.release();}}
 async function save(m,id,body,create){
  const input=adGroupInput(body),available=new Set((await snapshot(m))?.campaigns?.map(x=>Number(x.id))||[]);
  await tx(async c=>{
   if(!create){
    if(!Number.isSafeInteger(body.version)||body.version<1)throw fail('Обновите группу перед сохранением.',409);
    const prior=(await c.query('SELECT * FROM wb_ad_groups WHERE market=$1 AND id=$2 FOR UPDATE',[m,id])).rows[0];
    if(!prior||prior.version!==body.version)throw fail('Группа уже изменена. Откройте её заново.',409);
    for(const r of (await c.query('SELECT campaign_id FROM wb_ad_group_members WHERE market=$1 AND group_id=$2',[m,id])).rows)available.add(Number(r.campaign_id));
   }
   if(input.campaignIds.some(id=>!available.has(id)))throw fail('Выбрана кампания другого магазина или отсутствующая в данных WB.');
   if(create)await c.query('INSERT INTO wb_ad_groups(market,id,name,created_at,updated_at) VALUES($1,$2,$3,$4,$4)',[m,id,input.name,clock()]);
   else await c.query('UPDATE wb_ad_groups SET name=$3,version=version+1,updated_at=$4 WHERE market=$1 AND id=$2',[m,id,input.name,clock()]);
   await c.query('DELETE FROM wb_ad_group_members WHERE market=$1 AND group_id=$2',[m,id]);
   for(const campaign of input.campaignIds)await c.query('INSERT INTO wb_ad_group_members(market,group_id,campaign_id) VALUES($1,$2,$3)',[m,id,campaign]);
  });return list(m);
 }
 router.get('/:market',asyncRoute(async(req,res)=>res.json({ok:true,groups:await list(market(req.params.market))})));
 router.post('/:market',asyncRoute(async(req,res)=>res.json({ok:true,groups:await save(market(req.params.market),randomUUID(),req.body,true)})));
 router.put('/:market/:id',asyncRoute(async(req,res)=>res.json({ok:true,groups:await save(market(req.params.market),groupId(req.params.id),req.body,false)})));
 router.delete('/:market/:id',asyncRoute(async(req,res)=>{
  const m=market(req.params.market),id=groupId(req.params.id),version=Number(req.body?.version);
  const out=await db.query('DELETE FROM wb_ad_groups WHERE market=$1 AND id=$2 AND version=$3 RETURNING id',[m,id,version]);
  if(!out.rows.length)throw fail('Группа уже изменена. Обновите список.',409);
  res.json({ok:true,groups:await list(m)});
 }));
 return {router,list};
}
