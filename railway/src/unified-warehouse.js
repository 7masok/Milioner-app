import {composeBusinessSelection} from './business-dashboard-cache.js';
import express from 'express';
import crypto from 'node:crypto';
import {infernoSession} from './warehouse-scope.js';
import {combinedRevision,mergeWarehouses,splitWarehouses,scopeValue,scopeApiValue,stable,LISTS,applyUnifiedPatch,warehouseDelta} from './unified-warehouse-model.js';

export function createUnifiedWarehouseRouter({mainOrigin,infernoOrigin,infernoSecret,fetchImpl=fetch,numberShipments}){
 const router=express.Router(),baselines=new Map();let lastChild=null;
 function remember(main,inferno){const revision=combinedRevision(Number(main.revision),Number(inferno.revision));baselines.set(revision,{main,inferno,receipts:new Map()});while(baselines.size>24)baselines.delete(baselines.keys().next().value);return revision;}
 async function call(req,child,path,options={}){
  const parent=String(req.headers.authorization||'').replace(/^Bearer\s+/i,''),origin=child?infernoOrigin:mainOrigin;
  const token=child?infernoSession(parent,infernoSecret).token:parent;
  const response=await fetchImpl(origin+path,{...options,headers:{Origin:origin,Authorization:'Bearer '+token,'Content-Type':'application/json',...options.headers},signal:AbortSignal.timeout(path.startsWith('/api/warehouse-state')&&!options.method?10000:55000)});
  const data=await response.json();if(!response.ok){const e=Object.assign(new Error(data.error||'HTTP '+response.status),{status:response.status,data});throw e;}return data;
 }
 const snapshot=async(req,child,meta=false)=>{const data=await call(req,child,'/api/warehouse-state'+(meta?'?meta=1':''));if(child&&!meta)lastChild=data;return data;};
 async function readChild(req,meta=false){try{return await snapshot(req,true,meta);}catch(error){return {...(lastChild||{revision:0,updatedAt:0,state:{...Object.fromEntries(LISTS.map(k=>[k,[]])),settings:{}}}),unavailable:true};}}
 async function shipmentNumbers(purchases,inferno){
  if(!numberShipments)return undefined;
  try{return await numberShipments(purchases,{allocate:!inferno.unavailable});}
  catch(error){console.warn('Purchase shipment numbering failed',error.message);return undefined;}
 }
 router.get('/warehouse-state',async(req,res,next)=>{try{
  const meta=req.query.meta==='1';
  const [main,inferno]=await Promise.all([snapshot(req,false,meta),readChild(req,meta)]);
  const revision=meta?combinedRevision(Number(main.revision),Number(inferno.revision)):remember(main,inferno);
  const state=meta?undefined:mergeWarehouses(main.state,inferno.state);
  if(state)state.purchaseShipmentNumbers=await shipmentNumbers(state.purchases,inferno);
  res.set('X-Inferno-Available',inferno.unavailable?'false':'true');
  res.json({ok:true,exists:main.exists!==false,revision,updatedAt:Math.max(Number(main.updatedAt)||0,Number(inferno.updatedAt)||0),state});
 }catch(error){next(error);}});
 router.put('/warehouse-state',async(req,res,next)=>{try{
  if((req.body.patch?req.body.unifiedWarehouseVersion:req.body.state?.settings?.unifiedWarehouseVersion)!==1)return res.status(409).json({ok:false,error:'unified-snapshot-required'});
  const baseline=baselines.get(Number(req.body.baseRevision));
  if(!baseline)return res.status(409).json({ok:false,error:'warehouse-revision-conflict'});
  const incoming=req.body.patch?applyUnifiedPatch(mergeWarehouses(baseline.main.state,baseline.inferno.state),req.body.state):req.body.state;
  const {purchaseShipmentNumbers:_shipmentNumbers,...editable}=incoming;
  const wanted=splitWarehouses(editable,baseline.inferno.state,baseline.main.state);
  const fingerprint=crypto.createHash('sha256').update(stable(wanted)).digest('hex');
  const applied=baseline.receipts.get(fingerprint)||{};baseline.receipts.set(fingerprint,applied);
  const targets=['main','inferno'].filter(k=>stable(wanted[k])!==stable(baseline[k].state));
  const current={main:baseline.main,inferno:baseline.inferno};const reads=await Promise.all(targets.map(async key=>[key,{...baseline[key],...await snapshot(req,key==='inferno',true)}]));for(const [key,value]of reads)current[key]=value;
  // Check every affected warehouse before the first write. Never overwrite a
  // concurrent edit. Receipts let a retry finish a partially accepted request.
  for(const key of targets){const expected=applied[key]??baseline[key].revision;if(Number(current[key].revision)!==Number(expected))return res.status(409).json({ok:false,error:'warehouse-revision-conflict'});}
  for(const key of targets){
   if(applied[key]!=null)continue;
   try{
    const result=await call(req,key==='inferno','/api/warehouse-state',{method:'PUT',body:JSON.stringify({baseRevision:current[key].revision,patch:true,state:warehouseDelta(baseline[key].state,wanted[key])})});
    applied[key]=Number(result.revision);current[key]={...current[key],...result,state:wanted[key]};
   }catch(error){
    if(Object.keys(applied).length)return res.status(503).json({ok:false,error:'Часть изменений сохранена. Остальные остаются в очереди. Повторите сохранение.',partial:true});
    throw error;
   }
  }
  for(const key of targets)current[key]=await snapshot(req,key==='inferno');
  const revision=remember(current.main,current.inferno);
  const purchases=[...(current.main.state?.purchases||[]),...scopeValue(current.inferno.state?.purchases||[])];
  const purchaseShipmentNumbers=await shipmentNumbers(purchases,current.inferno);
  res.json({ok:true,revision,purchaseShipmentNumbers,updatedAt:Math.max(Number(current.main.updatedAt)||0,Number(current.inferno.updatedAt)||0)});
 }catch(error){if(error.status)return res.status(error.status).json(error.data||{ok:false,error:error.message});next(error);}});
 router.get('/orders',async(req,res,next)=>{try{
  const url=new URL(req.url,'http://scope.local');const selected=url.searchParams.get('market');
  if(selected&&selected!=='WB3'&&selected!=='all')return res.json(await call(req,false,'/api/orders'+url.search));
  url.searchParams.delete('market');
  const [main,child]=await Promise.all([selected==='WB3'?{orders:[]}:call(req,false,'/api/orders'+url.search),call(req,true,'/api/orders'+url.search).catch(error=>{if(selected==='WB3')throw error;return {orders:[],unavailable:true};})]);
  const orders=[...(main.orders||[]),...scopeApiValue(child.orders||[])].sort((a,b)=>(Number(b.creationDate)||0)-(Number(a.creationDate)||0));
  res.json({...main,ok:true,orders,...(child.unavailable?{partialMarkets:['WB3']}:{})});
 }catch(e){next(e);}});
 router.get('/market-status',async(req,res,next)=>{try{const [main,child]=await Promise.all([call(req,false,'/api/market-status'),call(req,true,'/api/market-status').catch(()=>({markets:[{market:'WB',configured:null,unavailable:true}]}))]);res.json({...main,markets:[...(main.markets||[]),...scopeValue(child.markets||[])]});}catch(e){next(e);}});
 router.get('/connections',async(req,res,next)=>{try{const [main,child]=await Promise.all([call(req,false,'/api/connections'),call(req,true,'/api/connections').catch(()=>({connections:[]}))]);res.json({...main,connections:[...(main.connections||[]),...(child.connections||[]).filter(x=>x.id==='WB').map(x=>({...x,id:'WB3',label:'WB3 · Инферно'}))]});}catch(e){next(e);}});
 // Federate prepared snapshots only; no browser/marketplace calculations.
 router.get('/business-dashboard-days',async(req,res,next)=>{try{
  const markets=String(req.query.markets||req.query.market||'').split(',').filter(Boolean),allowed=['Kaspi','WB','WB2','WB3','Ozon'],from=Number(req.query.from),to=Number(req.query.to),day=86400000;
  if(!markets.length||markets.some(m=>!allowed.includes(m))||new Set(markets).size!==markets.length||!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||to<=from||to-from>366*day||(from+18000000)%day||(to+18000000)%day)return res.status(400).json({ok:false,error:'Некорректный диапазон или магазины'});
  const parts=await Promise.all(markets.map(async m=>{try{const x=await call(req,m==='WB3','/api/business-dashboard-days?market='+(m==='WB3'?'WB':m)+'&from='+from+'&to='+to);if(m==='WB3'){const scoped=scopeApiValue(x);for(const row of scoped.days||[]){try{row.day.storeStarts=JSON.stringify(scopeValue(JSON.parse(row.day.storeStarts||'{}')))}catch{}}return scoped}return x}catch{return null}}));
  const result=composeBusinessSelection(parts,markets,from,to);if(markets.length===1){for(const row of result.days)row.day.market=markets[0]}
  res.json(result);
 }catch(e){next(e)}});
 router.get('/business-dashboard-progress',async(req,res,next)=>{try{
  const markets=String(req.query.markets||req.query.market||'').split(',').filter(Boolean),allowed=['Kaspi','WB','WB2','WB3','Ozon'];if(!markets.length||markets.some(m=>!allowed.includes(m)))return res.status(400).json({ok:false,error:'Некорректные магазины'});
  const parts=await Promise.all(markets.map(async m=>{try{const x=await call(req,m==='WB3','/api/business-dashboard-progress?market='+(m==='WB3'?'WB':m)+'&from='+encodeURIComponent(req.query.from)+'&to='+encodeURIComponent(req.query.to));return m==='WB3'?scopeApiValue(x):x}catch{return null}}));
  const total=Math.ceil((Number(req.query.to)-Number(req.query.from))/86400000),known=parts.filter(Boolean),preps=known.map(p=>p.preparation).filter(Boolean);
  res.json({ok:true,serverManaged:true,market:markets.length===1?markets[0]:'all',sources:known.flatMap(p=>p.sources||[]),historyRepairs:known.find(p=>p.historyRepairs?.market==='Kaspi')?.historyRepairs,
   preparation:{serverManaged:true,from:Number(req.query.from),to:Number(req.query.to),total,saved:preps.length===markets.length?(preps[0]?.savedDays||[]).filter(d=>preps.every(p=>(p.savedDays||[]).includes(d))).length:0,orders:preps.length===markets.length?(preps[0]?.orderDays||[]).filter(d=>preps.every(p=>(p.orderDays||[]).includes(d))).length:0,finance:preps.length===markets.length?(preps[0]?.financeDays||[]).filter(d=>preps.every(p=>(p.financeDays||[]).includes(d))).length:0,status:known.length<markets.length||preps.some(p=>p.status==='retry')?'retry':preps.some(p=>p.status==='loading')?'loading':'ready',revisions:preps.flatMap(p=>p.revisions||[])}});
 }catch(e){next(e)}});
 // WB3 is served by its existing workers and API; the browser uses the same
 // public origin and its normal main session for every store.
 router.use(async(req,res,next)=>{try{
  let url=new URL(req.url,'http://scope.local'),body=req.body;
  for(const [k,v]of url.searchParams)if(v==='WB3')url.searchParams.set(k,'WB');
  url.pathname=url.pathname.replace(/\/WB3(?=\/|$)/g,'/WB').replace(/inferno(?::|%3A)/gi,'');
  for(const [k,v]of url.searchParams)if(v.startsWith('inferno:'))url.searchParams.set(k,v.slice(8));
  if(body&&typeof body==='object')body=scopeValue(body,false);
  const path='/api'+url.pathname+url.search;
  const data=await call(req,true,path,{method:req.method,...(!['GET','HEAD'].includes(req.method)?{body:JSON.stringify(body||{})}:{})});
  if(data.state&&Array.isArray(data.state.products)&&data.state.settings){const main=await snapshot(req,false),child=await snapshot(req,true);const state=mergeWarehouses(main.state,child.state);state.purchaseShipmentNumbers=await shipmentNumbers(state.purchases,child);return res.json({...data,state,revision:remember(main,child)});}
  res.json(scopeApiValue(data));
 }catch(error){if(error.status)return res.status(error.status).json(error.data||{ok:false,error:error.message});next(error);}});
 return router;
}
