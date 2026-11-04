import crypto from 'node:crypto';
import {pool,transaction} from './db.js';
import {config} from './config.js';
import {credentialFor} from './connections.js';
import {readWarehouseContext,persistFboOperation} from './fbo-warehouse/store.js';
import {cancelDraft,draftGroups,fail} from './fbo-warehouse/core.js';
import {ACCOUNT,accountWbSupply,preparing,shipped,supplyKey} from './wb3-supply-accounting.js';
const LOCK='wb3:fbw-supplies',HALF_HOUR=1800000;
let ready;
export const dayStart=now=>{const d=new Date(now+5*3600000);return Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate())-5*3600000};
export function useAutomaticSupplies(s,now){
 if(!s.listAt||s.error||s.listOffset>0||now-s.listAt>6*HALF_HOUR)return s;
 if(!s.enabled&&now-s.listAt>HALF_HOUR)return s;
 if(!s.enabled)s=enableSupplyState(s,now);
 if(s.automaticVersion!==2){const today=(s.supplies||[]).filter(row=>shipped(row)&&Date.parse(row.factDate)>=dayStart(now)).map(supplyKey);s={...s,excluded:(s.excluded||[]).filter(k=>!today.includes(k)),observedPreparing:[...new Set([...(s.observedPreparing||[]),...today])],automaticVersion:2};}
 return s;
}
export function supplyCadence(token,limit=0){try{const p=JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString());if([3,4].includes(Number(p.acc))&&p.t!==true)return 2500}catch{}return Number(limit)>=30?2500:HALF_HOUR}
const hash=t=>crypto.createHash('sha256').update(t).digest('hex');
export function ensureWbSupplies(){return ready ||= pool.query(`CREATE TABLE IF NOT EXISTS wb3_supply_sync (id INTEGER PRIMARY KEY CHECK(id=1),payload JSONB NOT NULL)` ).then(()=>pool.query(`INSERT INTO wb3_supply_sync VALUES(1,'{}') ON CONFLICT DO NOTHING`)).catch(e=>{ready=null;throw e})}
async function read(db=pool){return (await db.query('SELECT payload FROM wb3_supply_sync WHERE id=1')).rows[0]?.payload||{}}
async function write(db,state){await db.query('UPDATE wb3_supply_sync SET payload=$1::jsonb WHERE id=1',[JSON.stringify(state)])}
export async function readWbSupplySnapshot(){await ensureWbSupplies();const s=await read();return {ok:true,ready:!!s.listAt,supplies:s.supplies||[],fetchedAt:s.listAt||0,nextAt:s.nextAt||0,error:s.error||'',enabled:!!s.enabled,enabledAt:s.enabledAt||0,results:s.results||[],receipts:s.receipts||{},excluded:s.excluded||[]}}
export function enableSupplyState(state,now){
 if(state.error||state.listOffset>0||!state.listAt||now-state.listAt>HALF_HOUR||state.listAt>now)fail('Дождитесь свежего полного списка поставок WB3');
 const observed=new Set(state.observedPreparing||[]);
 const excluded=(state.supplies||[]).filter(s=>!preparing(s)&&!observed.has(supplyKey(s))&&!(shipped(s)&&Date.parse(s.factDate)>=dayStart(now))).map(supplyKey);
 for(const row of (state.supplies||[]).filter(preparing))observed.add(supplyKey(row));
 return {...state,enabled:true,enabledAt:now,excluded:[...new Set([...(state.excluded||[]),...excluded])],observedPreparing:[...observed]};
}
export async function setWbSupplyAccounting(enabled){
 await ensureWbSupplies();if(!config.writesEnabled)fail('Запись склада отключена');
 return transaction(async db=>{await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[LOCK]);let s=await read(db);const token=await credentialFor('WB');if(!token||s.tokenHash!==hash(token))fail('Дождитесь снимка текущего подключения WB3');if(enabled&&!s.enabled)s=enableSupplyState(s,Date.now());if(!enabled)s.enabled=false;await write(db,s);return {ok:true,enabled:!!s.enabled,excluded:(s.excluded||[]).length}});
}
// A missing supply is not cancellation. Explicit local release is remembered in
// the same durable reservations and cannot be undone by the background worker.
export async function cancelWbSupplyReservation(key){
 await ensureWbSupplies();if(!config.writesEnabled)fail('Запись склада отключена');
 return transaction(async db=>{await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[LOCK]);const c=await readWarehouseContext(db,ACCOUNT,{lock:true});if(!c.ready)fail('Склад не загружен');const drafts=draftGroups(c.state).filter(d=>d.account===ACCOUNT&&d.orderId===key),d=drafts.find(d=>d.status==='reserved')||drafts.find(d=>d.status==='sent')||drafts[0];if(!d)fail('Резерв не найден',404);const r=cancelDraft(c.state,d.id);if(r.changed)await persistFboOperation(db,c,{source:'wb3-supply-cancel'});const s=await read(db);s.results=(s.results||[]).map(r=>r.key===key?{key,status:'cancelled',message:'Резерв снят вручную'}:r);await write(db,s);return {ok:true}});
}
export async function reconcileWbSupplies(db,s,now=Date.now()){
 if(!s.enabled||!config.writesEnabled||!s.listAt||now-s.listAt>6*60*60000||s.error||s.listOffset>0)return;
 const context=await readWarehouseContext(db,ACCOUNT,{lock:true,movements:true});if(!context.ready)return;
 const initial=new Set((context.state.movements||[]).map(m=>m.id)),results=[];let changed=false;
 for(const supply of s.supplies||[]){
  const key=supplyKey(supply);if(!key||(s.excluded||[]).includes(key))continue;
  const entry=s.goods?.[key];
  if(!entry||entry.listAt!==s.listAt){results.push({key,status:'loading',message:'Получаем состав поставки'});continue}
  try{const r=accountWbSupply(context.state,supply,entry.rows,now,s.tokenHash);if(r.changed){context.state=r.state;changed=true}results.push({key,status:r.status,message:r.status==='reserved'?'Резерв до отгрузки':r.status==='sent'?'Отправка учтена':r.status==='cancelled'?'Резерв снят вручную':'Проверьте статус WB'})}
  catch(e){results.push({key,status:'attention',message:String(e.message).slice(0,250)})}
 }
 if(changed)await persistFboOperation(db,context,{products:true,purchases:true,movements:(context.state.movements||[]).filter(m=>!initial.has(m.id)),source:'wb3-supply-auto'});
 s.results=results;s.receipts=context.state.settings?.wb3SupplyReceipts||{};
}
export function mergeSupplyList(s,rows,now){
 const excluded=new Set(s.excluded||[]),observed=new Set(s.observedPreparing||[]);
 if(s.enabled)for(const row of rows){const key=supplyKey(row);if(!key)continue;
  // Anything shipped before activation, including a late historical page,
  // remains excluded. A known preparing preorder keeps its stable identity.
  if(!observed.has(key)&&shipped(row)&&(!Number.isFinite(Date.parse(row.factDate))||Date.parse(row.factDate)<s.enabledAt))excluded.add(key);
  if(preparing(row))observed.add(key);
 }
 return {...s,supplies:rows,listAt:now,listOffset:0,listStaging:[],excluded:[...excluded],observedPreparing:[...observed],error:''};
}
export async function syncWbSupplies({dbPool=pool,fetchImpl=fetch,tokenFor=credentialFor,ensure=ensureWbSupplies,reconcile=reconcileWbSupplies,profile=config.storeProfile,clock=Date.now}={}){
 if(profile!=='WB3')return {skipped:true};await ensure();const db=await dbPool.connect();let locked=false;
 try{
  locked=!!(await db.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked',[LOCK])).rows[0].locked;if(!locked)return {skipped:true};
  let s=await read(db),now=clock();const original=JSON.stringify(s);const token=await tokenFor('WB');if(!token)return {skipped:true};const tokenHash=hash(token);
  if(s.tokenHash&&s.tokenHash!==tokenHash){s={...s,enabled:false,error:'Ключ WB3 изменился. Проверьте подключение и включите учёт заново.',tokenHash,supplies:[],goods:{},listAt:0,listOffset:0,listStaging:[],goodsStaging:null,observedPreparing:[]};await write(db,s)}else s.tokenHash=tokenHash;
  s=useAutomaticSupplies(s,now);
  if((Number(s.nextAt)||0)<=now){
   const target=s.enabled&&s.listAt?(s.supplies||[]).find(row=>supplyKey(row)&&!(s.excluded||[]).includes(supplyKey(row))&&s.goods?.[supplyKey(row)]?.listAt!==s.listAt):null;
   const listDue=!s.listAt||s.listOffset>0||(!target&&now-s.listAt>=HALF_HOUR);
   if(listDue||target){
    // Reserve the request slot before I/O. A restart cannot erase Retry-After.
    s.nextAt=now+HALF_HOUR;await write(db,s);
    const offset=Number(s.listOffset)||0,key=target&&supplyKey(target);
    // A dispatched supply has its own WB ID. Keep preorderID as our durable
    // accounting identity, but use the actual supply ID for the goods API.
    const hasSupply=Number.isSafeInteger(Number(target?.supplyID))&&Number(target.supplyID)>0;
    const requestId=target?(hasSupply?'supply:':'preorder:')+(hasSupply?target.supplyID:target.preorderID):'';
    const staging=s.goodsStaging?.key===key&&s.goodsStaging.requestId===requestId?s.goodsStaging:{key,requestId,offset:0,rows:[]};
    const path=listDue?'/api/v1/supplies?limit=1000&offset='+offset:'/api/v1/supplies/'+(hasSupply?target.supplyID:target.preorderID)+'/goods?isPreorderID='+(!hasSupply)+'&limit=1000&offset='+staging.offset;
    try{
     const response=await fetchImpl('https://supplies-api.wildberries.ru'+path,{method:listDue?'POST':'GET',headers:{Authorization:token,'Content-Type':'application/json',Accept:'application/json'},...(listDue?{body:JSON.stringify({dates:[],statusIDs:[]})}:{}),signal:AbortSignal.timeout(30000)});
     const limit=Number(response.headers.get('x-ratelimit-limit')),cadence=supplyCadence(token,limit);
     const retry=Math.max(0,...['retry-after','x-ratelimit-retry','x-ratelimit-reset'].map(h=>{const v=Number(response.headers.get(h));return v>1e12?v-now:v>1e9?v*1000-now:v*1000||0}));
     s.nextAt=clock()+Math.max(cadence,retry);
     if(!response.ok){
      s.nextAt=Math.max(s.nextAt,now+HALF_HOUR);
      let detail='';try{const body=await response.json();detail=[body.title,body.detail,body.message].filter(v=>typeof v==='string').join(' · ').slice(0,160)}catch{}
      throw Error('Поставки WB: HTTP '+response.status+(key?' · '+requestId:'')+(detail?' · '+detail:''));
     }
     const rows=await response.json();if(!Array.isArray(rows))throw Error('Некорректный ответ WB по поставке');
     if(listDue){
      const all=[...(s.listStaging||[]),...rows];
      if(rows.length===1000){s.listOffset=offset+1000;s.listStaging=all}
      else s=mergeSupplyList(s,all,clock());
     }else{
      const all=[...staging.rows,...rows];
      if(rows.length===1000)s.goodsStaging={key,requestId,offset:staging.offset+1000,rows:all};
      else{s.goods={...s.goods,[key]:{listAt:s.listAt,rows:all}};delete s.goodsStaging}
      s.error='';
     }
    }catch(e){s.error=String(e.message).slice(0,250)}
   }
  }
  await db.query('BEGIN');try{s=useAutomaticSupplies(s,clock());await reconcile(db,s,clock());if(JSON.stringify(s)!==original)await write(db,s);await db.query('COMMIT')}catch(e){await db.query('ROLLBACK');throw e}
  return {ok:!s.error,enabled:!!s.enabled,results:s.results||[],nextAt:s.nextAt};
 }finally{if(locked)await db.query('SELECT pg_advisory_unlock(hashtext($1))',[LOCK]).catch(()=>{});db.release()}
}
export function startWbSupplyLoop(){if(config.storeProfile!=='WB3')return;const run=()=>syncWbSupplies().catch(e=>console.warn('WB3_SUPPLIES',String(e.message)));setTimeout(run,8000).unref();setInterval(run,30000).unref()}
