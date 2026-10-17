import vm from 'node:vm';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

const context=vm.createContext({console,Date,Math,JSON,Number,String,Array,Object,Set,Map,Intl,Error});
for(const file of ['engine.cjs','supplies.cjs'])vm.runInContext(readFileSync(new URL(file,import.meta.url),'utf8'),context);
const {Planner,Supplies}=context;
export function today(now=Date.now()){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Almaty',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);}
Planner.today=()=>today();
const date=x=>typeof x==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(x)&&Planner.date(Planner.day(x))===x;
const list=(x,n=30000)=>Array.isArray(x)&&x.length<=n;
const string=(x,n=300)=>typeof x==='string'&&x.length<=n;
function invalid(){const e=new Error('Некорректные настройки плана');e.status=400;throw e;}
export function validateConfiguration(value){
 if(!value||typeof value!=='object'||JSON.stringify(value).length>3000000)invalid();
 const s=value.settings;
 if(!s||!Number.isInteger(s.cover)||s.cover<1||s.cover>365||!Number.isInteger(s.safety)||s.safety<0||s.safety>90||typeof s.ozonFloor!=='boolean')invalid();
 if(!value.productNames||typeof value.productNames!=='object'||Array.isArray(value.productNames)||Object.entries(value.productNames).some(([k,v])=>!string(k,80)||!string(v,160)))invalid();
 for(const field of ['routes','inboundRoutes','ownStocks','itemOptions','manualItems','manualShipments','supplyOverrides'])if(!list(value[field]))invalid();
 for(const r of value.routes)if(!string(r.cluster)||['prepare','travel','accept'].some(k=>r[k]!=null&&(!Number.isFinite(Number(r[k]))||Number(r[k])<0||Number(r[k])>730)))invalid();
 for(const r of value.inboundRoutes)if(!string(r.cluster)||['travel','accept'].some(k=>!Number.isFinite(Number(r[k]))||Number(r[k])<0||Number(r[k])>730))invalid();
 for(const r of value.ownStocks)if(!string(r.sku,80)||!Number.isInteger(r.qty)||r.qty<0)invalid();
 for(const i of [...value.itemOptions,...value.manualItems]){
  if(!string(i.sku,80)||!string(i.cluster)||!Number.isInteger(i.pack)||i.pack<1||i.pack>100000||i.ozon!=null&&(!Number.isInteger(i.ozon)||i.ozon<0))invalid();
 }
 for(const i of value.manualItems)if(!string(i.id,150)||!string(i.name)||i.stock!=null&&(!Number.isInteger(i.stock)||i.stock<0)||i.daily!=null&&(!Number.isFinite(Number(i.daily))||Number(i.daily)<0)||!date(i.asOf)||!['manual','history'].includes(i.rateMode)||i.rateMode==='history'&&(!Number.isFinite(Number(i.sales))||Number(i.sales)<0||!Number.isFinite(Number(i.activeDays))||Number(i.activeDays)<=0))invalid();
 for(const r of value.manualShipments)if(!string(r.id,150)||!string(r.sku,80)||!string(r.cluster)||!Number.isInteger(r.qty)||r.qty<1||r.eta&&!date(r.eta)||!['in_transit','received','cancelled','pending'].includes(r.status))invalid();
 for(const r of value.supplyOverrides)if(!string(r.id,150)||r.eta&&!date(r.eta)||r.clusterOverride&&!string(r.clusterOverride)||r.linkedOzonId&&!string(r.linkedOzonId,150))invalid();
 // Explicitly project user-owned configuration. Source snapshots/plans cannot be overwritten.
 const clean=JSON.parse(JSON.stringify(value));
 return Object.fromEntries(['settings','productNames','routes','inboundRoutes','ownStocks','itemOptions','manualItems','manualShipments','supplyOverrides'].map(k=>[k,clean[k]]));
}
export function emptyConfiguration(){return {settings:{cover:28,safety:5,ozonFloor:false},productNames:{},routes:[],inboundRoutes:[],ownStocks:[],itemOptions:[],manualItems:[],manualShipments:[],supplyOverrides:[]};}
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
export function configurationHash(c){return crypto.createHash('sha256').update(JSON.stringify(canonical(c))).digest('hex');}
export function buildPrepared(config,source,oldState={}){
 const same=(a,b)=>a.sku===b.sku&&(a.clusterId&&b.clusterId?String(a.clusterId)===String(b.clusterId):a.cluster===b.cluster);
 let state={...oldState,version:1,settings:config.settings,productNames:config.productNames,routes:config.routes,inboundRoutes:config.inboundRoutes,ownStocks:config.ownStocks,items:(oldState.items||[]).filter(i=>['Ozon API','Состав поставки Ozon'].includes(i.source)).map(i=>({...i})),shipments:(oldState.shipments||[]).filter(s=>s.source==='Ozon API').map(s=>({...s})),hints:[]};
 for(const item of config.manualItems){const ix=state.items.findIndex(i=>same(i,item));const m={...item,source:'Вручную'};if(ix<0)state.items.push(m);else state.items[ix]=m;}
 for(const opt of config.itemOptions){const i=state.items.find(i=>same(i,opt));if(i)Object.assign(i,{pack:opt.pack,ozon:opt.ozon});}
 for(const override of config.supplyOverrides){const row=state.shipments.find(s=>s.id===override.id);if(row){row.eta=override.eta||null;row.clusterOverride=override.clusterOverride||'';if(row.clusterOverride)row.cluster=row.clusterOverride;}}
 state.shipments.push(...config.manualShipments.map(s=>({...s,source:s.source==='Ozon API'?'Вручную':s.source})));
 if(source){state=Supplies.mergeSnapshot(state,source,source.updatedAt,()=>crypto.randomUUID().replaceAll('-',''));}
 // New API items receive user options, too. Apply manual fields only, never client stock.
 for(const opt of config.itemOptions){const i=state.items.find(i=>same(i,opt));if(i)Object.assign(i,{pack:opt.pack,ozon:opt.ozon});}
 const routes=Supplies.routesForState(state),day=today();
 const plans=Planner.plan(state,day).map(p=>{
  const issues=[];if(p.item.stock==null||p.item.stock==='')issues.push({key:'stock',label:'Остаток в этом кластере'});
  if(Planner.rate(p.item)===null)issues.push({key:'sales',label:'Продажи в день в этом кластере'});
  if(!Planner.routeFor(p.item,routes))issues.push({key:'route',label:'Срок доставки в этот кластер'});
  return {...p,issues,stale:p.item.asOf!==day};
 });
 return {state,plans,calculatedDay:day,configHash:configurationHash(config)};
}
