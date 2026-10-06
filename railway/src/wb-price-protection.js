import express from 'express';
import { pool } from './db.js';
import { asyncRoute, requireTrustedOrigin, requireWritesEnabled } from './http.js';
import { hydrateWarehouseProducts } from './warehouse-products.js';
import { hydrateWarehouseReservations } from './warehouse-reservations.js';

export const wbPriceProtectionRouter = express.Router();
wbPriceProtectionRouter.use(requireTrustedOrigin);

function cleanText(value) { return String(value ?? '').trim(); }
function number(value) { const n=Number(value); return Number.isFinite(n)?n:0; }
function clampDiscount(value) { return Math.max(0,Math.min(99,Math.round(number(value)))); }
function protectedReturnPrice(currentPrice,lockedPrice){
  const current=number(currentPrice),base=number(lockedPrice);
  if(!(base>0)||!(current>0)||base>=current)return base;
  return Math.max(base,Math.ceil(current/1.9));
}
function marketName(value) {
  const market=cleanText(value);
  if(market!=='WB'&&market!=='WB2'){const error=new Error('Защита цены доступна только для WB');error.status=400;throw error;}
  return market;
}
function parseJson(value,fallback={}){if(value&&typeof value==='object')return value;try{return JSON.parse(String(value||''))}catch{return fallback}}
function parts(product){
  return String(product?.kind||'simple')==='bundle'&&Array.isArray(product?.components)
    ? product.components.map(row=>({productId:cleanText(row?.productId),qty:Math.max(1,Math.floor(number(row?.qty)||1))})).filter(row=>row.productId)
    : [];
}
async function warehouseAvailability(client=pool){
  let state={};
  state=await hydrateWarehouseReservations(client,state);
  state=await hydrateWarehouseProducts(client,state);
  const products=Array.isArray(state.products)?state.products:[],byId=new Map(products.map(p=>[cleanText(p?.id),p]).filter(([id])=>id));
  const reservations=(Array.isArray(state.reservations)?state.reservations:[]).filter(row=>row?.active===true);
  function unitsInside(productId,targetId,seen=new Set()){
    const id=cleanText(productId);if(!id||seen.has(id))return 0;if(id===targetId)return 1;
    const product=byId.get(id);if(!product)return 0;
    const next=new Set(seen);next.add(id);
    return parts(product).reduce((sum,part)=>sum+part.qty*unitsInside(part.productId,targetId,next),0);
  }
  const reserved=new Map();
  for(const product of products){
    if(parts(product).length)continue;
    const id=cleanText(product?.id);if(!id)continue;
    reserved.set(id,reservations.reduce((sum,row)=>sum+Math.max(0,number(row?.qty))*unitsInside(row?.productId,id),0));
  }
  const cache=new Map();
  function amount(productId,seen=new Set()){
    const id=cleanText(productId);if(!id||!byId.has(id)||seen.has(id))return null;
    if(cache.has(id))return cache.get(id);
    const product=byId.get(id),components=parts(product),next=new Set(seen);next.add(id);
    let value;
    if(components.length){
      const values=components.map(part=>amount(part.productId,next));
      if(values.some(item=>item===null)){cache.set(id,null);return null;}
      value=Math.max(0,Math.floor(Math.min(...components.map((part,index)=>values[index]/part.qty))));
    }else value=Math.max(0,Math.floor(number(product?.stock)-number(reserved.get(id))));
    cache.set(id,value);return value;
  }
  return {byId,amount};
}
async function priceRows(market,client=pool){
  const result=await client.query('SELECT payload FROM wb_price_snapshots WHERE market=$1',[market]);
  const payload=parseJson(result.rows[0]?.payload,{});
  return Array.isArray(payload.rows)?payload.rows:[];
}
async function protectionRows(market,client=pool){
  const result=await client.query(`SELECT market,nm_id AS "nmId",manual_price_lock AS "manualPriceLock",
    auto_zero_enabled AS "autoZeroEnabled",auto_zero_lock AS "autoZeroLock",promo_block AS "promoBlock",
    locked_price AS "lockedPrice",locked_discount AS "lockedDiscount",own_stock_known AS "ownStockKnown",
    own_available AS "ownAvailable",stock_checked_at AS "stockCheckedAt",updated_at AS "updatedAt"
    FROM wb_price_protection WHERE market=$1 ORDER BY nm_id`,[market]);
  return result.rows.map(row=>({...row,nmId:cleanText(row.nmId),manualPriceLock:Boolean(row.manualPriceLock),
    autoZeroEnabled:Boolean(row.autoZeroEnabled),autoZeroLock:Boolean(row.autoZeroLock),promoBlock:Boolean(row.promoBlock),
    lockedPrice:row.lockedPrice==null?null:Number(row.lockedPrice),lockedDiscount:row.lockedDiscount==null?null:Number(row.lockedDiscount),
    ownStockKnown:Boolean(row.ownStockKnown),ownAvailable:row.ownAvailable==null?null:Number(row.ownAvailable)}));
}
export async function protectionFor(market,nmId,client=pool){
  const result=await client.query(`SELECT manual_price_lock AS "manualPriceLock",auto_zero_enabled AS "autoZeroEnabled",
    auto_zero_lock AS "autoZeroLock",promo_block AS "promoBlock",locked_price AS "lockedPrice",
    locked_discount AS "lockedDiscount" FROM wb_price_protection WHERE market=$1 AND nm_id=$2`,[market,nmId]);
  const row=result.rows[0]||{};
  return {manualPriceLock:Boolean(row.manualPriceLock),autoZeroEnabled:Boolean(row.autoZeroEnabled),
    autoZeroLock:Boolean(row.autoZeroLock),promoBlock:Boolean(row.promoBlock),
    lockedPrice:row.lockedPrice==null?null:Number(row.lockedPrice),lockedDiscount:row.lockedDiscount==null?null:Number(row.lockedDiscount),
    priceProtected:Boolean(row.manualPriceLock||row.autoZeroLock)};
}
export async function isWbPriceProtected(market,nmId,client=pool){
  return (await protectionFor(market,nmId,client)).priceProtected;
}
export async function isWbPromoBlocked(market,nmId,client=pool){
  const row=await protectionFor(market,nmId,client);
  return row.promoBlock||row.priceProtected;
}
export async function decorateWbProtectionRows(market,rows){
  const [prefs,inventory]=await Promise.all([protectionRows(market),warehouseAvailability()]);
  const byNm=new Map(prefs.map(row=>[row.nmId,row]));
  return (Array.isArray(rows)?rows:[]).map(raw=>{
    const row={...raw},pref=byNm.get(cleanText(row.remoteId))||{};
    const available=cleanText(row.productId)?inventory.amount(row.productId):null;
    row.manualPriceLock=Boolean(pref.manualPriceLock);
    row.autoZeroEnabled=Boolean(pref.autoZeroEnabled);
    row.autoZeroLock=Boolean(pref.autoZeroLock);
    row.promoBlocked=Boolean(pref.promoBlock);
    row.priceProtected=Boolean(row.manualPriceLock||row.autoZeroLock);
    row.protectionReason=row.manualPriceLock?'Включено вручную':row.autoZeroLock?'Нет на моём складе':'';
    row.ownStockKnown=available!==null;
    row.ownAvailable=available===null?null:available;
    row.lockedPrice=pref.lockedPrice??null;
    row.lockedDiscount=pref.lockedDiscount??null;
    return row;
  });
}
async function baselineFor(market,nmId,row,client){
  const [scheduleResult,queueResult]=await Promise.all([
    client.query('SELECT base_price AS "basePrice" FROM wb_price_schedules WHERE market=$1 AND nm_id=$2',[market,nmId]),
    client.query(`SELECT desired_price AS "desiredPrice",desired_discount AS "desiredDiscount",source,status
      FROM wb_price_update_queue WHERE market=$1 AND nm_id=$2`,[market,nmId])
  ]);
  const schedule=scheduleResult.rows[0],queue=queueResult.rows[0];
  const manualQueue=cleanText(queue?.source)==='manual'&&['pending','sent','checking'].includes(cleanText(queue?.status));
  const lockedPrice=number(schedule?.basePrice)>0?number(schedule.basePrice)
    :manualQueue&&number(queue?.desiredPrice)>0?number(queue.desiredPrice):number(row?.price);
  const lockedDiscount=manualQueue&&queue?.desiredDiscount!=null?clampDiscount(queue.desiredDiscount):clampDiscount(row?.discount);
  return {lockedPrice:lockedPrice>0?lockedPrice:null,lockedDiscount};
}
async function disableAutomationForLock(market,nmId,client,now){
  await client.query(`DELETE FROM wb_price_update_queue WHERE market=$1 AND nm_id=$2
    AND source IN ('promo','schedule') AND status IN ('pending','held')`,[market,nmId]);
  await client.query(`UPDATE wb_promo_preferences SET enabled=false,
    status=CASE WHEN status='participating' THEN status ELSE 'off' END,last_error='',updated_at=$3
    WHERE market=$1 AND nm_id=$2`,[market,nmId,now]).catch(()=>{});
  await client.query(`UPDATE wb_price_schedules SET phase=CASE WHEN base_price IS NOT NULL THEN 'restoring' ELSE 'locked' END,
    last_error='',updated_at=$3 WHERE market=$1 AND nm_id=$2`,[market,nmId,now]).catch(()=>{});
}
async function history(client,market,nmId,action,actor,payload,now=Date.now()){
  await client.query('INSERT INTO wb_control_history(market,nm_id,action,actor,payload,created_at) VALUES($1,$2,$3,$4,$5::jsonb,$6)',
    [market,nmId,action,cleanText(actor)||'owner',JSON.stringify(payload||{}),now]);
}
function actorFrom(req){
  return cleanText(req?.session?.user?.email||req?.session?.user?.name||req?.user?.email||req?.user?.name||'owner');
}
// A discount block is independent of the seller-price/night-price lock.
export async function setWbDiscountBlock(market,nmId,enabled,client=pool,now=Date.now()){
  await client.query(`INSERT INTO wb_price_protection(market,nm_id,promo_block,updated_at)
    VALUES($1,$2,$3,$4) ON CONFLICT(market,nm_id) DO UPDATE SET
    promo_block=excluded.promo_block,
    locked_discount=CASE WHEN excluded.promo_block THEN 0 ELSE wb_price_protection.locked_discount END,
    updated_at=excluded.updated_at`,[market,nmId,Boolean(enabled),now]);
}
export async function syncWbDiscountBlocks(market,now=Date.now(),client=pool){
  const [rows,prefs]=await Promise.all([priceRows(market,client),protectionRows(market,client)]);
  const byNm=new Map(rows.map(row=>[cleanText(row.remoteId),row]));
  let changed=0;
  for(const pref of prefs){
    if(!pref.promoBlock)continue;
    const row=byNm.get(pref.nmId);if(!row)continue;
    const result=await client.query(`SELECT desired_price AS "desiredPrice",desired_discount AS "desiredDiscount",source,status
      FROM wb_price_update_queue WHERE market=$1 AND nm_id=$2`,[market,pref.nmId]);
    const queue=result.rows[0];
    // Never lose uploadID or blindly retry an item WB already rejected at zero.
    if(queue&&(['sent','checking'].includes(queue.status)||queue.desiredDiscount===0))continue;
    if(!queue&&clampDiscount(row.discount)===0)continue;
    if(queue&&queue.desiredDiscount==null&&clampDiscount(row.discount)===0)continue;
    await client.query(`INSERT INTO wb_price_update_queue
      (market,nm_id,desired_price,desired_discount,status,queued_at,sent_at,upload_id,last_error,updated_at,source,promotion_id)
      VALUES($1,$2,NULL,0,'pending',$3,0,0,'',$3,'protection',0)
      ON CONFLICT(market,nm_id) DO UPDATE SET desired_discount=0,status='pending',
        queued_at=excluded.queued_at,sent_at=0,upload_id=0,last_error='',updated_at=excluded.updated_at
      WHERE wb_price_update_queue.status NOT IN ('sent','checking')
        AND wb_price_update_queue.desired_discount IS DISTINCT FROM 0`,[market,pref.nmId,now]);
    changed++;
  }
  return {changed};
}
async function applyProtection(market,ids,input,actor){
  const client=await pool.connect(),now=Date.now(),applied=[];
  try{
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['millioner:wb-prices:'+market]);
    const rows=await priceRows(market,client),byNm=new Map(rows.map(row=>[Number(row?.remoteId),row]));
    for(const nmId of ids){
      const row=byNm.get(nmId);if(!row)continue;
      const current=await protectionFor(market,nmId,client);
      const nextManual=input.manualPriceLock===undefined?current.manualPriceLock:Boolean(input.manualPriceLock);
      const nextAutoEnabled=input.autoZeroEnabled===undefined?current.autoZeroEnabled:Boolean(input.autoZeroEnabled);
      const nextPromoBlock=input.promoBlock===undefined?current.promoBlock:Boolean(input.promoBlock);
      const needsBaseline=(!current.priceProtected&&nextManual)||(input.autoZeroEnabled===true&&current.autoZeroLock);
      const baseline=needsBaseline?await baselineFor(market,nmId,row,client):{lockedPrice:current.lockedPrice,lockedDiscount:current.lockedDiscount};
      const nextAutoLock=nextAutoEnabled?current.autoZeroLock:false;
      await client.query(`INSERT INTO wb_price_protection
        (market,nm_id,manual_price_lock,auto_zero_enabled,auto_zero_lock,promo_block,locked_price,locked_discount,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT(market,nm_id) DO UPDATE SET manual_price_lock=excluded.manual_price_lock,
          auto_zero_enabled=excluded.auto_zero_enabled,auto_zero_lock=excluded.auto_zero_lock,promo_block=excluded.promo_block,
          locked_price=COALESCE(excluded.locked_price,wb_price_protection.locked_price),
          locked_discount=COALESCE(excluded.locked_discount,wb_price_protection.locked_discount),updated_at=excluded.updated_at`,
        [market,nmId,nextManual,nextAutoEnabled,nextAutoLock,nextPromoBlock,baseline.lockedPrice,nextPromoBlock?0:baseline.lockedDiscount,now]);
      if(nextManual||nextAutoLock)await disableAutomationForLock(market,nmId,client,now);
      if(nextPromoBlock){
        await client.query(`DELETE FROM wb_price_update_queue WHERE market=$1 AND nm_id=$2 AND source='promo' AND status IN ('pending','held')`,[market,nmId]);
        await client.query(`UPDATE wb_promo_preferences SET enabled=false,
          status=CASE WHEN status='participating' THEN status ELSE 'off' END,updated_at=$3 WHERE market=$1 AND nm_id=$2`,
          [market,nmId,now]).catch(()=>{});
      }
      await history(client,market,nmId,'price-protection',actor,{manualPriceLock:nextManual,autoZeroEnabled:nextAutoEnabled,promoBlock:nextPromoBlock},now);
      applied.push(String(nmId));
    }
    if(!applied.length){const error=new Error('Выбранные товары не найдены в последнем снимке цен WB');error.status=409;throw error;}
    await syncWbDiscountBlocks(market,now,client);
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error}finally{client.release()}
  return {applied,rows:await protectionRows(market)};
}
export async function syncWbPriceProtection(market,now=Date.now()){
  const [rows,prefs,inventory]=await Promise.all([priceRows(market),protectionRows(market),warehouseAvailability()]);
  if(!rows.length||!prefs.length)return {changed:0};
  const byNm=new Map(rows.map(row=>[cleanText(row?.remoteId),row]));
  let changed=0;
  for(const pref of prefs){
    const row=byNm.get(pref.nmId);
    if(!row)continue;
    const available=cleanText(row.productId)?inventory.amount(row.productId):null;
    const known=available!==null;
    let autoLock=pref.autoZeroLock;
    let lockedPrice=pref.lockedPrice,lockedDiscount=pref.promoBlock?0:pref.lockedDiscount;
    if(pref.autoZeroEnabled&&known&&available===0&&!autoLock){
      const client=await pool.connect();
      try{
        await client.query('BEGIN');
        const baseline=pref.manualPriceLock
          ? {lockedPrice:pref.lockedPrice,lockedDiscount:pref.lockedDiscount}
          : await baselineFor(market,Number(pref.nmId),row,client);
        lockedPrice=baseline.lockedPrice;lockedDiscount=pref.promoBlock?0:baseline.lockedDiscount;autoLock=true;
        await client.query(`UPDATE wb_price_protection SET auto_zero_lock=true,locked_price=$3,locked_discount=$4,
          own_stock_known=true,own_available=0,stock_checked_at=$5,updated_at=$5 WHERE market=$1 AND nm_id=$2`,
          [market,pref.nmId,lockedPrice,lockedDiscount,now]);
        await disableAutomationForLock(market,pref.nmId,client,now);
        await history(client,market,Number(pref.nmId),'auto-zero-lock','system',{ownAvailable:0},now);
        await client.query('COMMIT');changed++;
      }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error}finally{client.release()}
    }else if(autoLock&&(!pref.autoZeroEnabled||(known&&available>0))){
      await pool.query(`UPDATE wb_price_protection SET auto_zero_lock=false,own_stock_known=$3,own_available=$4,
        stock_checked_at=$5,updated_at=$5 WHERE market=$1 AND nm_id=$2`,
        [market,pref.nmId,known,known?available:null,now]);
      autoLock=false;changed++;
      await pool.query(`INSERT INTO wb_control_history(market,nm_id,action,actor,payload,created_at)
        VALUES($1,$2,'auto-zero-unlock','system',$3::jsonb,$4)`,[market,pref.nmId,JSON.stringify({ownAvailable:known?available:null}),now]).catch(()=>{});
    }else{
      await pool.query(`UPDATE wb_price_protection SET own_stock_known=$3,own_available=$4,stock_checked_at=$5
        WHERE market=$1 AND nm_id=$2`,[market,pref.nmId,known,known?available:null,now]).catch(()=>{});
    }
    const protectedNow=pref.manualPriceLock||autoLock;
    if(!protectedNow)continue;
    const queueResult=await pool.query(`SELECT desired_price AS "desiredPrice",desired_discount AS "desiredDiscount",source,status
      FROM wb_price_update_queue WHERE market=$1 AND nm_id=$2`,[market,pref.nmId]);
    const queue=queueResult.rows[0];
    if(queue&&['promo','schedule'].includes(cleanText(queue.source))&&['pending','held'].includes(cleanText(queue.status))){
      await pool.query('DELETE FROM wb_price_update_queue WHERE market=$1 AND nm_id=$2',[market,pref.nmId]);changed++;
    }
    if(queue&&(['sent','checking'].includes(cleanText(queue.status))||['manual','protection'].includes(cleanText(queue.source))))continue;
    const confirmedPrice=number(row.price);
    const protectedPrice=lockedPrice!=null?protectedReturnPrice(confirmedPrice,lockedPrice):null;
    const desiredPrice=protectedPrice!=null&&row.canEditPrice!==false&&Math.abs(confirmedPrice-number(lockedPrice))>0.000001?protectedPrice:null;
    const desiredDiscount=lockedDiscount!=null&&clampDiscount(row.discount)!==clampDiscount(lockedDiscount)?clampDiscount(lockedDiscount):null;
    if(desiredPrice===null&&desiredDiscount===null)continue;
    await pool.query(`INSERT INTO wb_price_update_queue
      (market,nm_id,desired_price,desired_discount,status,queued_at,sent_at,upload_id,last_error,updated_at,source,promotion_id)
      VALUES($1,$2,$3,$4,'pending',$5,0,0,'',$5,'protection',0)
      ON CONFLICT(market,nm_id) DO UPDATE SET desired_price=excluded.desired_price,desired_discount=excluded.desired_discount,
        status='pending',queued_at=excluded.queued_at,sent_at=0,upload_id=0,last_error='',updated_at=excluded.updated_at,
        source='protection',promotion_id=0
      WHERE wb_price_update_queue.source IN ('promo','schedule','protection')`,
      [market,pref.nmId,desiredPrice,desiredDiscount,now]);
    changed++;
  }
  return {changed};
}
export async function updateProtectionBaseline(market,nmId,{price,discount},client=pool){
  const pref=await protectionFor(market,nmId,client);if(!pref.priceProtected)return false;
  await client.query(`UPDATE wb_price_protection SET
    locked_price=CASE WHEN $3::double precision IS NULL THEN locked_price ELSE $3 END,
    locked_discount=CASE WHEN $4::integer IS NULL THEN locked_discount ELSE $4 END,updated_at=$5
    WHERE market=$1 AND nm_id=$2`,[market,nmId,price==null?null:Number(price),discount==null?null:clampDiscount(discount),Date.now()]);
  return true;
}
wbPriceProtectionRouter.post('/market-prices/protection',requireWritesEnabled,asyncRoute(async(req,res)=>{
  if(req.body?.confirm!==true)return res.status(400).json({ok:false,error:'Подтвердите изменение защиты'});
  const market=marketName(req.body?.market);
  const raw=Array.isArray(req.body?.remoteIds)?req.body.remoteIds:[req.body?.remoteId];
  const ids=[...new Set(raw.map(Number).filter(value=>Number.isInteger(value)&&value>0))].slice(0,1000);
  if(!ids.length)return res.status(400).json({ok:false,error:'Не выбраны товары WB'});
  if(req.body?.manualPriceLock===undefined&&req.body?.autoZeroEnabled===undefined&&req.body?.promoBlock===undefined)
    return res.status(400).json({ok:false,error:'Не выбрано изменение защиты'});
  const result=await applyProtection(market,ids,req.body,actorFrom(req));
  return res.json({ok:true,market,remoteIds:result.applied,count:result.applied.length,protection:result.rows,
    limitation:'Блок поддерживает скидку продавца 0% через регулярные проверки WB. Скидки самой площадки отдельно.'});
}));
