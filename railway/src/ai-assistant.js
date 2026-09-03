import express from 'express';
import { pool } from './db.js';
import { credentialFor } from './connections.js';
import { asyncRoute, requireTrustedOrigin } from './http.js';

export const aiAssistantRouter = express.Router();
const MODEL = String(process.env.OPENAI_MODEL || 'gpt-5-mini').trim();
const recentRequests = new Map();

function cleanMessages(value) {
  return (Array.isArray(value) ? value : []).slice(-10).map(row => ({
    role: row?.role === 'assistant' ? 'assistant' : 'user',
    content: String(row?.content || '').trim().slice(0, 4000)
  })).filter(row => row.content);
}

function snapshotSummary(payload) {
  const state = payload && typeof payload === 'object' ? payload : {};
  const reservations = new Map();
  for (const row of Array.isArray(state.reservations) ? state.reservations : []) {
    if (row?.active === false || row?.cancelled) continue;
    const id = String(row?.productId || '');
    reservations.set(id, (reservations.get(id) || 0) + Math.max(0, Number(row?.qty) || 0));
  }
  const products = (Array.isArray(state.products) ? state.products : []).slice(0, 500).map(p => ({
    id:String(p?.id||''), name:String(p?.name||''), category:String(p?.category||''),
    stock:Number(p?.stock)||0, reserved:reservations.get(String(p?.id||''))||0,
    cost:Number(p?.cost)||0, kaspi:String(p?.kaspi||''), wb:String(p?.wb||''), wb2:String(p?.wb2||'')
  }));
  const purchases=(Array.isArray(state.purchases)?state.purchases:[]).slice(0,150).map(x=>({productId:String(x?.productId||''),qty:Number(x?.qty)||0,status:String(x?.status||''),date:Number(x?.date||x?.orderedAt||0)||0,unitCost:Number(x?.unitCost)||0}));
  const sales=(Array.isArray(state.sales)?state.sales:[]).slice(0,250).map(x=>({productId:String(x?.productId||''),qty:Number(x?.qty)||0,date:Number(x?.date||0)||0,market:String(x?.market||'')}));
  return {generatedAt:new Date().toISOString(),products,purchases,sales};
}

function outputText(data) {
  if (typeof data?.output_text === 'string') return data.output_text.trim();
  return (Array.isArray(data?.output) ? data.output : []).flatMap(item=>Array.isArray(item?.content)?item.content:[]).map(part=>part?.text||'').join('').trim();
}

aiAssistantRouter.get('/assistant/status', requireTrustedOrigin, asyncRoute(async (_req,res)=>{
  res.json({ok:true,configured:Boolean(await credentialFor('OPENAI')),model:MODEL});
}));

aiAssistantRouter.post('/assistant/chat', requireTrustedOrigin, asyncRoute(async (req,res)=>{
  const key=await credentialFor('OPENAI');
  if(!key){const error=new Error('Сначала подключите API-ключ OpenAI');error.status=503;throw error}
  const bucket=String(req.ip||'owner'),now=Date.now(),last=recentRequests.get(bucket)||0;
  if(now-last<1500){const error=new Error('Подождите секунду перед следующим сообщением');error.status=429;throw error}
  recentRequests.set(bucket,now);
  const messages=cleanMessages(req.body?.messages);
  if(!messages.length){const error=new Error('Напишите вопрос');error.status=400;throw error}
  const result=await pool.query('SELECT payload FROM warehouse_state WHERE id=1');
  const context=snapshotSummary(result.rows[0]?.payload);
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),55_000);
  try{
    const response=await fetch('https://api.openai.com/v1/responses',{method:'POST',signal:controller.signal,headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({model:MODEL,store:false,max_output_tokens:900,instructions:'Ты помощник владельца склада и продавца на Kaspi и Wildberries. Отвечай по-русски, коротко и конкретно. Используй только переданные данные склада; не выдумывай числа. Если данных недостаточно, прямо скажи об этом. Ты пока только анализируешь и советуешь, но не изменяешь склад.',input:[{role:'developer',content:'Текущие данные склада (JSON): '+JSON.stringify(context)},...messages]})});
    const data=await response.json().catch(()=>({}));
    if(!response.ok){const error=new Error(String(data?.error?.message||('OpenAI HTTP '+response.status)));error.status=response.status===429?429:502;throw error}
    const answer=outputText(data);if(!answer)throw new Error('OpenAI вернул пустой ответ');
    res.json({ok:true,answer,model:MODEL});
  }finally{clearTimeout(timer)}
}));
