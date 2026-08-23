import { pool } from './db.js';
import { config } from './config.js';
import { credentialFor } from './connections.js';
import { normalizeWbCard } from './wb-variant-normalize.js';

const CONTENT_API='https://content-api.wildberries.ru';
const MARKETPLACE_API='https://marketplace-api.wildberries.ru';
const TIMEOUT_MS=25_000;

async function requestJson(url,options,label){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),TIMEOUT_MS);
  try{
    const response=await fetch(url,{...options,signal:controller.signal});
    const text=await response.text();let data={};try{data=text?JSON.parse(text):{}}catch{data={message:text.slice(0,500)}}
    if(!response.ok)throw new Error(label+' HTTP '+response.status+(data?.message?': '+data.message:''));
    return data||{};
  }finally{clearTimeout(timer)}
}
function parse(value){try{const x=JSON.parse(String(value||'{}'));return x&&typeof x==='object'?x:{}}catch{return {}}}
function parts(product){return String(product?.kind||'simple')==='bundle'&&Array.isArray(product?.components)?product.components.map(x=>({productId:String(x?.productId||''),qty:Math.max(1,Math.floor(Number(x?.qty)||1))})).filter(x=>x.productId):[]}
function sharedAvailable(state){
  const products=Array.isArray(state?.products)?state.products:[],byId=new Map(products.map(p=>[String(p?.id||''),p]).filter(([id])=>id));
  const reservations=(Array.isArray(state?.reservations)?state.reservations:[]).filter(row=>row?.active===true);
  function unitsInside(productId,targetId,seen=new Set()){
    const id=String(productId||'');if(!id||seen.has(id))return 0;if(id===targetId)return 1;
    const next=new Set(seen);next.add(id);return parts(byId.get(id)).reduce((sum,part)=>sum+part.qty*unitsInside(part.productId,targetId,next),0);
  }
  const reserved=new Map();
  for(const product of products){if(parts(product).length)continue;const id=String(product?.id||'');reserved.set(id,reservations.reduce((sum,row)=>sum+Math.max(0,Number(row?.qty)||0)*unitsInside(row?.productId,id),0))}
  const cache=new Map();
  function amount(productId,seen=new Set()){
    const id=String(productId||'');if(!id||seen.has(id))return 0;if(cache.has(id))return cache.get(id);
    const product=byId.get(id);if(!product)return 0;const next=new Set(seen);next.add(id);const components=parts(product);
    const value=components.length?Math.max(0,Math.floor(Math.min(...components.map(part=>amount(part.productId,next)/part.qty)))):Math.max(0,Math.floor((Number(product?.stock)||0)-(Number(reserved.get(id))||0)));
    cache.set(id,value);return value;
  }
  return {products,amount};
}
async function catalog(token){
  const cards=[];let cursor={};
  for(let page=0;page<20;page++){
    const body={settings:{sort:{ascending:true},cursor:{limit:100,...cursor},filter:{withPhoto:-1}}};
    const data=await requestJson(CONTENT_API+'/content/v2/get/cards/list',{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json',Authorization:token},body:JSON.stringify(body)},'WB Content cards');
    const batch=Array.isArray(data?.cards)?data.cards:[];cards.push(...batch.map(normalizeWbCard).filter(card=>card.vendorCode&&card.sizes.length));
    if(!batch.length||batch.length<100)break;
    const next=data?.cursor||{};if(!next.updatedAt||!next.nmID)break;cursor={updatedAt:next.updatedAt,nmID:next.nmID};
  }
  return cards;
}
async function warehouseId(token,market){
  const rows=await pool.query('SELECT raw_json FROM marketplace_order_lines WHERE market=$1 ORDER BY creation_date DESC LIMIT 500',[market]);
  const recent=new Set();
  for(const row of rows.rows){const value=String(parse(row.raw_json)?.order?.warehouseId||'').trim();if(value)recent.add(value)}
  const data=await requestJson(MARKETPLACE_API+'/api/v3/warehouses',{headers:{Accept:'application/json',Authorization:token}},'WB warehouses');
  const active=(Array.isArray(data)?data:[]).filter(row=>!row?.isDeleting&&row?.id!=null);
  if(recent.size===1&&(!active.length||active.some(row=>String(row.id)===[...recent][0])))return [...recent][0];
  if(active.length===1)return String(active[0].id);
  return '';
}
async function readStocks(token,warehouse,ids){
  const values=new Map(),all=[...new Set(ids.map(Number).filter(Boolean))];
  for(let i=0;i<all.length;i+=1000){
    const data=await requestJson(MARKETPLACE_API+'/api/v3/stocks/'+encodeURIComponent(warehouse),{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json',Authorization:token},body:JSON.stringify({chrtIds:all.slice(i,i+1000)})},'WB stocks');
    for(const row of Array.isArray(data?.stocks)?data.stocks:[]){const id=Number(row?.chrtId||0);if(id)values.set(id,Math.max(0,Math.floor(Number(row?.amount)||0)))}
  }
  return values;
}
async function writeStocks(token,warehouse,items){
  for(let i=0;i<items.length;i+=1000)await requestJson(MARKETPLACE_API+'/api/v3/stocks/'+encodeURIComponent(warehouse),{method:'PUT',headers:{Accept:'application/json','Content-Type':'application/json',Authorization:token},body:JSON.stringify({stocks:items.slice(i,i+1000)})},'WB stock update');
}
export async function syncWbStockMarket(market,{write=true}={}){
  const id=String(market||'').toUpperCase()==='WB1'?'WB':String(market||'').toUpperCase();
  if(!/^WB(?:[2-9]\d*|1\d+)?$/.test(id))throw new Error('Unsupported WB market');
  const token=await credentialFor(id,id==='WB2'?config.wbToken2:config.wbToken);
  if(!token)return {ok:false,market:id,skipped:true,reason:'token-not-configured'};
  const stateRow=await pool.query('SELECT payload FROM warehouse_state WHERE id=1');
  const state=parse(stateRow.rows[0]?.payload),availability=sharedAvailable(state),field=id==='WB2'?'wb2':'wb';
  // Variant-group rows are display-only parents. Their children carry the real
  // WB barcode and characteristic ID, so never send the parent as a stock item.
  const linked=[...availability.products.values()].filter(product=>String(product?.[field]||'').trim()&&String(product?.kind||'')!=='variant-group');
  if(linked.length<20)return {ok:false,market:id,skipped:true,reason:'warehouse-safety-gate',linked:linked.length};
  const cards=await catalog(token),byCode=new Map(cards.map(card=>[String(card.vendorCode).trim(),card])),byChrt=new Map(),byBarcode=new Map();
  for(const card of cards)for(const size of card.sizes){
    byChrt.set(Number(size.chrtId),{card,size});
    for(const barcode of size.barcodes||[])if(!byBarcode.has(String(barcode).trim()))byBarcode.set(String(barcode).trim(),{card,size});
  }
  const unresolved=[],candidates=[];
  for(const product of linked){
    const sku=String(product[field]).trim(),aliases=[sku,...(Array.isArray(product?.[field+'Aliases'])?product[field+'Aliases']:[])].map(value=>String(value||'').trim()).filter(Boolean);
    const variant=product?.wbVariant&&String(product.wbVariant.market||'').toUpperCase()===id?product.wbVariant:null;
    let hit=variant?.chrtId?byChrt.get(Number(variant.chrtId)):null;
    if(!hit){
      const single=aliases.map(value=>byCode.get(value)).find(card=>card?.sizes?.length===1);
      hit=single?{card:single,size:single.sizes[0]}:aliases.map(value=>byBarcode.get(value)).find(Boolean);
    }
    if(!hit){unresolved.push({sku,name:String(product?.name||''),reason:'article-or-barcode-not-found'});continue}
    candidates.push({chrtId:Number(hit.size.chrtId),amount:availability.amount(product.id),sku,name:String(product?.name||'')});
  }
  const duplicates=new Set(),seenChrt=new Set();
  for(const item of candidates){if(seenChrt.has(item.chrtId))duplicates.add(item.chrtId);seenChrt.add(item.chrtId)}
  const items=candidates.filter(item=>!duplicates.has(item.chrtId));
  for(const item of candidates)if(duplicates.has(item.chrtId))unresolved.push({sku:item.sku,name:item.name,reason:'duplicate-characteristic'});
  // Exact matches are safe to update even when unrelated legacy rows remain
  // unlinked. Unresolved rows are deliberately left untouched.
  if(!items.length||!items.some(item=>item.amount>0))return {ok:false,market:id,skipped:true,reason:'zero-payload-safety',linked:linked.length,unresolved:unresolved.slice(0,50)};
  const warehouse=await warehouseId(token,id);
  if(!warehouse)return {ok:false,market:id,skipped:true,reason:'warehouse-not-unique',linked:linked.length};
  const actual=await readStocks(token,warehouse,items.map(item=>item.chrtId));
  const changed=items.filter(item=>(actual.get(item.chrtId)||0)!==item.amount);
  if(write&&changed.length)await writeStocks(token,warehouse,changed.map(item=>({chrtId:item.chrtId,amount:item.amount})));
  return {ok:true,market:id,warehouseId:warehouse,linked:linked.length,mapped:items.length,unresolved:unresolved.slice(0,50),changed:changed.length,sent:write&&changed.length>0,items:items.slice(0,100)};
}
