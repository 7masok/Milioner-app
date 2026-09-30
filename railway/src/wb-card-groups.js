import express from 'express';
import { config } from './config.js';
import { pool } from './db.js';
import { credentialFor } from './connections.js';
import { asyncRoute, requireTrustedOrigin, requireWritesEnabled } from './http.js';

const CONTENT_API='https://content-api.wildberries.ru';
const CONTENT_INTERVAL_MS=650;
const CONTENT_MAX_PAGES=50;

export const wbCardGroupsRouter=express.Router();
wbCardGroupsRouter.use(requireTrustedOrigin);

function cleanText(value){return String(value??'').trim()}
function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms))}
function retryAtValue(raw,now=Date.now()){
  const text=cleanText(raw);if(!text)return 0;
  const seconds=Number(text);if(Number.isFinite(seconds))return now+Math.max(0,seconds)*1000;
  const parsed=Date.parse(text);return Number.isFinite(parsed)?parsed:0;
}
function retryAtHeaders(headers,now=Date.now()){
  return Math.max(retryAtValue(headers?.get?.('x-ratelimit-retry'),now),retryAtValue(headers?.get?.('retry-after'),now));
}
function marketName(value){
  const market=cleanText(value);
  if(market!=='WB'&&market!=='WB2'){const error=new Error('Группы карточек доступны только для WB');error.status=400;throw error}
  return market;
}
async function tokenFor(market){
  return credentialFor(market,market==='WB2'?config.wbToken2:config.wbToken);
}
function photoUrl(card){
  const photo=Array.isArray(card?.photos)?card.photos[0]:null;
  return cleanText(photo?.c516x688||photo?.big||photo?.c246x328||photo?.square||photo?.tm||'');
}
export function wbCardGroupCard(raw){
  return {
    nmId:cleanText(raw?.nmID??raw?.nmId),
    imtId:cleanText(raw?.imtID??raw?.imtId),
    subjectId:cleanText(raw?.subjectID??raw?.subjectId),
    subjectName:cleanText(raw?.subjectName||raw?.subject||raw?.object),
    vendorCode:cleanText(raw?.vendorCode),
    title:cleanText(raw?.title||raw?.subjectName||raw?.subject||raw?.vendorCode),
    photo:cleanText(raw?.photo)||photoUrl(raw)
  };
}
async function requestContent(token,path,options={},market='WB'){
  const response=await fetch(CONTENT_API+path,{...options,headers:{Accept:'application/json',Authorization:token,...(options.headers||{})},signal:AbortSignal.timeout(30_000)});
  const text=await response.text();let data={};
  try{data=text?JSON.parse(text):{}}catch{data={errorText:text.slice(0,500)}}
  if(!response.ok){
    let message=cleanText(data?.errorText||data?.message||data?.error)||('WB Content HTTP '+response.status);
    const retryAt=retryAtHeaders(response.headers);
    if(response.status===429&&retryAt>Date.now())message+=' · повторить после '+new Date(retryAt).toISOString();
    if((response.status===401||response.status===403)&&!/контент|content/i.test(message))message+=' · проверьте право токена WB на категорию «Контент»';
    const error=new Error(message);
    error.status=response.status;error.retryAt=retryAt;error.market=market;throw error;
  }
  return data||{};
}
export async function fetchWbCardGroupsRemote(market){
  market=marketName(market);
  const token=await tokenFor(market);
  if(!token){const error=new Error(market+': токен не настроен');error.status=400;throw error}
  const cards=[];let cursor={};
  for(let page=0;page<CONTENT_MAX_PAGES;page++){
    if(page)await sleep(CONTENT_INTERVAL_MS);
    const body={settings:{sort:{ascending:true},cursor:{limit:100,...cursor},filter:{withPhoto:-1}}};
    const data=await requestContent(token,'/content/v2/get/cards/list',{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)
    },market);
    const batch=Array.isArray(data?.cards)?data.cards:[];
    cards.push(...batch.map(wbCardGroupCard).filter(card=>card.nmId));
    if(!batch.length||batch.length<100)return cards;
    const next=data?.cursor||{};
    if(!next.updatedAt||!next.nmID){const error=new Error('WB Content вернул неполный курсор карточек');error.status=502;throw error}
    cursor={updatedAt:next.updatedAt,nmID:next.nmID};
  }
  const error=new Error('Каталог WB слишком большой для безопасной проверки групп за один цикл');error.status=409;throw error;
}
export async function saveWbCardGroupSnapshot(market,cards,client=pool,lastError=''){
  market=marketName(market);
  const normalized=(Array.isArray(cards)?cards:[]).map(wbCardGroupCard).filter(card=>card.nmId);
  const now=Date.now();
  await client.query(`INSERT INTO wb_card_group_snapshots(market,payload,fetched_at,last_error,updated_at)
    VALUES($1,$2::jsonb,$3,$4,$3)
    ON CONFLICT(market) DO UPDATE SET payload=excluded.payload,fetched_at=excluded.fetched_at,last_error=excluded.last_error,updated_at=excluded.updated_at`,
    [market,JSON.stringify({cards:normalized}),now,cleanText(lastError)]);
  return {market,cards:normalized,fetchedAt:now,lastError:cleanText(lastError)};
}
export async function markWbCardGroupError(market,error,client=pool){
  market=marketName(market);const now=Date.now();
  await client.query(`INSERT INTO wb_card_group_snapshots(market,payload,fetched_at,last_error,updated_at)
    VALUES($1,'{"cards":[]}'::jsonb,0,$2,$3)
    ON CONFLICT(market) DO UPDATE SET last_error=excluded.last_error,updated_at=excluded.updated_at`,
    [market,cleanText(error?.message||error).slice(0,500),now]);
}
export async function wbCardGroupSnapshot(market,client=pool){
  market=marketName(market);
  const result=await client.query('SELECT payload,fetched_at AS "fetchedAt",last_error AS "lastError" FROM wb_card_group_snapshots WHERE market=$1',[market]);
  const row=result.rows[0];if(!row)return {market,cards:[],fetchedAt:0,lastError:''};
  const payload=row.payload&&typeof row.payload==='object'?row.payload:{};
  return {market,cards:Array.isArray(payload.cards)?payload.cards.map(wbCardGroupCard):[],fetchedAt:Number(row.fetchedAt||0),lastError:cleanText(row.lastError)};
}
export async function decorateWbCardGroupRows(market,rows,client=pool){
  const snapshot=await wbCardGroupSnapshot(market,client),counts=new Map();
  for(const card of snapshot.cards){const key=cleanText(card.imtId);if(key)counts.set(key,(counts.get(key)||0)+1)}
  const byNm=new Map(snapshot.cards.map(card=>[cleanText(card.nmId),card]));
  return {snapshot,rows:(Array.isArray(rows)?rows:[]).map(raw=>{
    const row={...raw},card=byNm.get(cleanText(row.remoteId));
    row.groupImtId=cleanText(card?.imtId);
    row.groupSize=row.groupImtId?Number(counts.get(row.groupImtId)||1):0;
    row.grouped=row.groupSize>1;
    row.groupSubjectId=cleanText(card?.subjectId);
    row.groupSubjectName=cleanText(card?.subjectName);
    row.groupPhoto=cleanText(card?.photo);
    return row;
  })};
}
async function moveCards(market,body){
  const token=await tokenFor(market);
  if(!token){const error=new Error(market+': токен не настроен');error.status=400;throw error}
  return requestContent(token,'/content/v2/cards/moveNm',{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)
  },market);
}
function actorFrom(req){return cleanText(req?.session?.user?.email||req?.session?.user?.name||req?.user?.email||req?.user?.name||'owner')}
async function writeHistory(market,nmIds,action,actor,payload){
  const now=Date.now(),client=await pool.connect();
  try{
    await client.query('BEGIN');
    for(const raw of nmIds){
      const nmId=Number(raw)||null;
      await client.query('INSERT INTO wb_control_history(market,nm_id,action,actor,payload,created_at) VALUES($1,$2,$3,$4,$5::jsonb,$6)',
        [market,nmId,action,cleanText(actor)||'owner',JSON.stringify(payload||{}),now]);
    }
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error}finally{client.release()}
}
function cardMap(cards){return new Map((Array.isArray(cards)?cards:[]).map(card=>[cleanText(card.nmId),card]))}
function ensureSameSubject(selected,target){
  const subjects=new Set(selected.map(card=>cleanText(card.subjectId)).filter(Boolean));
  if(target?.subjectId)subjects.add(cleanText(target.subjectId));
  if(subjects.size>1){const error=new Error('WB разрешает объединять только карточки одного предмета');error.status=409;throw error}
}
wbCardGroupsRouter.get('/market-prices/card-groups',asyncRoute(async(req,res)=>{
  const market=marketName(req.query.market);
  const snapshot=await wbCardGroupSnapshot(market);
  return res.json({ok:true,...snapshot,serverSnapshot:true});
}));
wbCardGroupsRouter.post('/market-prices/card-groups/recheck',requireWritesEnabled,asyncRoute(async(req,res)=>{
  const market=marketName(req.body?.market);
  try{
    const cards=await fetchWbCardGroupsRemote(market);
    const snapshot=await saveWbCardGroupSnapshot(market,cards);
    const ids=[...new Set((Array.isArray(req.body?.remoteIds)?req.body.remoteIds:[])
      .map(Number).filter(value=>Number.isInteger(value)&&value>0))].slice(0,30);
    const byNm=cardMap(snapshot.cards);
    const actual=ids.map(id=>byNm.get(String(id))).filter(Boolean).map(card=>({
      nmId:card.nmId,imtId:card.imtId,subjectId:card.subjectId,title:card.title,vendorCode:card.vendorCode,photo:card.photo
    }));
    return res.json({ok:true,...snapshot,actual});
  }catch(error){
    await markWbCardGroupError(market,error).catch(()=>{});
    return res.status(Number(error?.status)||500).json({
      ok:false,error:cleanText(error?.message||error),retryAt:Number(error?.retryAt)||0
    });
  }
}));

wbCardGroupsRouter.post('/market-prices/card-groups/move',requireWritesEnabled,asyncRoute(async(req,res)=>{
  if(req.body?.confirm!==true)return res.status(400).json({ok:false,error:'Подтвердите изменение группы карточек'});
  const market=marketName(req.body?.market);
  const ids=[...new Set((Array.isArray(req.body?.remoteIds)?req.body.remoteIds:[req.body?.remoteId])
    .map(Number).filter(value=>Number.isInteger(value)&&value>0))].slice(0,31);
  if(!ids.length)return res.status(400).json({ok:false,error:'Не выбраны карточки WB'});
  if(ids.length>30)return res.status(400).json({ok:false,error:'WB позволяет перемещать не более 30 карточек за одну операцию'});
  const snapshot=await wbCardGroupSnapshot(market),before=cardMap(snapshot.cards);
  if(!snapshot.cards.length)return res.status(409).json({ok:false,error:'Снимок карточек WB ещё не загружен. Дождитесь серверной синхронизации.'});
  const selected=ids.map(id=>before.get(String(id))).filter(Boolean);
  if(selected.length!==ids.length)return res.status(409).json({ok:false,error:'Часть выбранных карточек отсутствует в последнем снимке WB'});
  const targetImt=cleanText(req.body?.targetImt);
  const separateEach=req.body?.separateEach===true;
  let action='',target=null;
  if(targetImt){
    target=snapshot.cards.find(card=>cleanText(card.imtId)===targetImt)||null;
    if(!target)return res.status(409).json({ok:false,error:'Целевая группа отсутствует в последнем снимке WB'});
    ensureSameSubject(selected,target);
    const moving=selected.filter(card=>cleanText(card.imtId)!==targetImt).map(card=>Number(card.nmId));
    if(moving.length)await moveCards(market,{targetIMT:Number(targetImt),nmIDs:moving});
    action='merge';
  }else{
    ensureSameSubject(selected,null);
    if(separateEach){
      for(let i=0;i<ids.length;i++){
        if(i)await sleep(CONTENT_INTERVAL_MS);
        await moveCards(market,{nmIDs:[ids[i]]});
      }
      action='separate-each';
    }else{
      await moveCards(market,{nmIDs:ids});
      action='detach-group';
    }
  }
  await sleep(CONTENT_INTERVAL_MS);
  let refreshed;
  try{refreshed=await fetchWbCardGroupsRemote(market);await saveWbCardGroupSnapshot(market,refreshed)}
  catch(error){await markWbCardGroupError(market,error).catch(()=>{});throw error}
  const after=cardMap(refreshed),actual=ids.map(id=>after.get(String(id))).filter(Boolean);
  let verified=false;
  if(targetImt)verified=actual.length===ids.length&&actual.every(card=>cleanText(card.imtId)===targetImt);
  else if(separateEach)verified=actual.length===ids.length&&new Set(actual.map(card=>cleanText(card.imtId)).filter(Boolean)).size===ids.length;
  else verified=actual.length===ids.length&&new Set(actual.map(card=>cleanText(card.imtId)).filter(Boolean)).size===1;
  const payload={remoteIds:ids.map(String),targetImt:targetImt||null,separateEach,verified,
    before:selected.map(card=>({nmId:card.nmId,imtId:card.imtId})),
    after:actual.map(card=>({nmId:card.nmId,imtId:card.imtId}))};
  await writeHistory(market,ids,action,actorFrom(req),payload);
  const fresh=await wbCardGroupSnapshot(market);
  if(!verified)return res.status(409).json({ok:false,market,verified:false,error:'WB принял запрос, но фактический состав групп не совпал с ожидаемым',...fresh,actual:payload.after});
  return res.json({ok:true,market,verified:true,action,...fresh,actual:payload.after});
}));
