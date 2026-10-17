import express from 'express';
import crypto from 'node:crypto';
import { pool } from '../db.js';
import { requireConfiguredSession } from '../auth.js';
import { asyncRoute,requireTrustedOrigin } from '../http.js';
import { plannerAccounts,sourceFor,prepareDevice,hashToken } from './service.js';
import { today,validateConfiguration,configurationHash,emptyConfiguration } from './model.js';
export const plannerRouter=express.Router();
plannerRouter.use(requireTrustedOrigin);
plannerRouter.post('/pair',requireConfiguredSession,asyncRoute(async(req,res)=>{
 const accounts=await plannerAccounts(),clientId=String(req.body?.clientId||''),accountId=String(req.body?.accountId||'');
 const matches=accounts.filter(a=>(!clientId||a.clientId===clientId)&&(!accountId||a.id===accountId));
 if(matches.length!==1)return res.status(400).json({ok:false,error:matches.length?'Выбери магазин Ozon в настройках подключения':'В складе не найден Ozon с этим Client ID',accounts:accounts.map(a=>({id:a.id,label:a.label,clientId:a.clientId}))});
 const account=matches[0],configuration=validateConfiguration(req.body?.configuration||emptyConfiguration()),token=crypto.randomBytes(32).toString('base64url'),id=crypto.randomUUID(),now=Date.now();
 await pool.query(`INSERT INTO ozon_planner_devices(id,token_hash,account,client_id,configuration,config_hash,created_at,last_used_at) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$7)`,[id,hashToken(token),account.id,account.clientId,JSON.stringify(configuration),configurationHash(configuration),now]);
 res.json({ok:true,token,account:{id:account.id,label:account.label,clientId:account.clientId}});
}));
plannerRouter.use(asyncRoute(async(req,res,next)=>{
 const token=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');if(!/^[\w-]{43}$/.test(token))return res.status(401).json({ok:false,error:'Подключи сервер склада в настройках'});
 const device=(await pool.query('SELECT * FROM ozon_planner_devices WHERE token_hash=$1 AND NOT revoked',[hashToken(token)])).rows[0];
 if(!device)return res.status(401).json({ok:false,error:'Подключение отозвано. Подключи сервер заново'});
 const account=(await plannerAccounts()).find(a=>a.id===device.account&&a.clientId===device.client_id);if(!account)return res.status(401).json({ok:false,error:'Подключение Ozon изменилось в складе'});
 req.plannerDevice=device;req.plannerAccount=account;next();
}));
// APK refresh only reads PostgreSQL/recalculates local preferences. No upstream calls.
plannerRouter.post('/read',asyncRoute(async(req,res)=>{
 let device=req.plannerDevice;const source=await sourceFor(req.plannerAccount);
 if(req.body?.configuration){
  const configuration=validateConfiguration(req.body.configuration),hash=configurationHash(configuration);
  if(hash!==device.config_hash){device=(await pool.query('UPDATE ozon_planner_devices SET configuration=$2::jsonb,config_hash=$3 WHERE id=$1 AND NOT revoked RETURNING *',[device.id,JSON.stringify(configuration),hash])).rows[0];}
 }
 if(!source?.payload)return res.status(202).json({ok:true,pending:true,refreshing:true,error:source?.last_error||'',message:'Сервер загружает Ozon. Данные появятся автоматически'});
 if(!device.prepared||device.source_updated_at!==Number(source.updated_at)||device.calculated_day!==today()||device.prepared.configHash!==device.config_hash){
  // Include the configuration hash in the stored result to invalidate only changed preferences.
  device=await prepareDevice(device,source);if(!device)return res.status(409).json({ok:false,error:'Настройки изменились. Повтори обновление'});
 }
 await pool.query('UPDATE ozon_planner_devices SET last_used_at=$2 WHERE id=$1',[device.id,Date.now()]);
 res.json({ok:true,...device.prepared,revision:Number(device.revision),sourceUpdatedAt:new Date(Number(source.updated_at)).toISOString(),refreshing:Number(source.attempt_at)>Number(source.updated_at)&&!source.last_error,lastError:source.last_error||'',account:{id:req.plannerAccount.id,label:req.plannerAccount.label}});
}));
plannerRouter.delete('/device',asyncRoute(async(req,res)=>{await pool.query('UPDATE ozon_planner_devices SET revoked=TRUE WHERE id=$1',[req.plannerDevice.id]);res.json({ok:true});}));
