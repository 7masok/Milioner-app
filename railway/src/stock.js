import express from 'express';
import { pool } from './db.js';
import { asyncRoute, requireTrustedOrigin } from './http.js';

export const stockRouter = express.Router();

function n(value, fallback = 0) {
  const x = Number(value);
  return Number.isFinite(x) ? x : fallback;
}
function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
function xmlDecode(value) {
  return String(value || '')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}
function xmlAttr(tag, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*(["'])([^"']*)\\1`, 'i').exec(String(tag || ''));
  return m ? xmlDecode(m[2]) : '';
}
function setXmlAttr(tag, name, value) {
  const safe = esc(value);
  const re = new RegExp(`(\\s${name}\\s*=\\s*)(["'])([^"']*)\\2`, 'i');
  if (re.test(tag)) return tag.replace(re, (_m, prefix) => `${prefix}"${safe}"`);
  return tag.replace(/\s*\/?>$/, tail => ` ${name}="${safe}"${tail.trim().startsWith('/') ? '/>' : '>'}`);
}
function makeAvailability(storeId, available, stockCount) {
  return `<availability storeId="${esc(storeId)}" available="${available ? 'yes' : 'no'}" stockCount="${Math.max(0, Math.floor(stockCount))}"/>`;
}
function normalizeProductName(value){return String(value||'').toLowerCase().replace(/ё/g,'е').replace(/[^a-zа-я0-9]+/gi,' ').trim().replace(/\s+/g,' ')}
function recoveryProduct(products,model,hints=[]){const target=normalizeProductName(model),named=(products||[]).map(product=>({product,name:normalizeProductName(product?.name)})),matches=named.filter(x=>x.name.length>=4&&(target.includes(x.name)||x.name.includes(target))).sort((a,b)=>b.name.length-a.name.length);if(matches.length&&(!matches[1]||matches[0].name.length!==matches[1].name.length))return matches[0].product;for(const rawHint of hints){const hint=normalizeProductName(rawHint),hintMatches=named.filter(x=>hint&&x.name.includes(hint));if(hintMatches.length===1)return hintMatches[0].product}return null}

/* One-time recovery for offers that were archived when the first Railway template contained only 92 items. */
const KASPI_RECOVERY_OFFERS = [
  ['099973580', 'Брелок LuxAr Скелет 7 см металл 1 шт', 790],
  ['521547783', 'Брелок LuxAr Cat Crazy 6 см металл 1 шт', 690, ['cat crazy','кот crazy','кот сумасш','сумасшедш']],
  ['812896427', 'Брелок LuxAr Рулетка Казино Красный 5 см пластик 1 шт', 990],
  ['514147108', 'Брелок LuxAr Годжо Сатору Черный 13 см текстиль 1 шт', 990],
  ['407734445', 'Брелок LuxAr Wednesday Вещь 5 см силикон 1 шт', 790],
  ['737386976', 'Брелок LuxAr Череп Золотистый 6 см металл 1 шт', 390, ['череп золот']],
  ['788701897', 'Брелок LuxAr Рулетка Казино Розовый 5 см пластик 1 шт', 990],
  ['192382685', 'Брелок LuxAr Клавиши 10 см пластик 1 шт', 590, ['клавиш']],
  ['898332897', 'Брелок LuxAr Рулетка Казино Синий 5 см пластик 1 шт', 990, ['казино син']],
  ['908343573', 'Брелок LuxAr Череп Черный 6 см металл 1 шт', 390]
].map(([sku, model, price, hints=[]]) => ({ sku, model, price, hints }));

function appendOffers(rawXml, offers) {
  if (!offers.length) return rawXml;
  const xml = offers.map(({ sku, model, price, stock, storeId }) => `    <offer sku="${esc(sku)}"><model>${esc(model)}</model><brand>LuxAr</brand><availabilities>${makeAvailability(storeId, stock > 0, stock)}</availabilities><price>${Math.max(0, Math.floor(price))}</price></offer>`).join('\n');
  return /<\/offers\s*>/i.test(rawXml) ? rawXml.replace(/<\/offers\s*>/i, `${xml}\n  </offers>`) : rawXml;
}

function mergeMissingTemplateOffers(nextXml, previousXml) {
  const next = templateInfo(nextXml), missing = [];
  const offerRe = /<offer\b[^>]*\bsku\s*=\s*(["'])([^"']+)\1[^>]*>[\s\S]*?<\/offer>/gi;
  let match;
  while ((match = offerRe.exec(String(previousXml || '')))) {
    const sku = xmlDecode(match[2]).trim();
    if (sku && !next.offers.has(sku)) missing.push(match[0]);
  }
  if (!missing.length || !/<\/offers\s*>/i.test(nextXml)) return nextXml;
  return nextXml.replace(/<\/offers\s*>/i, `${missing.join('\n')}\n  </offers>`);
}

function parsePayload(value){try{const x=typeof value==='string'?JSON.parse(value):value;return x&&typeof x==='object'?x:{}}catch{return {}}}
function isBundle(product){return String(product?.kind||'simple')==='bundle'&&Array.isArray(product?.components)&&product.components.length>0}
function bundleParts(product){return isBundle(product)?product.components.map(x=>({productId:String(x?.productId||''),qty:Math.max(1,Math.floor(n(x?.qty,1))||1)})).filter(x=>x.productId):[]}
/* Kaspi receives only stock that remains free after every active order, including bundles. */
function warehouseAvailability(snapshot){
  const products=Array.isArray(snapshot?.products)?snapshot.products:[],reservations=(Array.isArray(snapshot?.reservations)?snapshot.reservations:[]).filter(x=>x?.active),byId=new Map(products.map(x=>[String(x?.id||''),x]).filter(([id])=>id));
  function unitsInside(productId,targetId,seen=new Set()){const id=String(productId||'');if(!id||seen.has(id))return 0;if(id===targetId)return 1;const p=byId.get(id);if(!p||!isBundle(p))return 0;const next=new Set(seen);next.add(id);return bundleParts(p).reduce((sum,part)=>sum+part.qty*unitsInside(part.productId,targetId,next),0)}
  const reserved=new Map();
  for(const p of products){if(isBundle(p))continue;const id=String(p?.id||'');reserved.set(id,reservations.reduce((sum,row)=>sum+Math.max(0,n(row?.qty,0))*unitsInside(row?.productId,id),0))}
  const cache=new Map();
  function available(productId,seen=new Set()){const id=String(productId||'');if(!id||seen.has(id))return 0;if(cache.has(id))return cache.get(id);const p=byId.get(id);if(!p)return 0;const next=new Set(seen);next.add(id);const parts=bundleParts(p),qty=isBundle(p)?(parts.length?Math.max(0,Math.floor(Math.min(...parts.map(part=>available(part.productId,next)/part.qty)))):0):Math.max(0,Math.floor(n(p.stock,0)-n(reserved.get(id),0)));cache.set(id,qty);return qty}
  return {products:byId,available};
}
function templateInfo(rawXml){
  const offers=new Map(),storeIds=new Set(),offerRe=/<offer\b[^>]*\bsku\s*=\s*(["'])([^"']+)\1[^>]*>[\s\S]*?<\/offer>/gi;let match;
  while((match=offerRe.exec(String(rawXml||'')))){const whole=match[0],sku=xmlDecode(match[2]).trim();if(!sku||offers.has(sku))continue;const stores=new Set(),availabilityRe=/<availability\b[^>]*\bstoreId\s*=\s*(["'])([^"']+)\1[^>]*\/?>/gi;let availability;while((availability=availabilityRe.exec(whole))){const storeId=xmlDecode(availability[2]).trim();if(storeId){stores.add(storeId);storeIds.add(storeId)}}offers.set(sku,{stores})}
  return {offers,storeIds:[...storeIds]};
}
async function warehouseKaspiRows(){
  const stateResult=await pool.query('SELECT payload FROM warehouse_state WHERE id=1');
  const snapshot=parsePayload(stateResult.rows[0]?.payload),availability=warehouseAvailability(snapshot),combined=new Map();
  for(const product of(Array.isArray(snapshot.products)?snapshot.products:[])){
    const productId=String(product?.id||''),aliases=Array.isArray(product?.kaspiAliases)?product.kaspiAliases:[];
    for(const rawSku of [product?.kaspi,...aliases]){const sku=String(rawSku||'').trim();if(!sku||combined.has(sku))continue;combined.set(sku,{sku,productId,name:String(product?.name||''),stock:availability.available(productId)})}
  }
  return [...combined.values()].sort((a,b)=>a.sku.localeCompare(b.sku));
}
function feedUrl(req){const host=String(req.get('x-forwarded-host')||req.get('host')||'').split(',')[0].trim(),protocol=String(req.get('x-forwarded-proto')||req.protocol||'https').split(',')[0].trim()||'https';return host?`${protocol}://${host}/kaspi/price-list.xml`:''}
async function kaspiStockFeedStatus(req){
  const [template,rows,access]=await Promise.all([liveTemplate(),warehouseKaspiRows(),pool.query('SELECT last_fetched_at AS "lastFetchedAt",fetch_count AS "fetchCount" FROM kaspi_price_feed_access WHERE id=1').catch(()=>({rows:[]}))]);
  const rawXml=String(template?.rawXml||''),info=templateInfo(rawXml),primaryStoreId=String(template?.primaryStoreId||'').trim()||info.storeIds[0]||'',effective=new Set(info.offers.keys()),missingSkus=rows.filter(row=>!effective.has(row.sku)).map(row=>row.sku),missingPrimaryStore=primaryStoreId?rows.filter(row=>info.offers.has(row.sku)&&!info.offers.get(row.sku).stores.has(primaryStoreId)).map(row=>row.sku):[],configured=Boolean(rawXml),ready=configured&&Boolean(primaryStoreId);
  return {ok:true,configured,ready,primaryStoreId,storeIds:info.storeIds,templateOfferCount:info.offers.size,offerCount:effective.size,recoveredOffers:0,linked:rows.length,matched:rows.length-missingSkus.length,missingSkus,missingPrimaryStore,lastFetchedAt:Number(access.rows[0]?.lastFetchedAt||0),fetchCount:Number(access.rows[0]?.fetchCount||0),feedUrl:ready?feedUrl(req):'',error:configured&&!primaryStoreId?'В XML не найден склад Kaspi (availability storeId).':''};
}

async function liveTemplate() {
  const row = await pool.query('SELECT raw_xml AS "rawXml", primary_store_id AS "primaryStoreId" FROM kaspi_price_template WHERE id=1');
  return row.rows[0] || null;
}
async function liveKaspiXml() {
  const [template,rows,stateResult]=await Promise.all([liveTemplate(),warehouseKaspiRows(),pool.query('SELECT payload FROM warehouse_state WHERE id=1')]),stocks=new Map(rows.map(row=>[row.sku,row.stock]));
  if(!template?.rawXml){const offers=rows.map(row=>`    <offer sku="${esc(row.sku)}"><stockCount>${row.stock}</stockCount></offer>`).join('\n');return `<?xml version="1.0" encoding="UTF-8"?>\n<kaspi_catalog date="${new Date().toISOString()}">\n  <offers>\n${offers}\n  </offers>\n</kaspi_catalog>`;}
  let raw=String(template.rawXml),info=templateInfo(raw),primaryStoreId=String(template.primaryStoreId||'').trim()||info.storeIds[0]||'';
  if(!primaryStoreId)throw new Error('Kaspi primary store is not configured');
  const snapshot=parsePayload(stateResult.rows[0]?.payload),availability=warehouseAvailability(snapshot),products=[...availability.products.values()],recovered=[];
  for(const offer of KASPI_RECOVERY_OFFERS){if(info.offers.has(offer.sku))continue;const product=recoveryProduct(products,offer.model,offer.hints);if(!product)continue;const stock=availability.available(String(product.id||''));recovered.push({...offer,stock,storeId:primaryStoreId});stocks.set(offer.sku,stock)}
  raw=appendOffers(raw,recovered);
  const offerRe=/<offer\b[^>]*\bsku\s*=\s*(["'])([^"']+)\1[^>]*>[\s\S]*?<\/offer>/gi;
  return raw.replace(offerRe,(whole,_quote,encodedSku)=>{
    const sku=xmlDecode(encodedSku).trim();if(!stocks.has(sku))return whole;
    const stock=Math.max(0,stocks.get(sku)||0),openingEnd=whole.indexOf('>');if(openingEnd<0)return whole;
    const opening=whole.slice(0,openingEnd+1),body=whole.slice(openingEnd+1,-'</offer>'.length);let foundPrimary=false;
    const updated=body.replace(/<availability\b[^>]*\/?>/gi,tag=>{const storeId=xmlAttr(tag,'storeId');if(!storeId)return tag;if(storeId===primaryStoreId){foundPrimary=true;return setXmlAttr(setXmlAttr(tag,'available',stock>0?'yes':'no'),'stockCount',String(stock))}return setXmlAttr(setXmlAttr(tag,'available','no'),'stockCount','0')});
    return `${opening}${foundPrimary?updated:updated+makeAvailability(primaryStoreId,stock>0,stock)}</offer>`;
  });
}

export async function kaspiFeedRows(){return warehouseKaspiRows()}


export const kaspiFeedHandler = asyncRoute(async (req,res) => {
  try {
    const xml=await liveKaspiXml();
    await pool.query(`INSERT INTO kaspi_price_feed_access(id,last_fetched_at,fetch_count,last_user_agent) VALUES(1,$1,1,$2) ON CONFLICT(id) DO UPDATE SET last_fetched_at=EXCLUDED.last_fetched_at,fetch_count=kaspi_price_feed_access.fetch_count+1,last_user_agent=EXCLUDED.last_user_agent`,[Date.now(),String(req.get('user-agent')||'').slice(0,500)]).catch(()=>{});
    res.type('application/xml').set('Cache-Control','no-store, max-age=0').send(xml);
  } catch(error){res.status(502).json({ok:false,error:String(error?.message||error)})}
});

stockRouter.get('/stock-sync-status', requireTrustedOrigin, asyncRoute(async (_req, res) => {
  const result = await pool.query(`
    SELECT COUNT(*)::int AS links,
           COUNT(*) FILTER (WHERE p.updated_at IS NULL)::int AS missing_updates,
           MAX(p.updated_at) AS last_product_update
    FROM product_links pl
    JOIN products p ON p.id=pl.product_id
    WHERE pl.market='Kaspi'
  `);
  res.json({ ok:true, market:'Kaspi', ...result.rows[0] });
}));

stockRouter.get('/kaspi-live-stock-status',asyncRoute(async (_req,res)=>{const rows=await warehouseKaspiRows();res.json({ok:true,source:'Railway warehouse state minus active reservations',linked:rows.length,positive_stock:rows.filter(row=>row.stock>0).length,zero_stock:rows.filter(row=>row.stock<=0).length})}));
stockRouter.get('/kaspi-stock-feed-status',requireTrustedOrigin,asyncRoute(async (req,res)=>{res.json(await kaspiStockFeedStatus(req))}));
stockRouter.put('/kaspi-price-template',requireTrustedOrigin,asyncRoute(async (req,res)=>{
  const existing=await liveTemplate(),hasXml=typeof req.body?.xml==='string';let rawXml=hasXml?String(req.body.xml||'').trim():String(existing?.rawXml||'');
  if(!rawXml){const error=new Error('Выберите полный XML-прайс Kaspi.');error.status=400;throw error}
  if(Buffer.byteLength(rawXml,'utf8')>6_000_000){const error=new Error('XML больше 6 МБ.');error.status=413;throw error}
  if(hasXml&&existing?.rawXml)rawXml=mergeMissingTemplateOffers(rawXml,String(existing.rawXml));
  const info=templateInfo(rawXml);if(!info.offers.size){const error=new Error('В XML не найдено ни одного offer с Kaspi SKU.');error.status=400;throw error}
  const requestedPrimary=String(req.body?.primaryStoreId||'').trim(),primaryStoreId=requestedPrimary||String(existing?.primaryStoreId||'').trim()||info.storeIds[0]||'';
  if(requestedPrimary&&info.storeIds.length&&!info.storeIds.includes(requestedPrimary)){const error=new Error('Выбранный склад отсутствует в XML Kaspi.');error.status=400;throw error}
  await pool.query(`INSERT INTO kaspi_price_template(id,raw_xml,feed_key,primary_store_id,offer_count,store_ids,merchant_id,updated_at) VALUES(1,$1,'',$2,$3,$4,'',$5) ON CONFLICT(id) DO UPDATE SET raw_xml=EXCLUDED.raw_xml,primary_store_id=EXCLUDED.primary_store_id,offer_count=EXCLUDED.offer_count,store_ids=EXCLUDED.store_ids,updated_at=EXCLUDED.updated_at`,[rawXml,primaryStoreId,info.offers.size,JSON.stringify(info.storeIds),Date.now()]);
  res.json(await kaspiStockFeedStatus(req));
}));

export { liveKaspiXml };
