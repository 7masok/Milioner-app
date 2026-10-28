import express from 'express';
import {pool} from '../db.js';
import {requireConfiguredSession} from '../auth.js';
import {asyncRoute,requireTrustedOrigin} from '../http.js';
import {plannerAccounts,sourceFor} from './service.js';
import {buildPrepared,emptyConfiguration,validateConfiguration,displayPlannerState,today} from './model.js';

export function dashboardConfiguration(saved,input={}){
 const config=saved?validateConfiguration(saved):{...emptyConfiguration(),settings:{cover:14,safety:5,ozonFloor:false}};
 const settings={...config.settings};
 if(input.cover!==undefined)settings.cover=input.cover;
 if(input.safety!==undefined)settings.safety=input.safety;
 const routes=Array.isArray(input.routes)?input.routes:[];
 if(input.routes!==undefined&&(!Array.isArray(input.routes)||routes.length>200))throw Object.assign(Error('Некорректные сроки доставки'),{status:400});
 const overrides=routes.map(r=>{if(!r||typeof r.cluster!=='string'||r.cluster.length>300||!r.cluster.trim()||['prepare','travel','accept'].some(k=>!Number.isInteger(r[k])||r[k]<0||r[k]>365))throw Object.assign(Error('Сроки доставки: целые дни от 0 до 365'),{status:400});return{cluster:r.cluster,prepare:r.prepare,travel:r.travel,accept:r.accept,source:'Сценарий склада'}});
 return validateConfiguration({...config,settings,routes:[...overrides,...config.routes.filter(r=>!overrides.some(x=>x.cluster===r.cluster))]});
}
export function buildDashboard(source,device,input={}){
 const config=dashboardConfiguration(device?.configuration,input),prepared=buildPrepared(config,source.payload,device?.prepared?.state||{}),view=displayPlannerState(prepared.state);
 const plans=prepared.plans.map(p=>{const route=view.routes.find(r=>r.source!=='Ozon planned'&&r.cluster===p.item.cluster)||view.routes.find(r=>p.item.clusterId&&String(r.clusterId)===String(p.item.clusterId)||r.cluster===p.item.cluster);return{...p,route:route?{prepare:route.prepare??0,travel:route.travel??0,accept:route.accept??0,source:route.source||'Настройки приложения',label:route.label||''}:null}});
 return {calculatedDay:prepared.calculatedDay,settings:config.settings,plans,shipments:view.shipments,productNames:config.productNames,hasAppConfiguration:!!device,scenario:input.cover!==undefined||input.safety!==undefined||!!input.routes?.length,sourceUpdatedAt:new Date(Number(source.updated_at)).toISOString(),lastError:source.last_error?'Последнее обновление Ozon завершилось ошибкой; показан сохранённый снимок.':'',refreshing:Number(source.attempt_at)>Number(source.updated_at)&&!source.last_error,mappingWarning:source.payload.mappingWarning?'Часть направлений требует проверки сопоставления кластеров.':'',compositionSync:source.payload.compositionSync||null};
}
// Warehouse sessions read only the cached planner snapshot. No device pairing,
// marketplace refresh, supply creation or warehouse movements are performed here.
export function createFboDashboardRouter({db=pool,accounts=plannerAccounts,readSource=sourceFor}={}){
 const router=express.Router();router.use(requireTrustedOrigin,requireConfiguredSession);
 router.post('/read',asyncRoute(async(req,res)=>{
  const account=(await accounts())[0];if(!account)return res.json({ok:true,configured:false,message:'Подключите магазин Ozon в настройках склада.'});
  const source=await readSource(account);
  if(!source?.payload)return res.status(202).json({ok:true,configured:true,pending:true,account:{label:account.label||'Ozon'},message:'Сервер ещё готовит остатки и поставки Ozon. Повторите обновление позже.'});
  const device=(await db.query('SELECT configuration,prepared FROM ozon_planner_devices WHERE account=$1 AND client_id=$2 AND NOT revoked ORDER BY last_used_at DESC,created_at DESC,id LIMIT 1',[account.id,account.clientId])).rows[0];
  const configuration=typeof device?.configuration==='string'?JSON.parse(device.configuration):device?.configuration;
  res.json({ok:true,configured:true,account:{label:account.label||'Ozon'},...buildDashboard(source,device?{...device,configuration}:null,req.body||{})});
 }));
 return router;
}
export const fboDashboardRouter=createFboDashboardRouter();
