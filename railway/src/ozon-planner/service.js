import crypto from 'node:crypto';
import { pool } from '../db.js';
import { credentialFor } from '../connections.js';
import { config } from '../config.js';
import { collectSnapshot, createOzonReader } from './collector.js';
import { buildPrepared, today, configurationHash } from './model.js';

export async function plannerAccounts(){
 const rows=(await pool.query("SELECT id,label FROM marketplace_credentials WHERE provider='OZON' AND enabled=1 AND encrypted_token IS NOT NULL ORDER BY created_at,id")).rows,result=[];
 for(const row of rows){try{const credentials=JSON.parse(await credentialFor(row.id));if(credentials.clientId&&credentials.apiKey)result.push({...row,clientId:String(credentials.clientId),credentials});}catch{}}
 return result;
}
export async function sourceFor(account){return (await pool.query('SELECT * FROM ozon_planner_sources WHERE account=$1 AND client_id=$2',[account.id,account.clientId])).rows[0]||null;}
export async function prepareDevice(device,source){
 const config=typeof device.configuration==='string'?JSON.parse(device.configuration):device.configuration;
 const prepared=buildPrepared(config,source?.payload,device.prepared?.state||{}),sourceAt=Number(source?.updated_at||0);
 const result=await pool.query(`UPDATE ozon_planner_devices SET prepared=$2::jsonb,source_updated_at=$3,calculated_day=$4,revision=revision+1 WHERE id=$1 AND config_hash=$5 AND NOT revoked RETURNING *`,[device.id,JSON.stringify(prepared),sourceAt,prepared.calculatedDay,configurationHash(config)]);
 return result.rows[0]||null;
}
let running=null;
async function run(){
 if(!config.adminToken)return;
 for(const account of await plannerAccounts()){
  const lock=await pool.connect();let locked=false;
  try{
   locked=!!(await lock.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked',['ozon-planner:'+account.id])).rows[0]?.locked;if(!locked)continue;
   const source=await sourceFor(account);if(Number(source?.next_allowed_at||0)>Date.now())continue;
   await pool.query(`INSERT INTO ozon_planner_sources(account,client_id,attempt_at,next_allowed_at) VALUES($1,$2,$3,$4) ON CONFLICT(account) DO UPDATE SET client_id=EXCLUDED.client_id,payload=CASE WHEN ozon_planner_sources.client_id=EXCLUDED.client_id THEN ozon_planner_sources.payload ELSE NULL END,updated_at=CASE WHEN ozon_planner_sources.client_id=EXCLUDED.client_id THEN ozon_planner_sources.updated_at ELSE 0 END,attempt_at=EXCLUDED.attempt_at,next_allowed_at=EXCLUDED.next_allowed_at`,[account.id,account.clientId,Date.now(),Date.now()+15*60000]);
   console.info('Ozon planner refresh started',account.id);
   const entries=(await pool.query('SELECT supply_id,payload FROM ozon_planner_bundles WHERE account=$1 AND client_id=$2',[account.id,account.clientId])).rows,cache=new Map(entries.map(r=>[r.supply_id,r.payload]));
   const configs=(await pool.query('SELECT configuration FROM ozon_planner_devices WHERE account=$1 AND client_id=$2 AND NOT revoked',[account.id,account.clientId])).rows;
   const extraSkus=configs.flatMap(r=>[...(r.configuration.itemOptions||[]),...(r.configuration.manualItems||[])]);
   const payload=await collectSnapshot(createOzonReader(account.credentials),{previous:source?.payload,cache,extraSkus,today:today(),saveBundle:async(supplyId,entry)=>pool.query(`INSERT INTO ozon_planner_bundles(account,client_id,supply_id,payload) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(account,client_id,supply_id) DO UPDATE SET payload=EXCLUDED.payload`,[account.id,account.clientId,supplyId,JSON.stringify(entry)])});
   const stamp=Date.parse(payload.updatedAt);
   await pool.query('UPDATE ozon_planner_sources SET payload=$2::jsonb,updated_at=$3,next_allowed_at=$4,last_error=$5 WHERE account=$1 AND client_id=$6',[account.id,JSON.stringify(payload),stamp,stamp+15*60000,'',account.clientId]);
   const devices=(await pool.query('SELECT * FROM ozon_planner_devices WHERE account=$1 AND client_id=$2 AND NOT revoked',[account.id,account.clientId])).rows;
   for(const device of devices)await prepareDevice(device,{payload,updated_at:stamp});
   console.info('Ozon planner snapshot ready',JSON.stringify({account:account.id,stocks:payload.rows.length,supplies:payload.supplies.length,downloaded:payload.compositionSync.downloaded,reused:payload.compositionSync.reused,seconds:payload.compositionSync.seconds}));
  }catch(error){
   const message=String(error.message||'Ошибка обновления Ozon').replaceAll(account.credentials.apiKey,'[hidden]').replaceAll(account.credentials.clientId,'[hidden]').slice(0,500);
   await pool.query('UPDATE ozon_planner_sources SET next_allowed_at=$2,last_error=$3 WHERE account=$1 AND client_id=$4',[account.id,Math.max(Date.now()+2*60000,Number(error.retryAt||0)),message,account.clientId]).catch(()=>{});
   console.warn('Ozon planner refresh failed',account.id,message);
  }finally{if(locked)await lock.query('SELECT pg_advisory_unlock(hashtext($1))',['ozon-planner:'+account.id]).catch(()=>{});lock.release();}
 }
}
export function syncPlanner(){if(!running)running=run().finally(()=>{running=null;});return running;}
export function startPlannerLoop(){const tick=()=>syncPlanner().catch(()=>console.warn('Ozon planner loop unavailable'));setTimeout(tick,12000).unref();setInterval(tick,60000).unref();}
export const hashToken=token=>crypto.createHash('sha256').update(token).digest('hex');
