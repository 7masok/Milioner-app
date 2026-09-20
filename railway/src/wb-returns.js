import express from 'express';
import { pool } from './db.js';
import { asyncRoute, requireTrustedOrigin } from './http.js';

const WB_API='https://marketplace-api.wildberries.ru';
export const wbReturnsRouter=express.Router();

function normalizeMarket(value){
  const raw=String(value||'').trim().toUpperCase();
  return raw==='WB1'?'WB':raw;
}

async function requestJson(url,options,label){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),20_000);
  try{
    const response=await fetch(url,{...options,signal:controller.signal});
    const text=await response.text();
    let data={};try{data=text?JSON.parse(text):{}}catch{}
    if(!response.ok){
      const detail=String(data?.message||data?.errorText||data?.error||data?.detail||text||'').trim().slice(0,500);
      const error=new Error(label+' HTTP '+response.status+(detail?': '+detail:''));
      error.status=response.status;
      throw error;
    }
    return data||{};
  }finally{clearTimeout(timer)}
}

export async function cacheWbOrderStickers(market,token,orders){
  market=normalizeMarket(market);
  if(!/^WB(?:[2-9]\d*|1\d+)?$/.test(market)||!token)return {requested:0,saved:0};
  const eligible=(orders||[]).filter(row=>['confirm','complete'].includes(String(row?.status||'').trim().toLowerCase()));
  const ids=[...new Set(eligible.map(row=>String(row?.orderId||'').trim()).filter(id=>/^\d+$/.test(id)))];
  if(!ids.length)return {requested:0,saved:0};

  const known=new Set();
  for(let start=0;start<ids.length;start+=500){
    const chunk=ids.slice(start,start+500);
    const result=await pool.query('SELECT order_id FROM wb_order_stickers WHERE market=$1 AND order_id = ANY($2::text[])',[market,chunk]);
    for(const row of result.rows)known.add(String(row.order_id));
  }
  const missing=ids.filter(id=>!known.has(id));
  if(!missing.length)return {requested:0,saved:0};

  let saved=0;
  for(let start=0;start<missing.length;start+=100){
    const chunk=missing.slice(start,start+100);
    const data=await requestJson(WB_API+'/api/v3/orders/stickers?type=zplv&width=58&height=40',{
      method:'POST',
      headers:{Accept:'application/json','Content-Type':'application/json',Authorization:token},
      body:JSON.stringify({orders:chunk.map(Number)})
    },'WB order stickers');
    const stickers=Array.isArray(data?.stickers)?data.stickers:[];
    if(!stickers.length)continue;
    const now=Date.now();
    for(const sticker of stickers){
      const orderId=String(sticker?.orderId||'').trim();
      if(!orderId)continue;
      await pool.query(`
        INSERT INTO wb_order_stickers(market,order_id,barcode,part_a,part_b,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$6)
        ON CONFLICT(market,order_id) DO UPDATE SET
          barcode=CASE WHEN EXCLUDED.barcode<>'' THEN EXCLUDED.barcode ELSE wb_order_stickers.barcode END,
          part_a=CASE WHEN EXCLUDED.part_a<>'' THEN EXCLUDED.part_a ELSE wb_order_stickers.part_a END,
          part_b=CASE WHEN EXCLUDED.part_b<>'' THEN EXCLUDED.part_b ELSE wb_order_stickers.part_b END,
          updated_at=EXCLUDED.updated_at
      `,[market,orderId,String(sticker?.barcode||'').trim(),String(sticker?.partA||'').trim(),String(sticker?.partB||'').trim(),now]);
      saved++;
    }
  }
  return {requested:missing.length,saved};
}

function lookupVariants(value){
  const raw=String(value||'').trim();
  const values=new Set();
  const add=v=>{v=String(v||'').trim();if(v)values.add(v)};
  add(raw);
  try{add(decodeURIComponent(raw))}catch{}
  for(const token of raw.split(/[\s;|,?&#=:/]+/))add(token);
  for(const source of [...values]){
    add(source.replace(/\s+/g,''));
    add(source.replace(/[^a-zA-Z0-9!@#$%^&*()_+\-=.:/]+/g,''));
    add(source.replace(/\D+/g,''));
  }
  return [...values].filter(Boolean).slice(0,60);
}

wbReturnsRouter.get('/wb-return-lookup',requireTrustedOrigin,asyncRoute(async(req,res)=>{
  const requestedMarket=normalizeMarket(req.query.market);
  const markets=requestedMarket==='ALL'?['WB','WB2']:[requestedMarket];
  if(!markets.every(market=>/^WB(?:[2-9]\d*|1\d+)?$/.test(market)))return res.status(400).json({ok:false,error:'Некорректный WB-магазин'});
  const code=String(req.query.code||'').trim();
  if(!code)return res.status(400).json({ok:false,error:'Введите или отсканируйте код'});
  const variants=lookupVariants(code);

  const rows=await pool.query(`
    SELECT o.market,o.order_id AS "orderId",o.code,o.entry_id AS "entryId",o.status,o.state,
      o.creation_date AS "creationDate",o.sku,o.product_name AS "productName",o.qty,
      pl.product_id AS "productId",s.barcode,s.part_a AS "partA",s.part_b AS "partB"
    FROM marketplace_order_lines o
    LEFT JOIN product_links pl ON pl.market=o.market AND pl.sku=o.sku
    LEFT JOIN wb_order_stickers s ON s.market=o.market AND s.order_id=o.order_id
    WHERE o.market = ANY($1::text[]) AND (
      o.order_id = ANY($2::text[]) OR o.code = ANY($2::text[]) OR o.entry_id = ANY($2::text[])
      OR s.barcode = ANY($2::text[])
      OR s.part_a = ANY($2::text[]) OR s.part_b = ANY($2::text[])
      OR (s.part_a || s.part_b) = ANY($2::text[])
      OR (s.part_a || '-' || s.part_b) = ANY($2::text[])
    )
    ORDER BY o.creation_date DESC
    LIMIT 20
  `,[markets,variants]);

  if(!rows.rowCount)return res.status(404).json({
    ok:false,
    error:'WB-заказ по этому QR/коду не найден. Если это старый стикер, связь могла ещё не сохраниться; попробуйте номер сборочного задания.'
  });

  const unique=new Map();
  for(const row of rows.rows)unique.set(String(row.market)+':'+String(row.orderId),row);
  if(unique.size>1)return res.status(409).json({ok:false,error:'По этому QR/коду найдено несколько WB-заказов. Выберите WB1/WB2 и введите номер сборочного задания.'});
  const row=[...unique.values()][0];
  const market=String(row.market);
  const externalKey=market+':'+String(row.orderId)+':'+String(row.entryId);
  const sold=await pool.query(`
    SELECT 1
    FROM warehouse_state ws
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(ws.payload::jsonb->'sales','[]'::jsonb)) sale
    WHERE ws.id=1 AND sale->>'externalKey'=$1
    LIMIT 1
  `,[externalKey]);
  return res.json({
    ok:true,
    order:{...row,qty:Math.max(1,Number(row.qty)||1),deducted:Boolean(sold.rowCount),externalKey},
    matchedCode:code
  });
}));
