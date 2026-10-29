import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {withFboPage} from '../src/fbo-page.js';
import {withGrowthAnalyticsPage} from '../src/growth-analytics-page.js';
import {emptyConfiguration,today} from '../src/ozon-planner/model.js';
process.env.APP_ADMIN_TOKEN='fbo-dashboard-fixture-only';
const {buildDashboard,dashboardConfiguration,createFboDashboardRouter}=await import('../src/ozon-planner/dashboard.js');
const {createSessionToken}=await import('../src/auth.js');
const {pool}=await import('../src/db.js');
const read=p=>readFileSync(new URL('../../'+p,import.meta.url),'utf8'),ctx={};vm.runInNewContext(read('fbo-dashboard-model.js'),ctx);const M=ctx.FboDashboardModel;
const addDay=(n)=>new Date(Date.parse(today()+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
function source({arrival=addDay(1),state='IN_TRANSIT'}={}){return {updated_at:Date.now(),attempt_at:1,last_error:'',payload:{asOf:today(),updatedAt:new Date().toISOString(),rows:[{sku:'123',name:'Стул',cluster:'Уфа',clusterId:'42',stock:10,daily:1}],stockRequestedSkus:['123'],missingOrderIds:[],supplies:[{orderId:'500',orderNumber:'500',supplyId:'600',state,orderState:state,cluster:'Уфа',clusterId:'42',warehouseId:'7',warehouse:'Уфа склад',dropoffId:'8',dropoffName:'Алматы',timeslotDay:today(),arrivalDate:arrival,items:[{sku:'123',name:'Стул',qty:5}]}]}}}
function config(){const c=emptyConfiguration();c.settings={cover:14,safety:5,ozonFloor:false};c.routes=[{cluster:'Уфа',prepare:0,travel:3,accept:0}];return c}
test('shared APK plan uses incoming dates, cover and cluster-specific routes without changing input',()=>{
 const s=source(),c=config(),before=JSON.stringify({s,c}),out=buildDashboard(s,{configuration:c});assert.equal(out.plans[0].lead,3);assert.equal(out.plans[0].qty,7);assert.equal(out.plans[0].inTransitQty,5);assert.equal(out.shipments[0].eta,addDay(1));assert.equal(JSON.stringify({s,c}),before);
 const late=buildDashboard(source({arrival:addDay(-1)}),{configuration:c});assert.equal(late.plans[0].qty,12);assert.equal(late.plans[0].awaitingQty,5);assert.equal(M.products(late)[0].transit,5);assert.equal(M.products(late)[0].uncertain,1);
 const accepted=buildDashboard(source({state:'ACCEPTANCE_AT_STORAGE_WAREHOUSE'}),{configuration:c});assert.equal(accepted.plans[0].qty,12);assert.equal(M.products(accepted)[0].transit,0);assert.equal(M.supplies(accepted)[0].rows[0].category,'acceptance');
});
test('defaults, manual scenario validation and missing durations remain explicit',()=>{
 assert.equal(dashboardConfiguration(null).settings.cover,14);assert.equal(dashboardConfiguration(null).settings.safety,5);
 const s=source();s.payload.supplies=[];const out=buildDashboard(s,null);assert.equal(out.plans[0].missing,'Укажи срок доставки');assert.equal(M.products(out)[0].need,null);assert.equal(M.products(out)[0].cover,10);
 const c=config(),x=dashboardConfiguration(c,{cover:20,routes:[{cluster:'Уфа',prepare:2,travel:6,accept:1}],items:[{stock:999}],plans:[{qty:999}]});assert.equal(x.settings.cover,20);assert.equal(x.routes[0].travel,6);assert.equal(x.items,undefined);assert.equal(c.routes[0].travel,3);
 for(const bad of [{cover:0},{safety:91},{routes:'bad'},{routes:[{cluster:'Уфа',prepare:0,travel:-1,accept:0}]}])assert.throws(()=>dashboardConfiguration(c,bad));
});
test('unknown stock/rate is not zero; one cluster cannot subtract another cluster incoming',()=>{
 const data={plans:[{item:{sku:'1',cluster:'А',clusterId:'10',stock:null,daily:null},missing:'Укажи текущий остаток',qty:0},{item:{sku:'2',cluster:'Б',clusterId:'20',stock:8,daily:2},r:2,lead:3,qty:7,missing:null,route:{travel:3}}],shipments:[{id:'one',source:'Ozon API',sku:'2',cluster:'Б',clusterId:'20',status:'in_transit',qty:4,eta:today(),category:'upcoming'},{id:'two',source:'Вручную',linkedOzonId:'one',sku:'2',cluster:'Б',clusterId:'20',status:'in_transit',qty:4,eta:today()}]};
 const rows=M.products(data);assert.equal(rows[0].stock,null);assert.equal(rows[0].need,null);assert.equal(rows[1].cover,4);assert.equal(rows[1].transit,4);const clusters=M.clusters(data);assert.equal(clusters.find(c=>c.name==='А').stockUnknown,1);assert.equal(clusters.find(c=>c.name==='Б').transit,4);assert.equal(M.supplies(data).length,1);
});
test('served page has 10 aligned destinations, FBO restoration and static scripts before auth',()=>{
 const page=withFboPage(withGrowthAnalyticsPage(read('index.html')));assert.equal((page.slice(page.indexOf('<nav>'),page.indexOf('</nav>')).match(/data-view="/g)||[]).length,10);assert.equal((page.match(/data-view="fbo"/g)||[]).length,1);assert.match(page,/'purchases','fbo','reports'/);assert.match(page,/activeView==='fbo'/);
 for(const f of ['fbo-dashboard-model.js','fbo-dashboard-v1.js','fbo-warehouse-v1.js'])assert.ok(page.indexOf('./'+f)<page.lastIndexOf('initOwnerAuth();'));assert.match(read('fbo-dashboard.css'),/grid-template-columns:repeat\(5,minmax\(0,1fr\)\)/);assert.match(read('fbo-dashboard.css'),/grid-template-rows:repeat\(2,55px\)/);assert.match(read('fbo-dashboard.css'),/safe-area-inset-bottom/);
});
test('owner read endpoint selects only one shop, reads cache, cannot pair or mutate business data',async()=>{
 const express=(await import('express')).default;let queries=[];const db={query:async(sql)=>{queries.push(sql);return{rows:[{configuration:config()}]}}};
 const app=express();app.use(express.json());app.use('/api/fbo-dashboard',createFboDashboardRouter({db,accounts:async()=>[{id:'Ozon',clientId:'private-id',label:'Первый магазин',credentials:{apiKey:'private-key'}},{id:'second',clientId:'other',label:'Второй'}],readSource:async account=>{assert.equal(account.id,'Ozon');return source()}}));app.use((err,req,res,next)=>res.status(err.status||500).json({ok:false,error:err.message}));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.on('listening',r));const base='http://127.0.0.1:'+server.address().port+'/api/fbo-dashboard/read',token=createSessionToken().token;
 const send=(body={},auth=token,origin='https://7masok.github.io')=>fetch(base,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,...(auth?{Authorization:'Bearer '+auth}:{})},body:JSON.stringify(body)});
 try{assert.equal((await send({},'')).status,401);assert.equal((await send({},token,'https://evil.invalid')).status,403);const response=await send({cover:14,stocks:[{stock:999}]});assert.equal(response.status,200);const result=await response.json();assert.equal(result.account.label,'Первый магазин');assert.equal(result.plans[0].item.stock,10);assert.ok(!JSON.stringify(result).includes('private-'));assert.ok(queries.every(sql=>sql.startsWith('SELECT ')));assert.equal((await send({cover:-1})).status,400)}finally{await new Promise(r=>server.close(r))}
});
test('switching scenarios aborts an older request and its late response cannot overwrite new plan',async()=>{
 const els=new Map(),el=id=>{if(!els.has(id))els.set(id,{dataset:{},innerHTML:'',textContent:'',value:'',checked:false,addEventListener(){},querySelectorAll:()=>[],classList:{contains:()=>true}});return els.get(id)};const requests=[];
 const c={window:{FboDashboardModel:M},MILLIONER_API:'',document:{getElementById:el,activeElement:null},localStorage:{getItem:()=>null,setItem(){}},AbortController,AbortSignal,Date,console,setTimeout,clearTimeout,fetch:(url,opts)=>new Promise(resolve=>requests.push({resolve,opts})),alert:msg=>{throw Error(msg)}};
 vm.runInNewContext(read('fbo-dashboard-v1.js'),c);const old=c.window.renderFboDashboard();el('fboCover').value='20';el('fboSafety').value='5';c.window.fboApplySettings();assert.equal(requests.length,2);assert.equal(requests[0].opts.signal.aborted,true);
 requests[1].resolve({ok:true,json:async()=>({ok:true,configured:true,account:{label:'Новый'},plans:[],shipments:[],settings:{cover:20,safety:5}})});await new Promise(r=>setTimeout(r,0));requests[0].resolve({ok:true,json:async()=>({ok:true,account:{label:'Старый'},plans:[]})});await old;assert.match(el('fboStore').textContent,/Новый/);assert.equal(el('fboCover').value,20);
});
test.after(()=>pool.end());
