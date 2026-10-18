// Read-only unit-profit estimates. No WB requests, price writes or stock/FIFO mutations.
const DAY=86400000;
const text=v=>String(v??'').trim();
const object=v=>{if(v&&typeof v==='object')return v;try{return JSON.parse(v||'{}')}catch{return {}}};
const numeric=v=>v!==null&&v!==undefined&&text(v)!==''&&Number.isFinite(Number(v))?Number(v):null;
const pick=(raw,keys,fallback=null)=>{for(const k of keys)if(raw[k]!==undefined&&raw[k]!==null&&text(raw[k])!=='')return raw[k];return fallback};
const currency=v=>({643:'RUB',398:'KZT',RUB:'RUB',KZT:'KZT','РУБ':'RUB','РУБ.':'RUB','ТЕНГЕ':'KZT'}[text(v).toUpperCase()]||null);
function time(v){const n=Number(v);if(Number.isFinite(n)&&n>0)return n<1e12?n*1000:n;return Date.parse(v)||0}
export function wbObservedExchangeRate(rows,now=Date.now()){
 const samples=[],seen=new Set();
 for(const row of [...rows].sort((a,b)=>Number(b.creation_date)-Number(a.creation_date))){
  const container=object(row.raw_json),raw=container.order||container,at=time(row.creation_date||raw.createdAt),key=text(row.order_id||raw.id);
  if(!key||seen.has(key)||!at||at>now||at<now-7*DAY)continue;seen.add(key);
  const from=currency(raw.currencyCode),to=currency(raw.convertedCurrencyCode);
  if(!from||!to||from===to)continue;
  const pairs=[['price','convertedPrice'],['finalPrice','convertedFinalPrice']].map(([a,b])=>{
   const one=numeric(raw[a]),two=numeric(raw[b]);if(!(one>0&&two>0))return null;
   return from==='RUB'?{rub:one,kzt:two}:{rub:two,kzt:one};
  }).filter(Boolean);
  if(!pairs.length)continue;
  const rate=pairs[0].kzt/pairs[0].rub;
  // When both equally discounted pairs exist, contradictory conversions are not a rate.
  if(!(rate>0&&rate<1000)||pairs.some(p=>Math.abs(p.kzt/p.rub/rate-1)>.01))continue;
  samples.push({...pairs[0],at,day:new Date(at+5*3600000).toISOString().slice(0,10)});
 }
 if(!samples.length)return null;
 const day=samples[0].day,latest=samples.filter(s=>s.day===day),sum=key=>latest.reduce((n,s)=>n+s[key],0);
 return {rate:sum('kzt')/sum('rub'),day,samples:latest.length,observedAt:Math.max(...latest.map(s=>s.at)),source:'WB · пары цен одного заказа'};
}
function costResolver(products,purchases){
 const byId=new Map(products.map(p=>[text(p.id),p])),cache=new Map();
 return function cost(pid,seen=new Set()){
  pid=text(pid);if(cache.has(pid))return cache.get(pid);const p=byId.get(pid);if(!p||seen.has(pid))return null;
  const next=new Set(seen);next.add(pid);
  if(p.kind==='bundle'){
   if(!Array.isArray(p.components)||!p.components.length)return null;
   let total=0;for(const part of p.components){const q=numeric(part.qty),unit=cost(part.productId,next);if(!(q>0)||unit===null)return null;total+=q*unit;}cache.set(pid,total);return total;
  }
  let qty=0,value=0;
  const lots=purchases.filter(x=>text(x.productId||x.product_id)===pid);
  const received=lots.filter(x=>(x.status||'received')==='received'&&Number(x.remainingQty)>0);
  const chosen=received.length?received:lots.filter(x=>x.status==='at_warehouse'&&Number(x.qty)>Number(x.warehouseWrittenOffQty||0));
  for(const lot of chosen){const total=numeric(lot.qty),q=lot.status==='at_warehouse'?Math.max(0,Number(lot.qty)-Number(lot.warehouseWrittenOffQty||0)):Number(lot.remainingQty);if(!(total>0&&q>0))continue;
   let unit=numeric(lot.landedUnitCost);if(unit===null){const buy=numeric(lot.buyTotal),base=buy!==null?buy/total:numeric(lot.unitCost);if(base===null||base<0)return null;unit=base+Math.max(0,Number(lot.delivery)||0)/total;}
   if(unit<0)return null;qty+=q;value+=q*unit;
  }
  const result=qty>0?value/qty:(numeric(p.cost)>0?Number(p.cost):null);cache.set(pid,result);return result;
 };
}
export function buildWbPriceProfit({priceRows=[],financeRows=[],orderRows=[],products=[],purchases=[],now=Date.now(),truncated=false}){
 const fx=wbObservedExchangeRate(orderRows,now),groups=new Map(),physicalAttempts=new Map(),seen=new Set();
 for(const row of financeRows){
  const raw=object(row.raw_json),nm=text(pick(raw,['nmId','nm_id'],row.nm_id)),rrd=text(row.rrd_id||raw.rrdId||raw.rrd_id);
  if(!nm||!rrd||seen.has(rrd))continue;seen.add(rrd);
  const op=text(pick(raw,['sellerOperName','supplierOperName','supplier_oper_name'],row.operation||row.doc_type)).toLowerCase();
  const cur=currency(pick(raw,['currency','currency_name','currencyCode','currency_code']));if(!cur)continue;
  const srid=text(pick(raw,['srid','orderUid','order_uid'])),shk=text(pick(raw,['shkId','shk_id'])),identity=srid||shk;
  if(!identity)continue;const key=nm+'|'+cur+'|'+identity;
  let g=groups.get(key);if(!g){g={nm,cur,key,qty:0,revenue:0,withheld:0,sales:0,at:0,delivery:0,deliveryUnits:0,deliveryRows:0,invalid:false,returned:false};groups.set(key,g)}
  if(shk){const physical=nm+'|'+shk,attempts=physicalAttempts.get(physical)||new Set();attempts.add(key);physicalAttempts.set(physical,attempts);g.physical=physical;}
  const ret=numeric(pick(raw,['returnAmount','return_amount']));
  const kind=text(pick(raw,['bonusTypeName','bonus_type_name'])).toLowerCase();
  if(op==='возврат'||text(pick(raw,['docTypeName','doc_type_name'],row.doc_type)).toLowerCase()==='возврат'||ret>0||/отмен|повтор|обратн|возврат|перевыстав/.test(kind))g.returned=true;
  if(op==='продажа'){
   const q=numeric(pick(raw,['quantity','qty'],row.qty)),unit=numeric(pick(raw,['retailPriceWithDisc','retail_price_withdisc_rub'])),payout=numeric(pick(raw,['forPay','ppvzForPay','ppvz_for_pay']));
   if(!(q>0&&unit>0&&payout!==null&&payout>=0&&payout<=q*unit)){g.invalid=true;continue;}
   g.qty+=q;g.revenue+=q*unit;g.withheld+=q*unit-payout;g.sales++;g.at=Math.max(g.at,time(pick(raw,['saleDt','sale_dt'],row.sale_date||row.rr_date)));
  }
  const delivery=numeric(pick(raw,['deliveryService','deliveryRub','delivery_rub'],row.delivery_service));
  const rebill=numeric(pick(raw,['rebillLogisticCost','rebill_logistic_cost'],row.rebill_logistic_cost));
  if(rebill>0)g.returned=true;
  if(delivery!==null&&delivery!==0){
   const units=numeric(pick(raw,['deliveryAmount','delivery_amount']));
   if(delivery<0||!(units>0)||!['продажа','логистика','доставка'].includes(op)){g.invalid=true;continue;}
   g.delivery+=delivery;g.deliveryUnits+=units;g.deliveryRows++;
  }
 }
 const byNm=new Map();for(const g of groups.values()){if(!byNm.has(g.nm))byNm.set(g.nm,[]);byNm.get(g.nm).push(g)}
 const cost=costResolver(products,purchases),models=[];
 for(const price of priceRows){
  const nm=text(price.remoteId),unitCostKzt=cost(price.productId);
  const good=(byNm.get(nm)||[]).filter(g=>!g.invalid&&!g.returned&&g.qty>0&&g.sales===1&&g.deliveryRows===1&&g.deliveryUnits===g.qty&&g.at>=now-90*DAY&&g.at<=now&&(!g.physical||physicalAttempts.get(g.physical)?.size===1));
  const recent=good.filter(g=>g.at>=now-30*DAY),window=recent.length?recent:good;
  // Never add raw monetary amounts from different currencies. Prefer the seller's settlement currency.
  const cur=window.some(g=>g.cur==='KZT')?'KZT':'RUB',sample=window.filter(g=>g.cur===cur),sum=k=>sample.reduce((n,g)=>n+g[k],0),qty=sum('qty'),revenue=sum('revenue');
  const feesRate=revenue>0?sum('withheld')/revenue:null,logisticsPerUnit=qty>0?sum('delivery')/qty:null;
  const missing=truncated?'Слишком много операций для надёжного расчёта':!sample.length?'Нет завершённых продаж с одной обычной доставкой':!fx?'Нет свежей пары цен ₽/₸ в заказах WB':unitCostKzt===null?'Неизвестна себестоимость':null;
  models.push({nmId:nm,available:!missing,reason:missing,feesRate,logisticsPerUnit,expenseCurrency:sample.length?cur:null,unitCostKzt,fx,days:recent.length?30:90,sampleUnits:qty,sampleSales:sample.length,lastSaleAt:sample.length?Math.max(...sample.map(g=>g.at)):null});
 }
 return {ok:true,computedAt:now,models,fx,basis:'Одна успешная продажа; комиссия и эквайринг, одна доставка, себестоимость. Без рекламы, налогов, отмен и повторных доставок.'};
}
const cached=new Map(),running=new Map();
export async function loadWbPriceProfit(market,client,now=Date.now()){
 const hit=cached.get(market);if(hit&&now-hit.at<5*60000)return hit.data;
 if(running.has(market))return running.get(market);
 const task=(async()=>{
  const snapshot=await client.query('SELECT payload FROM wb_price_snapshots WHERE market=$1',[market]);
  const priceRows=object(snapshot.rows[0]?.payload).rows||[],ids=[...new Set(priceRows.map(row=>text(row.remoteId)).filter(Boolean))];
  const [finance,orders,productRows,purchaseRows]=await Promise.all([
   client.query('SELECT * FROM wb_finance_rows WHERE market=$1 AND rr_date >= $2 AND nm_id=ANY($3::text[]) ORDER BY rr_date DESC,rrd_id LIMIT 50001',[market,now-90*DAY,ids]),
   client.query('SELECT order_id,creation_date,raw_json FROM marketplace_order_lines WHERE market=$1 AND creation_date >= $2 ORDER BY creation_date DESC LIMIT 1000',[market,now-7*DAY]),
   client.query('SELECT payload FROM warehouse_products'),client.query("SELECT payload FROM warehouse_purchases WHERE status IN ('received','at_warehouse') LIMIT 50001")
  ]);
  const data=buildWbPriceProfit({priceRows,financeRows:finance.rows,orderRows:orders.rows,products:productRows.rows.map(x=>object(x.payload)),purchases:purchaseRows.rows.map(x=>object(x.payload)),now,truncated:finance.rows.length>50000||purchaseRows.rows.length>50000});cached.set(market,{at:now,data});return data;
 })();running.set(market,task);try{return await task}finally{running.delete(market)}
}
