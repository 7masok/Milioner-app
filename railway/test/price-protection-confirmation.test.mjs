import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {pricesRouter} from '../src/prices.js';
import {pool} from '../src/db.js';
const read=p=>readFileSync(new URL(p,import.meta.url),'utf8');
const api=read('../src/prices.js'),ui=read('../../prices-v1.js'),protection=read('../src/wb-price-protection.js');
function functionSource(text,name,next,async=false){let at=text.indexOf((async?'async ':'')+'function '+name+'(');assert.ok(at>=0,name);return text.slice(at,text.indexOf(next,at)).replaceAll('export ','');}
const bulk=pricesRouter.stack.find(l=>l.route?.path==='/market-prices/update/bulk').route.stack.at(-1).handle;
async function invoke(body){let status=200,data;await bulk({body},{status(v){status=v;return this},json(v){data=v;return this}},e=>{throw e});return {status,data};}
test('manual changes require complete named confirmation; confirmation rebases only chosen rows and keeps pending uploads',async()=>{
 const original=pool.connect,calls=[];let sent=false;
 const client={release(){},query:async(sql,args)=>{calls.push({sql,args});
  if(sql.includes('FROM wb_price_snapshots'))return{rows:[{payload:{rows:[{remoteId:'1',name:'Красный',price:500,discount:0},{remoteId:'2',name:'Синий',price:700,discount:0}]}}]};
  if(sql.includes('FROM wb_price_protection'))return{rows:args[1]===1?[{manualPriceLock:true,promoBlock:true}]:[]};
  if(sql.includes('FROM wb_price_update_queue'))return{rows:sent?[{nmId:'1',source:'manual',status:'sent',uploadId:42}]:[]};
  return{rows:[],rowCount:1};}};
 pool.connect=async()=>client;
 try{
  const body={market:'WB',remoteIds:['1','2'],action:'price',price:900,discount:10,confirm:true};
  let r=await invoke(body);assert.equal(r.status,409);assert.equal(r.data.blocked[0].name,'Красный');assert.match(r.data.blocked[0].reason,/Блок скидок/);assert.ok(!calls.some(c=>/INSERT INTO|UPDATE wb_/.test(c.sql)));
  calls.length=0;r=await invoke({...body,overrideProtection:true,overrideRemoteIds:['2']});assert.equal(r.status,409);assert.ok(!calls.some(c=>/INSERT INTO|UPDATE wb_/.test(c.sql)));
  calls.length=0;r=await invoke({...body,overrideProtection:true,overrideRemoteIds:['1']});assert.equal(r.status,200);assert.deepEqual(r.data.applied,['1','2']);assert.ok(calls.some(c=>c.sql.includes('UPDATE wb_price_protection')&&c.args[1]===1));assert.ok(calls.some(c=>c.sql.includes('INSERT INTO wb_price_protection')&&c.args[1]===1&&c.args[2]===false));assert.ok(!calls.some(c=>c.sql.includes('auto_zero_enabled=')||c.sql.includes('manual_price_lock=')));
  calls.length=0;sent=true;r=await invoke({...body,remoteIds:['1'],overrideProtection:true,overrideRemoteIds:['1']});assert.equal(r.data.applied.length,0);assert.match(r.data.skipped[0].error,/проверки/);assert.ok(!calls.some(c=>c.sql.includes('INSERT INTO wb_price_update_queue')));
 }finally{pool.connect=original;}
});
test('client cancel sends no retry, confirm binds original action/shop/ids and only named protected ids',async()=>{
 const start=ui.indexOf('const priceProtectedRequests='),end=ui.indexOf('function showPriceBlockedDetails',start);
 for(const accept of [false,true]){
  const sent=[];let resolvePrompt;const ctx={Map,JSON,String,MILLIONER_API:'',fetch:async(path,opts)=>{const body=JSON.parse(opts.body);sent.push({path,body});return{ok:sent.length>1,status:sent.length>1?200:409,text:async()=>JSON.stringify(sent.length>1?{ok:true,applied:['1','2']}:{ok:false,code:'PRICE_PROTECTION_CONFIRMATION_REQUIRED',blocked:[{nmId:'1',name:'Красный',reason:'Вручную'}]})}},priceProtectionDialog:async()=>new Promise(r=>{resolvePrompt=r})};
  runInNewContext(ui.slice(start,end),ctx);
  const body={market:'WB',remoteIds:['1','2'],price:900};const promise=ctx.protectedPriceRequest('/api/market-prices/update/bulk',body,'price');
  for(let i=0;i<10&&!resolvePrompt;i++)await Promise.resolve();assert.ok(resolvePrompt);body.market='WB2';body.price=1;body.remoteIds.push('999');resolvePrompt(accept);const result=await promise;
  if(!accept){assert.equal(sent.length,1);assert.equal(result,null)}else{assert.equal(sent.length,2);assert.equal(sent[1].body.market,'WB');assert.equal(sent[1].body.price,900);assert.deepEqual(sent[1].body.remoteIds,['1','2']);assert.deepEqual(sent[1].body.overrideRemoteIds,['1']);assert.equal(sent[1].body.overrideProtection,true)}
 }
});
test('night permission requires named confirmation and cannot flatten size prices or change the base',async()=>{
 const calls=[],client={query:async(sql,args)=>{calls.push({sql,args});return{rows:[]}},release(){}};
 const ctx={Date,Number,Array,Map,Set,JSON,cleanText:String,number:Number,timeToMinute:v=>Number(v.slice(0,2))*60+Number(v.slice(3)),normalizeWbNightWeekdays:v=>v||[1,2,3,4,5,6,7],pool:{connect:async()=>client},wbPriceSnapshot:async()=>({rows:[{remoteId:1,name:'Красный'},{remoteId:2,name:'Размеры',canEditPrice:false}]}),protectionFor:async()=>({priceProtected:true,autoZeroLock:true}),syncWbNightSchedules:async()=>{},wbPriceSchedules:async()=>[]};
 runInNewContext(functionSource(api,'saveWbNightSchedules',"pricesRouter.post('/market-prices/night-schedule'",true),ctx);
 const body={remoteIds:[1,2],enabled:true,start:'23:00',end:'05:00',price:2000};
 await assert.rejects(ctx.saveWbNightSchedules('WB',body),e=>e.code==='NIGHT_PROTECTION_CONFIRMATION_REQUIRED'&&e.blocked[0].name==='Красный');assert.ok(!calls.some(c=>/INSERT INTO|UPDATE wb_/.test(c.sql)));
 calls.length=0;const r=await ctx.saveWbNightSchedules('WB',{...body,overrideProtection:true,overrideRemoteIds:['1']});assert.deepEqual(Array.from(r.applied),['1']);assert.match(r.skippedDetails[0].reason,/Разные цены/);
 const insert=calls.find(c=>c.sql.includes('INSERT INTO wb_price_schedules'));assert.equal(insert.args[7],true);assert.doesNotMatch(insert.sql.split('DO UPDATE SET')[1],/base_price=|window_key=/);assert.ok(calls.some(c=>c.sql.includes('night-protection-override')));
});
test('protection yields only during approved night restoration and keeps daytime locks and promo price locks',async()=>{
 let base=175,approved=true,promo=false;const calls=[];
 const ctx={Date,Number,Map,Math,cleanText:String,number:Number,clampDiscount:v=>Number(v)||0,protectedReturnPrice:(a,b)=>b,
  priceRows:async()=>[{remoteId:'1',price:5000,discount:10}],protectionRows:async()=>[{nmId:'1',manualPriceLock:true,lockedPrice:175,lockedDiscount:0}],warehouseAvailability:async()=>({amount:()=>null}),
  pool:{query:async(sql,args)=>{calls.push({sql,args});if(sql.includes('FROM wb_price_schedules'))return{rows:[{nmId:'1',basePrice:base,protectionOverride:approved}]};if(sql.includes('FROM wb_promo_preferences'))return{rows:[{nmId:'1',enabled:promo,protectionOverride:promo}]};if(sql.includes('FROM wb_price_update_queue'))return{rows:[{source:promo?'promo':'schedule',status:'pending'}]};return{rows:[],rowCount:1}}}};
 runInNewContext(functionSource(protection,'syncWbPriceProtection','export async function updateProtectionBaseline',true),ctx);
 await ctx.syncWbPriceProtection('WB',1);assert.ok(!calls.some(c=>c.sql.startsWith('DELETE')||c.sql.includes('INSERT INTO wb_price_update_queue')),'approved restoration retains its queue');
 calls.length=0;base=0;await ctx.syncWbPriceProtection('WB',2);assert.ok(calls.some(c=>c.sql.includes('INSERT INTO wb_price_update_queue')),'daytime price remains protected');
 calls.length=0;approved=false;base=175;await ctx.syncWbPriceProtection('WB',3);assert.ok(calls.some(c=>c.sql.startsWith('DELETE')),'unapproved night is blocked');
 calls.length=0;base=0;promo=true;await ctx.syncWbPriceProtection('WB',4);assert.ok(!calls.some(c=>c.sql.startsWith('DELETE')),'approved promo queue survives');const q=calls.find(c=>c.sql.includes('INSERT INTO wb_price_update_queue'));assert.equal(q.args[2],175,'promo does not unlock ordinary price');assert.equal(q.args[3],null,'promo owns only the discount');
});
test('styled confirmation has two explicit actions; cancel/Escape resolve without applying',async()=>{
 for(const action of ['cancel','apply','escape']){
  const nodes=new Map(),events=new Map();let closed=0,removed=0,shown=0;
  const dialog={style:{},setAttribute(){},querySelector:key=>{if(!nodes.has(key))nodes.set(key,{addEventListener:(event,fn)=>events.set(key,fn),focus(){}});return nodes.get(key)},addEventListener:(event,fn)=>events.set(event,fn),showModal(){shown++},close(){closed++},remove(){removed++}};
  const ctx={document:{createElement:()=>dialog,body:{appendChild(){}}},pEsc:v=>String(v).replaceAll('<','&lt;'),pMoney:v=>String(v),priceNightDaysLabel:()=> 'Пт'};
  const at=ui.indexOf('function priceProtectionDialog(');runInNewContext(ui.slice(at,ui.indexOf('const priceProtectedRequests=',at)),ctx);
  const result=ctx.priceProtectionDialog({action:'price',price:900},[{nmId:'1',name:'<Товар>',reason:'Вручную'}],'price');
  assert.equal(shown,1);assert.match(dialog.innerHTML,/Подтвердить/);assert.match(dialog.innerHTML,/Отменить/);assert.ok(!dialog.innerHTML.includes('<Товар>'));
  if(action==='escape')events.get('cancel')({preventDefault(){}});else events.get('[data-price-confirm-'+action+']')();
  assert.equal(await result,action==='apply');assert.equal(closed,1);assert.equal(removed,1);
 }
});
test('approved night raises through queue, carries locked discount, restores safely and waits for upload verification',async()=>{
 let inWindow=true,queue=null;const saved={nmId:'1',enabled:true,protectionOverride:true,basePrice:175,targetPrice:5000,windowKey:'fixture'},targets=[];
 const ctx={Number,Map,Math,clampDiscount:Number,number:Number,pool:{query:async()=>({rowCount:1})},wbPriceSchedules:async()=>[{...saved}],wbPriceSnapshot:async()=>({rows:[{remoteId:'1',price:inWindow?175:5000,discount:0,priceProtected:true,lockedDiscount:0}]}),wbPriceQueueRows:async()=>queue?[queue]:[],decorateWbProtectionRows:async(m,rows)=>rows,isWbGradualReductionError:()=>false,wbNightWindowState:()=>({inWindow,windowKey:inWindow?'fixture':''}),nightUploadInFlight:q=>q&&['sent','checking'].includes(q.status),samePrice:(a,b)=>Number(a)===Number(b),scheduleQueueBusy:()=>false,wbSafeReturnPrice:(a,b)=>Math.max(b,Math.ceil(a/1.9)),queueSchedulePrice:async(...args)=>{targets.push(args);return true}};
 runInNewContext(functionSource(api,'syncWbNightSchedules','function overlayWbQueuedRows',true),ctx);
 await ctx.syncWbNightSchedules('WB',1);assert.equal(targets[0][2],5000);assert.equal(targets[0][4],0);
 targets.length=0;inWindow=false;queue={nmId:'1',status:'sent',source:'schedule',uploadId:42};await ctx.syncWbNightSchedules('WB',2);assert.equal(targets.length,0);
 queue={...queue,status:'checking'};await ctx.syncWbNightSchedules('WB',3);assert.equal(targets.length,0);
 queue=null;await ctx.syncWbNightSchedules('WB',4);assert.equal(targets[0][2],2632);assert.equal(targets[0][4],0);assert.equal(saved.basePrice,175);
});
