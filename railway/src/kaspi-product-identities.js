import crypto from 'node:crypto';
import {pool} from './db.js';
import {config} from './config.js';
import {credentialFor,readKaspiIdentityCache,saveKaspiIdentityCache} from './connections.js';

const API='https://kaspi.kz/shop/api/v2', DAY=86400000;
const text=value=>String(value??'').trim();
const scopeOf=token=>crypto.createHash('sha256').update(token).digest('hex');

// Read-only identity evidence. These seller codes must never become stock-feed aliases.
export function identityItems(cache){
  const grouped=new Map();
  for(const [merchantSku,row] of Object.entries(cache?.byMerchant||{})){
    if(!row.productCode || !row.checkedAt)continue;
    const code=text(row.productCode),item=grouped.get(code)||{productCode:code,merchantSkus:[],checkedAt:row.checkedAt};
    item.merchantSkus.push(merchantSku);item.checkedAt=Math.min(item.checkedAt,row.checkedAt);grouped.set(code,item);
  }
  return [...grouped.values()];
}
export function decorateKaspiIdentities(batches,items){
  const byCode=new Map(items.map(item=>[item.productCode,item.merchantSkus]));
  return batches.map(batch=>!Array.isArray(batch.lines)?batch:({...batch,lines:batch.lines.map(line=>{
    const {kaspiMerchantSkus:_untrusted,...base}=line,merchants=byCode.get(text(line.sku));
    return merchants?{...base,kaspiMerchantSkus:merchants}:base;
  })}));
}
async function candidates(){
  const result=await pool.query(`WITH owned AS (
    SELECT payload->>'kaspi' AS sku FROM warehouse_products
    UNION SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(payload->'kaspiAliases')='array' THEN payload->'kaspiAliases' ELSE '[]'::jsonb END) FROM warehouse_products
  ) SELECT DISTINCT ON (p.sku) p.sku,COALESCE(o.entry_id,'') AS "entryId"
    FROM owned p LEFT JOIN marketplace_order_lines o ON p.sku=o.sku
      AND o.market='Kaspi' AND btrim(o.entry_id)<>'' AND o.entry_id<>'__pending__'
    WHERE btrim(COALESCE(p.sku,''))<>''
    ORDER BY p.sku,o.creation_date DESC,o.updated_at DESC LIMIT 5000`);
  return result.rows;
}
export function createKaspiIdentityCollector({token=()=>credentialFor('Kaspi',config.kaspiToken),read=readKaspiIdentityCache,
  write=saveKaspiIdentityCache,list=candidates,fetchImpl=fetch,now=Date.now,pause=ms=>new Promise(r=>setTimeout(r,ms)),limit=12}={}){
  let busy=false;
  async function context(){
    const value=await token();if(!value)return null;
    const scope=scopeOf(value),saved=await read();
    return {token:value,cache:saved?.scope===scope?saved:{scope,byMerchant:{},retryAt:0}};
  }
  function eligible(rows,cache){return rows.filter(row=>{
    if(!row.entryId)return false;
    const old=cache.byMerchant[row.sku];return !(old?.retryAt>now()) && !(old?.checkedAt>now()-7*DAY);
  });}
  async function product(path,value){
    const response=await fetchImpl(API+path,{headers:{Accept:'application/vnd.api+json','X-Auth-Token':value},
      redirect:'error',signal:AbortSignal.timeout(15000)});
    if(!response.ok){
      const retry=response.headers.get('retry-after');
      const retryAt=/^\d+$/.test(retry||'')?now()+Number(retry)*1000:Date.parse(retry||'');
      throw Object.assign(Error('Kaspi: HTTP '+response.status),{status:response.status,retryAt});
    }
    return (await response.json())?.data;
  }
  return {
    async snapshot(){
      const ctx=await context();if(!ctx)return {ok:true,items:[],pending:0,connected:false};
      const rows=await list();return {ok:true,items:identityItems(ctx.cache),pending:eligible(rows,ctx.cache).length,
        retryAt:ctx.cache.retryAt||0,connected:true};
    },
    async diagnostics(){
      const ctx=await context();if(!ctx)return [];
      return (await list()).map(row=>{
        const saved=ctx.cache.byMerchant[row.sku];
        return {merchantSku:row.sku,productCode:saved?.productCode||'',status:saved?.productCode?'confirmed':!row.entryId?'no-order-entry':saved?.error||'pending'};
      });
    },
    async collect(){
      if(busy)return;busy=true;
      try{
        const ctx=await context();if(!ctx || ctx.cache.retryAt>now())return;
        const rows=eligible(await list(),ctx.cache).slice(0,limit);
        for(const row of rows){
          let linkChanged=false;
          try{
            const master=await product('/orderentries/'+encodeURIComponent(row.entryId)+'/product',ctx.token);
            const code=text(master?.attributes?.code),id=text(master?.id);
            if(master?.type!=='masterproducts'||!code||code.length>200||!id||id.length>500)throw Error('Kaspi: код карточки не подтверждён');
            await pause(250);
            const seller=await product('/masterproducts/'+encodeURIComponent(id)+'/merchantProduct',ctx.token);
            if(seller?.type!=='merchantproducts'||text(seller?.attributes?.code)!==row.sku)throw Error('Kaspi: артикул продавца не совпал');
            linkChanged=ctx.cache.byMerchant[row.sku]?.productCode!==code;
            ctx.cache.byMerchant[row.sku]={productCode:code,entryId:row.entryId,checkedAt:now(),retryAt:0};
          }catch(error){
            const retryAt=Math.max(now()+(error.status===404?DAY:15*60000),Number(error.retryAt)||0);
            ctx.cache.byMerchant[row.sku]={...ctx.cache.byMerchant[row.sku],retryAt,error:error.status?'HTTP '+error.status:'Связь не подтверждена'};
            if(error.status===429||error.status===401||error.status===403)ctx.cache.retryAt=retryAt;
          }
          await write(ctx.cache,linkChanged);
          if(ctx.cache.retryAt>now())break;
          await pause(250);
        }
      }finally{busy=false;}
    },
  };
}
export const kaspiIdentityCollector=createKaspiIdentityCollector();
export async function confirmedKaspiIdentities(client=pool){
  if(config.storeProfile==='WB3')return [];
  try{
    const saved=await readKaspiIdentityCache(client);if(!saved)return [];
    const value=await credentialFor('Kaspi',config.kaspiToken);
    return value && saved.scope===scopeOf(value)?identityItems(saved):[];
  }catch{return []}
}

export function startKaspiIdentityLoop(){
  let diagnosed=false;
  const run=async()=>{
    let client;
    try{
      client=await pool.connect();const lock=await client.query('SELECT pg_try_advisory_lock(873641,2) AS locked');
      if(!lock.rows[0]?.locked)return;
      try{
        await kaspiIdentityCollector.collect();
        if(!diagnosed){
          // One bounded startup record makes missing order evidence distinguishable
          // from a provider failure. No credentials, entry IDs or customer data.
          for(const row of await kaspiIdentityCollector.diagnostics())console.info('Kaspi identity evidence',JSON.stringify(row));
          diagnosed=true;
        }
      }finally{await client.query('SELECT pg_advisory_unlock(873641,2)')}
    }catch(error){console.warn('Kaspi identity cache: '+(error.status?'HTTP '+error.status:'проверка отложена'))}
    finally{client?.release();setTimeout(run,15000).unref()}
  };
  setTimeout(run,1500).unref();
}
