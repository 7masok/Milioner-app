import crypto from 'node:crypto';
export const FBO_SOURCE='FBO';
const list=x=>Array.isArray(x)?x:[];
const num=x=>Math.max(0,Number(x)||0);
export const fail=(message,status=409)=>{throw Object.assign(Error(message),{status})};
export const uid=(...x)=>crypto.createHash('sha256').update(x.join('|')).digest('hex').slice(0,28);
export function parts(state,productId,units=1,seen=new Set()){
 const p=list(state.products).find(p=>String(p.id)===String(productId));if(!p||p.kind==='variant-group')fail('Товар склада не найден');
 if(seen.has(String(p.id)))fail('В составе набора есть цикл');
 if(p.kind!=='bundle')return[{product:p,qty:units}];
 if(!list(p.components).length)fail('У набора нет состава');
 const result=new Map(),next=new Set(seen);next.add(String(p.id));
 for(const c of p.components){if(!Number.isSafeInteger(Number(c.qty))||Number(c.qty)<=0)fail('Некорректный состав набора');for(const x of parts(state,c.productId,units*Number(c.qty),next)){const id=String(x.product.id),old=result.get(id);if(old)old.qty+=x.qty;else result.set(id,x)}}return[...result.values()];
}
export function warehouseQty(lot){return lot.status==='at_warehouse'?Math.max(0,num(lot.qty)-num(lot.warehouseWrittenOffQty)):0}
export function inventory(state,{excludeDraft=''}={}){
 const pool=new Map(),lots=new Map();
 for(const p of list(state.products).filter(p=>p.kind!=='bundle'&&p.kind!=='variant-group'))pool.set(String(p.id),{product:p,sale:num(p.stock),warehouse:0,customerReserve:0,fboSale:0,fboWarehouse:0,lots:[]});
 for(const lot of list(state.purchases)){const n=warehouseQty(lot),p=pool.get(String(lot.productId));if(n&&p){const row={lot,available:n};p.lots.push(row);p.warehouse+=n;lots.set(String(lot.id),row)}}
 for(const r of list(state.reservations).filter(r=>r.active&&!(r.source===FBO_SOURCE&&r.draftId===excludeDraft))){
  if(r.source===FBO_SOURCE){const p=pool.get(String(r.productId));if(!p)continue;p.fboSale+=num(r.qty);p.fboWarehouse+=num(r.warehouseQty);for(const x of list(r.warehouseLots)){const row=lots.get(String(x.purchaseId));if(row)row.available=Math.max(0,row.available-num(x.qty))}}
  else{try{for(const c of parts(state,r.productId,num(r.qty))){const p=pool.get(String(c.product.id));if(p)p.customerReserve+=c.qty}}catch{}}
 }
 for(const p of pool.values()){p.sale=Math.max(0,p.sale-p.customerReserve-p.fboSale);p.warehouse=Math.max(0,p.warehouse-p.fboWarehouse);p.lots.sort((a,b)=>num(a.lot.warehouseReceivedAt||a.lot.receivedAt||a.lot.orderedAt||a.lot.date)-num(b.lot.warehouseReceivedAt||b.lot.receivedAt||b.lot.orderedAt||b.lot.date))}
 return pool;
}
export function availability(state,productId,pool=inventory(state)){
 try{const ps=parts(state,productId),amount=field=>Math.max(0,Math.floor(Math.min(...ps.map(c=>num(pool.get(String(c.product.id))?.[field])/c.qty))));return{available:Math.max(0,Math.floor(Math.min(...ps.map(c=>{const p=pool.get(String(c.product.id));return(num(p?.sale)+num(p?.warehouse))/c.qty})))),sale:amount('sale'),warehouse:amount('warehouse'),reservedForFbo:Math.max(0,Math.floor(Math.min(...ps.map(c=>{const p=pool.get(String(c.product.id));return(num(p?.fboSale)+num(p?.fboWarehouse))/c.qty}))))}}catch{return{available:null,sale:null,warehouse:null,reservedForFbo:null}}
}
export function allocate(state,productId,qty,pool){
 const plans=[];for(const c of parts(state,productId,qty)){const p=pool.get(String(c.product.id));if(!p||p.sale+p.warehouse<c.qty)fail('Недостаточно товара «'+c.product.name+'»: нужно '+c.qty+', доступно '+((p?.sale||0)+(p?.warehouse||0))+' шт.');const wh=Math.min(c.qty,p.warehouse),sale=c.qty-wh,lots=[];let need=wh;
 for(const row of p.lots){const take=Math.min(need,row.available);if(take){lots.push({purchaseId:String(row.lot.id),qty:take});row.available-=take;need-=take}if(!need)break}if(need)fail('Недостаточно свободных складских партий');p.warehouse-=wh;p.sale-=sale;plans.push({productId:String(c.product.id),qty:sale,warehouseQty:wh,warehouseLots:lots})}
 return plans;
}
export function resolver(state,stockRows=[]){
 const identifiers=new Map();for(const row of stockRows){const ids=[row.offer_id,row.product_id,...list(row.stocks).map(x=>x.sku)].map(x=>String(x??'').trim()).filter(Boolean);for(const id of ids){const set=identifiers.get(id)||new Set();for(const x of ids)set.add(x);identifiers.set(id,set)}}
 const products=list(state.products).filter(p=>p.kind!=='variant-group');return sku=>{const ids=new Set([String(sku),...(identifiers.get(String(sku))||[])]),matches=products.filter(p=>[p.ozon,...(Array.isArray(p.ozonAliases)?p.ozonAliases:String(p.ozonAliases||'').split(/[;,\n]/))].some(x=>ids.has(String(x??'').trim())));return matches.length===1?{product:matches[0],ambiguous:false}:{product:null,ambiguous:matches.length>1}};
}
export function draftGroups(state){
 const groups=new Map();for(const r of list(state.reservations).filter(r=>r.source===FBO_SOURCE&&r.draftId)){if(!groups.has(r.draftId))groups.set(r.draftId,{id:r.draftId,title:r.draftTitle,account:r.account,status:r.stage,createdAt:r.date,orderId:r.orderId||'',signature:r.signature,lines:[],rows:[]});const g=groups.get(r.draftId);g.rows.push(r);if(!g.lines.some(x=>x.id===r.lineId)){const p=list(state.products).find(p=>String(p.id)===String(r.skuProductId));g.lines.push({id:r.lineId,sku:r.sku,productId:r.skuProductId,name:p?.name||r.productName,cluster:r.cluster,clusterKey:r.clusterKey,qty:r.skuQty})}}
 return[...groups.values()].sort((a,b)=>num(b.createdAt)-num(a.createdAt));
}
export function createDraft(state,input,resolve,account,now=Date.now()){
 if(!/^[a-zA-Z0-9_-]{8,100}$/.test(String(input.id||'')))fail('Некорректный номер плана',400);
 const lines=list(input.lines);if(!lines.length||lines.length>200)fail('В плане должно быть от 1 до 200 строк',400);
 const clean=lines.map(x=>{if(!x||typeof x.sku!=='string'||!x.sku||x.sku.length>80||typeof x.clusterKey!=='string'||x.clusterKey.length>350||!x.clusterKey||!Number.isSafeInteger(x.qty)||x.qty<1||x.qty>100000)fail('Проверьте товар, кластер и количество',400);return{sku:x.sku,clusterKey:x.clusterKey,cluster:String(x.cluster||'').slice(0,300),qty:x.qty}}).sort((a,b)=>(a.sku+'|'+a.clusterKey).localeCompare(b.sku+'|'+b.clusterKey));
 if(new Set(clean.map(x=>x.sku+'|'+x.clusterKey)).size!==clean.length)fail('В плане повторяется товар и кластер',400);
 const signature=uid(account,JSON.stringify(clean),String(input.title||'План FBO').trim().slice(0,160)),existing=draftGroups(state).find(d=>d.id===input.id);if(existing){if(existing.signature!==signature)fail('Этот номер уже использован другим планом');return{draft:existing,changed:false}}
 const pool=inventory(state),rows=[];for(const line of clean){const match=resolve(line.sku);if(!match.product)fail('SKU '+line.sku+': сначала привяжите один товар склада');const lineId=uid(input.id,line.sku,line.clusterKey);for(const allocation of allocate(state,match.product.id,line.qty,pool))rows.push({...allocation,id:'fbo-'+uid(input.id,lineId,allocation.productId),source:FBO_SOURCE,externalKey:input.id+':'+lineId+':'+allocation.productId,active:true,stage:'reserved',date:now,updatedAt:now,draftId:input.id,draftTitle:String(input.title||'План FBO').trim().slice(0,160),signature,account,lineId,sku:line.sku,skuProductId:String(match.product.id),productName:match.product.name,skuQty:line.qty,cluster:line.cluster,clusterKey:line.clusterKey})}
 state.reservations=[...list(state.reservations),...rows];return{draft:draftGroups(state).find(d=>d.id===input.id),changed:true};
}
export function cancelDraft(state,id,now=Date.now()){
 const draft=draftGroups(state).find(d=>d.id===id);if(!draft)fail('План не найден',404);if(draft.status==='sent')fail('Уже отправлена: возврат учитывается только по фактическому приходу');if(draft.status==='cancelled')return{draft,changed:false};for(const r of draft.rows){r.active=false;r.stage='cancelled';r.closedAt=now;r.updatedAt=now}return{draft:draftGroups(state).find(d=>d.id===id),changed:true};
}
function unitCost(lot){const qty=num(lot.qty);if(!qty)return 0;if(lot.landedUnitCost!==null&&lot.landedUnitCost!==undefined&&lot.landedUnitCost!==''&&Number.isFinite(Number(lot.landedUnitCost)))return num(lot.landedUnitCost);return(lot.buyTotal!==null&&lot.buyTotal!==undefined?num(lot.buyTotal)/qty:num(lot.unitCost))+num(lot.delivery)/qty}
export function dispatchDraft(state,id,remote,now=Date.now()){
 const d=draftGroups(state).find(d=>d.id===id);if(!d)fail('План не найден',404);if(d.status==='sent'){if(d.orderId!==String(remote.orderId))fail('Этот план уже отправлен по другой заявке');return{draft:d,changed:false}}if(d.status!=='reserved')fail('План уже отменён');
 const remoteLines=list(remote.lines),aggregated=new Map();for(const x of remoteLines){const key=x.sku+'|'+x.clusterKey;if(!aggregated.has(key))aggregated.set(key,{...x,qty:0});aggregated.get(key).qty+=x.qty}const totals=[...aggregated.values()];if(totals.length!==d.lines.length||totals.some(x=>!d.lines.some(l=>l.sku===x.sku&&l.clusterKey===x.clusterKey&&l.qty===x.qty)))fail('Состав заявки Ozon не совпадает с планом. Проверьте товары, кластеры и количества.');
 const transfers=state.settings?.ozonFboTransfers||{},prefix=d.account+'|'+remote.orderId+'|';if(Object.entries(transfers).some(([k,t])=>k.startsWith(prefix)||String(t.account||k.split('|')[0])===d.account&&remoteLines.some(l=>String(t.supplyId||k.split('|')[2])===String(l.supplyId)&&String(t.sku||k.split('|')[4])===l.sku)))fail('Эта заявка Ozon уже учтена. Повторное списание запрещено.');
 const pool=inventory(state,{excludeDraft:id});for(const r of d.rows){const p=pool.get(String(r.productId));if(!p||p.sale<num(r.qty)||p.warehouse<num(r.warehouseQty))fail('Остаток изменился: пересоберите план');p.sale-=num(r.qty);p.warehouse-=num(r.warehouseQty);for(const x of r.warehouseLots){const lot=p.lots.find(l=>String(l.lot.id)===x.purchaseId);if(!lot||lot.available<x.qty)fail('Зарезервированная партия изменилась');lot.available-=x.qty}}
 state.movements=list(state.movements);state.settings={...state.settings,ozonFboTransfers:{...transfers}};const costs=new Map();
 for(const r of d.rows){const p=list(state.products).find(p=>String(p.id)===r.productId),used=[];let total=0;
  for(const part of r.warehouseLots){const lot=list(state.purchases).find(x=>String(x.id)===part.purchaseId),take=part.qty,cost=unitCost(lot),original=num(lot.qty);total+=take*cost;let released;
   if(take===original){lot.status='received';lot.receivedAt=now;lot.remainingQty=0;released=lot}
   else{const ratio=take/original,buy=lot.buyTotal!==null&&lot.buyTotal!==undefined&&lot.buyTotal!==''&&Number.isFinite(Number(lot.buyTotal))?num(lot.buyTotal):num(lot.unitCost)*original;released={...lot,id:'fbo-lot-'+uid(id,r.id,lot.id),qty:take,buyTotal:buy*ratio,delivery:num(lot.delivery)*ratio,status:'received',receivedAt:now,remainingQty:0,warehouseWrittenOffQty:0};lot.qty=original-take;lot.buyTotal=buy*(1-ratio);lot.delivery=num(lot.delivery)*(1-ratio);state.purchases.unshift(released)}
   used.push({purchaseId:String(released.id),warehousePurchaseId:part.purchaseId,qty:take,unitCost:cost});
  }
  let need=num(r.qty);for(const lot of list(state.purchases).filter(l=>String(l.productId)===r.productId&&!['to_forwarder','to_me','at_warehouse'].includes(l.status)&&num(l.remainingQty)>0).sort((a,b)=>num(a.receivedAt||a.date)-num(b.receivedAt||b.date))){const take=Math.min(need,num(lot.remainingQty)),cost=unitCost(lot);lot.remainingQty-=take;need-=take;total+=take*cost;used.push({purchaseId:String(lot.id),qty:take,unitCost:cost});if(!need)break}if(need){total+=need*num(p.cost);used.push({purchaseId:null,qty:need,unitCost:num(p.cost),fallback:true})}
  p.stock=num(p.stock)-num(r.qty);const remaining=list(state.purchases).filter(l=>String(l.productId)===r.productId&&!['to_forwarder','to_me','at_warehouse'].includes(l.status)&&num(l.remainingQty)>0),q=remaining.reduce((n,l)=>n+num(l.remainingQty),0);if(q)p.cost=remaining.reduce((n,l)=>n+num(l.remainingQty)*unitCost(l),0)/q;
  const extra='Ozon FBO · '+d.title+' · заявка '+remote.orderId;
  if(r.warehouseQty)state.movements.unshift({id:'fbo-in-'+uid(id,r.id),date:now,type:'приход',productId:r.productId,qty:r.warehouseQty,extra:'со склада для отправки · '+extra});
  state.movements.unshift({id:'fbo-out-'+uid(id,r.id),date:now,type:'FBO Ozon',productId:r.productId,qty:-(num(r.qty)+num(r.warehouseQty)),extra,fifoLots:used});
  costs.set(r.lineId,(costs.get(r.lineId)||0)+total);r.active=false;r.stage='sent';r.orderId=String(remote.orderId);r.sentAt=now;r.updatedAt=now;
 }
 for(const line of remoteLines){const own=d.lines.find(x=>x.sku===line.sku&&x.clusterKey===line.clusterKey),key=[d.account,remote.orderId,line.supplyId,line.bundleId,line.sku].map(x=>String(x||'')).join('|');state.settings.ozonFboTransfers[key]={key,productId:own.productId,sku:line.sku,qty:line.qty,account:d.account,orderId:String(remote.orderId),supplyId:line.supplyId,bundleId:line.bundleId,warehouseName:line.warehouse||own.cluster,warehouseId:line.warehouseId||'',crossdock:!!line.crossdock,sentAt:now,unitCost:(costs.get(own.id)||0)/own.qty,stockSource:d.rows.some(r=>r.lineId===own.id&&r.warehouseQty>0)?(d.rows.some(r=>r.lineId===own.id&&r.qty>0)?'mixed':'at_warehouse'):'sale',status:'in_transit',serverDraftId:id}}
 return{draft:draftGroups(state).find(d=>d.id===id),changed:true};
}
export function reservationViolation(previous,next){
 const active=list(previous.reservations).filter(r=>r.source===FBO_SOURCE&&r.active&&!list(next.reservations).some(n=>n.id===r.id&&n.source===FBO_SOURCE&&n.active===false&&['sent','cancelled'].includes(n.stage)));if(!active.length)return null;
 const beforeProducts=new Map(list(previous.products).map(p=>[String(p.id),p])),afterProducts=new Map(list(next.products).map(p=>[String(p.id),p])),afterLots=new Map(list(next.purchases).map(p=>[String(p.id),p])),oldLots=new Map(list(previous.purchases).map(p=>[String(p.id),p]));
 const sale=new Map(),lots=new Map();for(const r of active){sale.set(String(r.productId),(sale.get(String(r.productId))||0)+num(r.qty));for(const x of list(r.warehouseLots))lots.set(String(x.purchaseId),(lots.get(String(x.purchaseId))||0)+num(x.qty))}
 for(const r of list(previous.reservations).filter(r=>r.active&&r.source!==FBO_SOURCE)){try{for(const c of parts(previous,r.productId,num(r.qty))){const id=String(c.product.id);if(sale.has(id))sale.set(id,sale.get(id)+c.qty)}}catch{}}
 for(const [id,qty]of sale){if(!afterProducts.has(id))return{reason:'fbo-reserved-product',productId:id};if(Math.max(0,qty-num(afterProducts.get(id).stock))>Math.max(0,qty-num(beforeProducts.get(id)?.stock)))return{reason:'fbo-reserved-stock',productId:id}}
 for(const [id,qty]of lots)if(String(afterLots.get(id)?.productId||'')!==String(oldLots.get(id)?.productId||'')||Math.max(0,qty-warehouseQty(afterLots.get(id)||{}))>Math.max(0,qty-warehouseQty(oldLots.get(id)||{})))return{reason:'fbo-reserved-purchase',purchaseId:id};return null;
}

export function transferViolation(previous,next){
 const old=previous.settings?.ozonFboTransfers||{},incoming=next.settings?.ozonFboTransfers||{};
 for(const [key,row]of Object.entries(old))if(row?.serverDraftId){const current=incoming[key],stable=x=>JSON.stringify(Object.keys(x||{}).sort().map(k=>[k,x[k]]));if(!current||stable(current)!==stable(row))return{reason:'fbo-transfer-history-protected',transferKey:key};}
 for(const [key,t]of Object.entries(incoming)){if(old[key])continue;const account=String(t?.account||key.split('|')[0]||''),supply=String(t?.supplyId||key.split('|')[2]||''),sku=String(t?.sku||key.split('|')[4]||'');if(!account||!supply||!sku)continue;
  if(Object.entries(old).some(([k,r])=>String(r?.account||k.split('|')[0])===account&&String(r?.supplyId||k.split('|')[2])===supply&&String(r?.sku||k.split('|')[4])===sku))return{reason:'fbo-transfer-already-accounted',supplyId:supply,sku};
 }return null;
}
