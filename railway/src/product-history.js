import express from 'express';
import {pool} from './db.js';
import {requireConfiguredSession} from './auth.js';
import {asyncRoute,requireTrustedOrigin,noStore} from './http.js';

export const HISTORY_ENTITIES=new Set(['product','purchase','reservation','movement','sale']);
export const HISTORY_ACTIONS=new Set(['created','updated','deleted','baseline']);
export function historyQuery(input={}){
 const where=[],values=[];
 const add=(sql,value)=>{values.push(value);where.push(sql.replace('?',`$${values.length}`))};
 const productId=String(input.productId||'').trim(),q=String(input.q||'').trim();
 if(productId.length>200||q.length>200)throw Object.assign(Error('Слишком длинный запрос'),{status:400});
 if(productId)add('h.product_id=?',productId);
 if(q){values.push('%'+q.replace(/[\\%_]/g,'\\$&')+'%');const p='$'+values.length;where.push(`(h.product_name ILIKE ${p} OR h.product_id ILIKE ${p} OR p.name ILIKE ${p})`)}
 if(input.entity){if(!HISTORY_ENTITIES.has(input.entity))throw Object.assign(Error('Неизвестный тип записи'),{status:400});add('h.entity=?',input.entity)}
 if(input.action){if(!HISTORY_ACTIONS.has(input.action))throw Object.assign(Error('Неизвестное действие'),{status:400});add('h.action=?',input.action)}
 if(input.before){if(!/^[1-9][0-9]{0,18}$/.test(String(input.before)))throw Object.assign(Error('Некорректная страница'),{status:400});add('h.id<?::bigint',String(input.before))}
 const limit=50;values.push(limit+1);
 return {text:`SELECT h.id::text,h.product_id AS "productId",h.product_name AS "productName",h.entity,h.entity_id AS "entityId",h.action,h.happened_at AS "happenedAt",h.source,h.channel,h.revision,h.changes
 FROM product_history h LEFT JOIN warehouse_products p ON p.id=h.product_id
 ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY h.id DESC LIMIT $${values.length}`,values,limit};
}
export function createProductHistoryRouter({db=pool}={}){
 const router=express.Router();router.use(requireTrustedOrigin,requireConfiguredSession,noStore);
 router.get('/',asyncRoute(async(req,res)=>{
  const query=historyQuery(req.query);
  const [data,meta]=await Promise.all([db.query(query.text,query.values),db.query('SELECT installed_at FROM product_history_meta WHERE id=1')]);
  const rows=data.rows.slice(0,query.limit);res.json({ok:true,rows,nextCursor:data.rows.length>query.limit?rows.at(-1).id:null,installedAt:Number(meta.rows[0]?.installed_at)||null});
 }));return router;
}
export const productHistoryRouter=createProductHistoryRouter();
