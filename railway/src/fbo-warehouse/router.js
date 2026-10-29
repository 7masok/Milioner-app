import express from 'express';
import {pool,transaction} from '../db.js';
import {asyncRoute,requireTrustedOrigin,requireWritesEnabled} from '../http.js';
import {requireConfiguredSession} from '../auth.js';
import {plannerAccounts,sourceFor} from '../ozon-planner/service.js';
import {readWarehouseContext,persistFboOperation,assertRevision} from './store.js';
import {resolver,createDraft,cancelDraft,dispatchDraft,draftGroups,fail} from './core.js';
import {mirrorFboProducts} from './legacy.js';
import {stockLedgerViolation} from '../warehouse-ledger.js';
const knownSku=(source,sku)=>[...(source?.payload?.stockRequestedSkus||[]),...(source?.payload?.rows||[]).map(r=>r.sku),...(source?.payload?.supplies||[]).flatMap(s=>(s.items||[]).map(i=>i.sku))].map(String).includes(sku);
export {remoteForOrder} from './remote.js';
import {remoteForOrder} from './remote.js';
import {setAutoAccounting} from './automatic.js';
export function createFboWarehouseRouter({db=pool,transact=transaction,accounts=plannerAccounts,readSource=sourceFor,readContext=readWarehouseContext,persist=persistFboOperation,mirror=mirrorFboProducts}={}){
 const router=express.Router();router.use(requireTrustedOrigin,requireConfiguredSession,requireWritesEnabled);
 async function operate(req,res,action){
  const account=(await accounts())[0];if(!account&&action!=='cancel')fail('Магазин Ozon не подключён',400);const source=account?await readSource(account):null;if(!source?.payload&&action!=='cancel')fail('Данные Ozon ещё загружаются');
  const result=await transact(async client=>{
   const context=await readContext(client,account?.id||'',{lock:true,movements:action==='dispatch'}),state=context.state,input=req.body||{},resolve=resolver(state,context.stockRows);let result;
   if(action==='create'){
    const existing=draftGroups(state).find(d=>d.id===input.id);if(!existing)assertRevision(context,input);
    if(!Array.isArray(input.lines))fail('Укажите строки плана',400);for(const line of input.lines)if(!knownSku(source,String(line?.sku||'')))fail('SKU отсутствует в текущем снимке Ozon',400);
    result=createDraft(state,input,resolve,account.id);
   }else if(action==='link'){
    assertRevision(context,input);const sku=String(input.sku||'').trim(),p=(state.products||[]).find(p=>String(p.id)===String(input.productId)&&p.kind!=='variant-group');if(!p||!knownSku(source,sku))fail('Выберите товар склада и известный SKU Ozon',400);
    const match=resolve(sku);if(match.ambiguous||match.product&&String(match.product.id)!==String(p.id))fail('SKU или его артикул уже связан с другим товаром. Исправьте привязку в карточке товара.');
    const aliases=Array.isArray(p.ozonAliases)?p.ozonAliases:String(p.ozonAliases||'').split(/[;,\n]/).filter(Boolean);
    if(String(p.ozon||'')===sku||aliases.includes(sku))return{ok:true,revision:context.revision,changed:false};
    if(!String(p.ozon||'').trim())p.ozon=sku;else p.ozonAliases=[...new Set([...aliases,sku])];
    const revision=await persist(client,context,{products:true,source:'fbo-product-link'});await mirror(client,[p]);return{ok:true,revision,changed:true};
   }else{
    const d=draftGroups(state).find(d=>d.id===req.params.id&&(action==='cancel'||d.account===account.id));if(!d)fail('План не найден',404);
    if(action==='cancel'){if(d.status!=='cancelled')assertRevision(context,input);result=cancelDraft(state,d.id)}
    else{if(input.confirmed!==true)fail('Подтвердите фактическую отправку',400);const orderId=String(input.orderId||'');if(!/^[1-9][0-9]{0,18}$/.test(orderId))fail('Укажите номер заявки Ozon',400);
     const remote=d.status==='sent'?{orderId,lines:[]}:remoteForOrder(source,orderId);if(d.status!=='sent')assertRevision(context,input);const previous=structuredClone(state);result=dispatchDraft(state,d.id,remote);if(result.changed){const violation=stockLedgerViolation(previous,state);if(violation)fail('Не удалось согласовать списание с журналом склада');}
    }
   }
   if(!result.changed)return{ok:true,changed:false,revision:context.revision,draft:publicDraft(result.draft)};
   const movements=action==='dispatch'?state.movements.filter(m=>m.id.startsWith('fbo-in-')||m.id.startsWith('fbo-out-')):[];
   const revision=await persist(client,context,{products:action==='dispatch',purchases:action==='dispatch',movements,source:'fbo-'+action});if(action==='dispatch'){const changed=new Set(result.draft.rows.map(r=>r.productId));await mirror(client,state.products.filter(p=>changed.has(String(p.id))))};
   return{ok:true,changed:true,revision,draft:publicDraft(result.draft)};
  });res.json(result);
 }
 const publicDraft=({rows,signature,...d})=>d;
 router.post('/automatic',asyncRoute(async(req,res)=>{const account=(await accounts())[0];if(!account)fail('Магазин Ozon не подключён',400);if(typeof req.body?.enabled!=='boolean')fail('Укажите режим автосписания',400);const source=await readSource(account);res.json(await setAutoAccounting(account,source,req.body.enabled,{transact}));}));
 router.post('/link',asyncRoute((req,res)=>operate(req,res,'link')));
 router.post('/drafts',asyncRoute((req,res)=>operate(req,res,'create')));
 router.post('/drafts/:id/cancel',asyncRoute((req,res)=>operate(req,res,'cancel')));
 router.post('/drafts/:id/dispatch',asyncRoute((req,res)=>operate(req,res,'dispatch')));
 return router;
}
export const fboWarehouseRouter=createFboWarehouseRouter();
