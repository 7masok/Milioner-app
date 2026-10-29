// Seller API v2 (post 19 October 2026). Prices never derive from another promotion price.
export const text=v=>String(v??'').trim();
export const id=v=>{const s=text(v);if(!/^[1-9]\d*$/.test(s)||!Number.isSafeInteger(Number(s)))throw Error('Некорректный идентификатор Ozon');return s};
export function money(v,currency=''){
 if(v===null||v===undefined||v==='')return null;
 const raw=typeof v==='object'?v.value:v,n=Number(raw),code=typeof v==='object'?text(v.currency_code):currency;
 return Number.isFinite(n)&&n>0&&(!currency||typeof v!=='object'||code===currency)?n:null;
}
const result=x=>x?.result??x;
export function products(x){const r=result(x);if(!r||!Array.isArray(r.products))throw Error('Ozon не вернул состав акции');return r.products}
export function imported(x,prefs){
 const rows=x?.result;if(!Array.isArray(rows))throw Error('Ozon не подтвердил защиту цены');
 return prefs.map(p=>{const row=rows.find(r=>text(r.offer_id)===p.offer_id||text(r.product_id)===p.product_id);return{offer:p.offer_id,error:!row?'Нет результата Ozon':row.updated!==true||(row.errors||[]).length?'Ozon отклонил цену: '+(row.errors||[]).map(e=>text(e.message||e.code)).join('; '):''}});
}
export function pricePayload(prefs){return{prices:prefs.map(p=>({offer_id:p.offer_id,price:String(p.protected_price),old_price:'0',min_price:String(p.protected_price),currency_code:p.currency,auto_action_enabled:'DISABLED',price_strategy_enabled:'DISABLED',min_price_for_auto_actions_enabled:true}))}}
export function excluded(x,productId,kind='delete'){
 const r=result(x),rows=kind==='update'?r?.deactivated_product_ids:(Array.isArray(r)?r:r?.product_ids);
 return Array.isArray(rows)&&rows.some(v=>text(v)===productId)&&!(r?.active_product_ids||[]).some(v=>text(v)===productId)&&!(r?.rejected||[]).length&&!(r?.warnings||[]).length;
}
export function safeExit(p,row){
 const limit=money(row.max_action_price,p.currency),target=Number(p.protected_price);
 // Never increase the owner's fixed price just to clear a moving promotion threshold.
 if(limit===null||target<=limit)return null;
 return{product_id:Number(id(p.product_id)),action_price:{currency_code:p.currency,value:target.toFixed(2)}};
}
function nextPage(data,rows,task){
 const r=result(data);if(r.has_next===false||rows.length<100)return null;
 if(task.kind==='future')return{...task,offset:(task.offset||0)+rows.length};
 const last=text(r.last_id||rows.at(-1)?.id);if(!last||last===text(task.last_id))throw Error('Ozon повторил страницу акции');return{...task,last_id:last};
}
export function newJob(prefs){return{tasks:[...chunks(prefs,1000).map(ps=>({kind:'identity',offers:ps.map(p=>p.offer_id)})),...chunks(prefs,1000).map(ps=>({kind:'pin',offers:ps.map(p=>p.offer_id)})),{kind:'actions',verify:false}],issues:{},cycleAt:Date.now()}}
function chunks(rows,n){return Array.from({length:Math.ceil(rows.length/n)},(_,i)=>rows.slice(i*n,(i+1)*n))}
function note(job,offer,message){job.issues[offer]=[...new Set([...(job.issues[offer]||[]),message])]}
export function priceFindings(data,prefs){
 const r=result(data);if(!Array.isArray(r?.items))throw Error('Ozon не вернул цены для проверки');
 return prefs.map(p=>{const row=r.items.find(r=>text(r.product_id)===p.product_id&&text(r.offer_id)===p.offer_id),price=row?.price;
 const base=money(price?.price,p.currency),seller=money(price?.marketing_seller_price,p.currency),floor=money(price?.min_price,p.currency);
 const wrongCurrency=price?.currency_code&&price.currency_code!==p.currency,sellerRaw=price?.marketing_seller_price,zeroSeller=sellerRaw!==null&&sellerRaw!==undefined&&sellerRaw!==''&&Number(typeof sellerRaw==='object'?sellerRaw.value:sellerRaw)===0,sellerKnown=seller!==null||zeroSeller;
 return{offer:p.offer_id,error:!row||base===null||floor===null?'Цена Ozon не получена':wrongCurrency?'Валюта цены Ozon отличается от настройки':!sellerKnown?'Ozon не подтвердил цену продавца после скидок':Math.abs(base-Number(p.protected_price))>.009||floor<Number(p.protected_price)||seller!==null&&seller<Number(p.protected_price)?'Ozon ещё показывает другую цену или скидку продавца':''};
 });
}
// Exactly one external request per step; the remaining queue is persisted after every step.
export async function step(rawJob,allPrefs,request){
 const job=structuredClone(rawJob),task=job.tasks.shift();if(!task)return{job,done:true};job.blocked||=[];const prefs=allPrefs.filter(p=>!job.blocked.includes(p.offer_id)),byId=new Map(prefs.map(p=>[p.product_id,p])),byOffer=new Map(prefs.map(p=>[p.offer_id,p]));
 if(task.kind==='identity'){
  const selected=task.offers.map(o=>byOffer.get(o)).filter(Boolean);if(selected.length){const data=result(await request('/v5/product/info/prices',{filter:{offer_id:selected.map(p=>p.offer_id),visibility:'ALL'},limit:1000,cursor:''}));if(!Array.isArray(data?.items))throw Error('Ozon не подтвердил идентификаторы товаров');for(const p of selected){const row=data.items.find(r=>text(r.offer_id)===p.offer_id&&text(r.product_id)===p.product_id);if(!row||text(row.price?.currency_code)!==p.currency){job.blocked.push(p.offer_id);note(job,p.offer_id,'Товар или валюта Ozon изменились. Записи заблокированы; проверьте привязку.')}}}
 }else if(task.kind==='pin'){
  const selected=task.offers.map(o=>byOffer.get(o)).filter(Boolean);if(selected.length)for(const r of imported(await request('/v1/product/import/prices',pricePayload(selected)),selected))if(r.error)note(job,r.offer,r.error);
 }else if(task.kind==='actions'){
  const data=result(await request('/v1/actions',null,'GET'));if(!Array.isArray(data))throw Error('Ozon не вернул список акций');
  const tasks=[];for(const a of data){const action=id(a.id);tasks.push({kind:'active',action,verify:task.verify,last_id:''});
   if(a.auto_add_dates!==undefined&&!Array.isArray(a.auto_add_dates))throw Error('Ozon не вернул даты автодобавления');
   if(a.auto_add_dates===undefined)for(const p of prefs)note(job,p.offer_id,'Ozon не передал даты автодобавления · акция '+action);
   for(const date of a.auto_add_dates||[]){if(typeof date!=='string'||!Number.isFinite(Date.parse(date)))throw Error('Некорректная дата автодобавления Ozon');if(Date.parse(date)>=job.cycleAt)tasks.push({kind:'future',action,date,offset:0,verify:task.verify})}
  }
  if(task.verify)tasks.push(...chunks(prefs,1000).map(ps=>({kind:'prices',offers:ps.map(p=>p.offer_id)})));
  else tasks.push({kind:'actions',verify:true});job.tasks.unshift(...tasks);
 }else if(task.kind==='active'||task.kind==='future'){
  const future=task.kind==='future',body=future?{action_id:Number(task.action),auto_add_date:task.date,offset:task.offset,limit:100}:{action_id:Number(task.action),last_id:task.last_id,limit:100};
  const data=await request(future?'/v2/actions/auto-add/products/list':'/v2/actions/products',body),rows=products(data),more=nextPage(data,rows,task),tasks=[];
  for(const row of rows){const p=byId.get(text(row.id||row.product_id));if(!p)continue;
   if(task.verify){note(job,p.offer_id,(future?'Осталось автодобавление':'Осталось участие')+' · акция '+task.action);continue}
   tasks.push({kind:future?'delete-future':'delete-active',action:task.action,date:task.date,product:p.product_id,row});
  }
  // Offset lists shrink after removal: read the next page before performing removals.
  if(future&&more)job.tasks.unshift(more,...tasks);else job.tasks.unshift(...tasks,...(more?[more]:[]));
 }else if(task.kind==='delete-future'||task.kind==='delete-active'){
  const p=byId.get(task.product);if(p){const future=task.kind==='delete-future';
   try{const data=await request(future?'/v2/actions/auto-add/products/delete':'/v2/actions/products/deactivate',{action_id:Number(task.action),product_ids:[Number(p.product_id)],...(future?{auto_add_date:task.date}:{})});if(!excluded(data,p.product_id)){const change=!future&&safeExit(p,task.row);if(change)job.tasks.unshift({kind:'exit-price',action:task.action,product:p.product_id,change});else note(job,p.offer_id,'Ozon не подтвердил исключение · акция '+task.action)}}
   catch(e){if(future||![400,404,409,422].includes(e.status))throw e;const change=safeExit(p,task.row);if(change)job.tasks.unshift({kind:'exit-price',action:task.action,product:p.product_id,change});else {const limit=money(task.row.max_action_price,p.currency);note(job,p.offer_id,'Выход из акции '+task.action+(limit!==null?' требует цены выше '+limit+' '+p.currency:' требует проверки порога')+'. Цена защиты не повышалась.')}}
  }
 }else if(task.kind==='exit-price'){
  const p=byId.get(task.product);if(p){const data=await request('/v1/actions/products/update',{action_id:Number(task.action),products:[task.change]});if(!excluded(data,p.product_id,'update'))note(job,p.offer_id,'Ozon не подтвердил выход по цене · акция '+task.action)}
 }else if(task.kind==='prices'){
  const selected=task.offers.map(o=>byOffer.get(o)).filter(Boolean);if(selected.length){const data=await request('/v5/product/info/prices',{filter:{product_id:selected.map(p=>Number(p.product_id)),visibility:'ALL'},limit:1000,cursor:''});for(const r of priceFindings(data,selected))if(r.error)note(job,r.offer,r.error)}
 }else throw Error('Неизвестный шаг защиты Ozon');
 return{job,done:job.tasks.length===0};
}
