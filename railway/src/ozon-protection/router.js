import express from 'express';
import {pool} from '../db.js';
import {asyncRoute,requireTrustedOrigin,requireWritesEnabled} from '../http.js';
import {requireConfiguredSession} from '../auth.js';
import {saveProtection} from './service.js';
export function createOzonProtectionRouter({db=pool,save=saveProtection}={}){
 const router=express.Router();router.use(requireTrustedOrigin,requireConfiguredSession);
 router.post('/ozon-price-protection',requireWritesEnabled,asyncRoute(async(req,res)=>{
  if(req.body?.confirm!==true)return res.status(400).json({ok:false,error:'Подтвердите настройку защиты Ozon'});
  const account=String(req.body.accountId||'');
  const configured=(await db.query("SELECT id FROM marketplace_credentials WHERE id=$1 AND provider='OZON' AND enabled=1",[account])).rows[0];
  if(!configured)return res.status(404).json({ok:false,error:'Магазин Ozon не подключён'});
  res.json(await save(account,req.body.items,req.body.enabled,{db}));
 }));return router;
}
export const ozonProtectionRouter=createOzonProtectionRouter();
