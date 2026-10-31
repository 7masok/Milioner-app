import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {inventory,availability,resolver,createDraft,cancelDraft,dispatchDraft,draftGroups,reservationViolation,transferViolation} from '../src/fbo-warehouse/core.js';
import {stockLedgerViolation} from '../src/warehouse-ledger.js';
process.env.APP_ADMIN_TOKEN='fbo-warehouse-fixture-code';process.env.WAREHOUSE_WRITES_ENABLED='true';
const {enrichWarehouseDashboard,readWarehouseContext,enrichPreparedWithWarehouse}=await import('../src/fbo-warehouse/store.js');
const {createFboWarehouseRouter,remoteForOrder}=await import('../src/fbo-warehouse/router.js');
const {createSessionToken}=await import('../src/auth.js');
const {pool}=await import('../src/db.js');
const read=p=>readFileSync(new URL('../../'+p,import.meta.url),'utf8');
function fixture(){return{products:[{id:'p',name:'Складское название',ozon:'offer',ozonAliases:['111','112'],stock:100,cost:4}],purchases:[{id:'wh',productId:'p',qty:20,status:'at_warehouse',buyTotal:100,delivery:0,date:1},{id:'sale',productId:'p',qty:100,remainingQty:100,status:'received',landedUnitCost:4,receivedAt:1}],reservations:[{id:'customer',source:'Kaspi',productId:'p',qty:20,active:true}],movements:[],settings:{}}}
const request=(id='draft-00000001',qty=30,clusterKey='id:10')=>({id,title:'Поставка',lines:[{sku:'111',clusterKey,cluster:'Кластер',qty}]});
const remote=(qty=30,orderId='900')=>({orderId,lines:[{sku:'111',qty,clusterKey:'id:10',supplyId:'901',bundleId:'902',warehouse:'Кластер'}]});
test('one pool across aliases and clusters: reserve warehouse lots first, then sale, with no physical write',()=>{
 const s=fixture(),before=structuredClone(s),resolve=resolver(s);assert.equal(availability(s,'p').available,100);
 const created=createDraft(s,request(),resolve,'Ozon',100);assert.equal(created.changed,true);assert.equal(s.products[0].stock,100);assert.deepEqual(s.purchases,before.purchases);
 const rows=s.reservations.filter(r=>r.source==='FBO');assert.equal(rows.length,1);assert.equal(rows[0].qty,10);assert.equal(rows[0].warehouseQty,20);assert.equal(inventory(s).get('p').sale,70);assert.equal(availability(s,'p').available,70);
 const snap=JSON.stringify(s);assert.throws(()=>createDraft(s,{id:'draft-00000002',lines:[{sku:'112',clusterKey:'id:20',cluster:'Другой',qty:71}]},resolve,'Ozon'),/Недостаточно/);assert.equal(JSON.stringify(s),snap);
 assert.equal(createDraft(s,request(),resolve,'Ozon',101).changed,false);assert.throws(()=>createDraft(s,request('draft-00000001',31),resolve,'Ozon'),/номер/);
 cancelDraft(s,'draft-00000001',102);assert.equal(availability(s,'p').available,100);assert.equal(s.products[0].stock,100);assert.equal(cancelDraft(s,'draft-00000001').changed,false);
});
test('failed multi-line reservation is atomic and multiple SKU share the same canonical stock',()=>{
 const s=fixture(),before=JSON.stringify(s);assert.throws(()=>createDraft(s,{id:'draft-00000003',lines:[{sku:'111',clusterKey:'id:10',qty:60},{sku:'112',clusterKey:'id:20',qty:60}]},resolver(s),'Ozon'),/Недостаточно/);assert.equal(JSON.stringify(s),before);
});
test('bundle components share stock with individual SKUs and cannot be overallocated',()=>{
 const s=fixture();s.reservations=[];s.purchases=[];s.products.push({id:'q',name:'Компонент',stock:50,ozon:'222'},{id:'b',name:'Набор',kind:'bundle',components:[{productId:'p',qty:2},{productId:'q',qty:1}],ozon:'333'});
 assert.equal(availability(s,'b').available,50);createDraft(s,{id:'bundle-0000001',lines:[{sku:'333',qty:30,clusterKey:'id:10'}]},resolver(s),'Ozon');assert.equal(availability(s,'p').available,40);assert.equal(availability(s,'q').available,20);assert.equal(availability(s,'b').available,20);assert.throws(()=>createDraft(s,{id:'single-0000001',lines:[{sku:'111',qty:41,clusterKey:'id:20'}]},resolver(s),'Ozon'),/Недостаточно/);
});
test('dispatch moves reserved lots with FIFO and journal identity, repeated send cannot debit twice',()=>{
 const s=fixture();createDraft(s,request(),resolver(s),'Ozon',100);const previous=structuredClone(s);const out=dispatchDraft(s,'draft-00000001',remote(),200);assert.equal(out.changed,true);assert.equal(s.products[0].stock,90);assert.equal(s.movements.find(m=>m.type==='приход').stockBalance.after,120);assert.equal(s.movements.find(m=>m.type==='FBO Ozon').stockBalance.before,120);assert.equal(s.movements.find(m=>m.type==='FBO Ozon').stockBalance.after,90);assert.equal(s.purchases.find(x=>x.id==='wh').remainingQty,0);assert.equal(s.purchases.find(x=>x.id==='sale').remainingQty,90);assert.equal(availability(s,'p').available,70);assert.equal(stockLedgerViolation(previous,s),null);
 const transfer=s.settings.ozonFboTransfers['Ozon|900|901|902|111'];assert.equal(transfer.productId,'p');assert.equal(transfer.qty,30);assert.equal(transfer.unitCost,140/30);assert.equal(transfer.serverDraftId,'draft-00000001');assert.equal(draftGroups(s)[0].status,'sent');
 const after=JSON.stringify(s);assert.equal(dispatchDraft(s,'draft-00000001',remote(),201).changed,false);assert.equal(JSON.stringify(s),after);assert.throws(()=>cancelDraft(s,'draft-00000001'),/возврат/);assert.throws(()=>dispatchDraft(s,'draft-00000001',remote(30,'999')),/другой/);
});
test('partial warehouse lots preserve proportional costs and prior writeoffs',()=>{
 const s=fixture();s.purchases[0].warehouseWrittenOffQty=2;const before=structuredClone(s.purchases[0]);createDraft(s,request('draft-split-0001',5),resolver(s),'Ozon');const previous=structuredClone(s);dispatchDraft(s,'draft-split-0001',remote(5));const original=s.purchases.find(x=>x.id==='wh'),released=s.purchases.find(x=>x.id.startsWith('fbo-lot-'));assert.equal(original.qty,15);assert.equal(original.warehouseWrittenOffQty,2);assert.equal(original.buyTotal,75);assert.equal(released.qty,5);assert.equal(released.remainingQty,0);assert.equal(released.buyTotal,25);assert.equal(stockLedgerViolation(previous,s),null);assert.equal(s.products[0].stock,100);
});
test('remote multi-supply same-cluster composition aggregates safely and legacy transfer blocks repeated accounting',()=>{
 const s=fixture();createDraft(s,request(),resolver(s),'Ozon');const r=remote();r.lines=[{...r.lines[0],qty:10},{...r.lines[0],qty:20,supplyId:'905',bundleId:'906'}];dispatchDraft(s,'draft-00000001',r);assert.equal(Object.keys(s.settings.ozonFboTransfers).length,2);assert.equal(s.settings.ozonFboTransfers['Ozon|900|905|906|111'].unitCost,140/30);
 createDraft(s,request('draft-00000004',10),resolver(s),'Ozon');const before=JSON.stringify(s);assert.throws(()=>dispatchDraft(s,'draft-00000004',remote(10)),/уже учтена/);assert.equal(JSON.stringify(s),before);
 const other=fixture();createDraft(other,request(),resolver(other),'Ozon');const copy=JSON.stringify(other);assert.throws(()=>dispatchDraft(other,'draft-00000001',remote(29)),/не совпадает/);assert.equal(JSON.stringify(other),copy);
});
test('exact linking resolves offer/SKU aliases, never similar names or ambiguous identifiers',()=>{
 const s=fixture();s.products[0].ozonAliases=[];const stocks=[{offer_id:'offer',product_id:'55',stocks:[{sku:'111'}]}];assert.equal(resolver(s,stocks)('111').product.name,'Складское название');assert.equal(resolver(s)('111').product,null);
 s.products.push({id:'q',name:'Похожее название',ozon:'111'});const r=resolver(s,stocks)('111');assert.equal(r.product,null);assert.equal(r.ambiguous,true);
});
test('canonical names and availability overlay stale APK labels and allocate once across clusters',()=>{
 const s=fixture(),d={plans:[10,20].map(id=>({item:{sku:'111',clusterId:String(id),cluster:'C'+id,name:'Название Ozon',stock:2,daily:1},qty:80,pack:1,missing:null})),shipments:[{sku:'111',name:'Ozon'}],productNames:{111:'Старое имя APK'}};
 const enriched=enrichWarehouseDashboard(d,{ready:true,revision:3,state:s,stockRows:[]},'Ozon');assert.equal(enriched.plans[0].warehouseName,'Складское название');assert.equal(enriched.plans[0].warehouseSuggested,80);assert.equal(enriched.plans[1].warehouseSuggested,20);assert.equal(enriched.shipments[0].warehouseName,'Складское название');const c={};vm.runInNewContext(read('fbo-dashboard-model.js'),c);assert.equal(c.FboDashboardModel.products(enriched)[0].name,'Складское название');
});
test('ordinary saves cannot consume or delete reserved lots/products',()=>{
 const s=fixture();createDraft(s,request(),resolver(s),'Ozon');let next=structuredClone(s);next.products[0].stock=10;assert.equal(reservationViolation(s,next).reason,'fbo-reserved-stock');next=structuredClone(s);next.purchases[0].qty=1;assert.equal(reservationViolation(s,next).reason,'fbo-reserved-purchase');next=structuredClone(s);next.purchases[0].productId='other';assert.equal(reservationViolation(s,next).reason,'fbo-reserved-purchase');next=structuredClone(s);next.products=[];assert.equal(reservationViolation(s,next).reason,'fbo-reserved-product');next=structuredClone(s);next.products[0].name='Новое имя';assert.equal(reservationViolation(s,next),null);
});
test('warehouse context uses the same lock/revision and reads normalized state',async()=>{
 const queries=[],db={query:async(sql)=>{queries.push(sql);if(sql.includes('FROM warehouse_state'))return{rows:[{payload:'{}',revision:4}]};if(sql.includes('FROM warehouse_products'))return{rows:[{payload:{id:'p',name:'Имя',stock:10}}]};return{rows:[]}}};const c=await readWarehouseContext(db,'Ozon',{lock:true});assert.match(queries[0],/pg_advisory_xact_lock/);assert.match(queries[1],/FOR UPDATE/);assert.equal(c.revision,4);assert.equal(c.state.products[0].name,'Имя');
});
test('remote dates/status do not create sends from an unaccepted or incomplete Ozon order',()=>{
 const source={payload:{supplies:[{orderId:'900',supplyId:'901',bundleId:'902',state:'READY_TO_SUPPLY',items:[{sku:'111',qty:1}],cluster:'C'}]}};assert.throws(()=>remoteForOrder(source,'900'),/не подтвердил/);source.payload.supplies[0].state='IN_TRANSIT';assert.equal(remoteForOrder(source,'900').lines[0].qty,1);source.payload.supplies[0].items=[];assert.throws(()=>remoteForOrder(source,'900'),/состав/);
});
test('real owner routes serialize concurrent plans and honor lost-response idempotency and cancellations',async()=>{
 const express=(await import('express')).default;let shared=fixture(),revision=0,queue=Promise.resolve(),connected=true,commits=0;
 const transact=fn=>{const run=queue.then(async()=>{const client={state:structuredClone(shared),revision};const result=await fn(client);if(client.committed){shared=client.state;revision=client.revision;commits++}return result});queue=run.catch(()=>{});return run};
 const readContext=async(client,account,opts)=>{assert.equal(opts.lock,true);return{ready:true,state:client.state,revision:client.revision,stockRows:[]}};
 const persist=async(client,c)=>{client.committed=true;client.state=c.state;client.revision++;return client.revision};
 const app=express();app.use(express.json());app.use('/api/fbo-warehouse',createFboWarehouseRouter({transact,readContext,persist,mirror:async()=>{},accounts:async()=>connected?[{id:'Ozon'}]:[],readSource:async()=>({payload:{stockRequestedSkus:['111'],supplies:[]}})}));app.use((err,req,res,next)=>res.status(err.status||500).json({ok:false,error:err.message}));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.on('listening',r));const base='http://127.0.0.1:'+server.address().port+'/api/fbo-warehouse',token=createSessionToken().token;
 const send=(path,body,auth=token,origin='https://7masok.github.io')=>fetch(base+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...(auth?{Authorization:'Bearer '+auth}:{})},body:JSON.stringify(body)});
 try{
  assert.equal((await send('/drafts',{...request(),baseRevision:0},'')).status,401);assert.equal((await send('/drafts',{...request(),baseRevision:0},token,'https://evil.invalid')).status,403);
  const responses=await Promise.all([send('/drafts',{...request('parallel-000001',60),baseRevision:0}),send('/drafts',{...request('parallel-000002',60),baseRevision:0})]);assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);assert.equal(commits,1);const active=draftGroups(shared)[0];assert.equal(availability(shared,'p').available,40);
  const repeated=await send('/drafts',{...request(active.id,60),baseRevision:0});assert.equal(repeated.status,200);assert.equal((await repeated.json()).changed,false);assert.equal(commits,1);
  assert.equal((await send('/drafts',{...request('more-00000001',41),baseRevision:1})).status,409);assert.equal(commits,1);
  connected=false;const cancelled=await send('/drafts/'+active.id+'/cancel',{baseRevision:1});assert.equal(cancelled.status,200);assert.equal(availability(shared,'p').available,100);assert.equal(commits,2);
 }finally{await new Promise(r=>server.close(r))}
});
test('server dispatch history blocks both deletion and duplicate supply keys from legacy saves',()=>{
 const s=fixture();createDraft(s,request(),resolver(s),'Ozon');dispatchDraft(s,'draft-00000001',remote());let next=structuredClone(s);next.settings.ozonFboTransfers={};assert.equal(transferViolation(s,next).reason,'fbo-transfer-history-protected');next=structuredClone(s);next.settings.ozonFboTransfers['Ozon|rounded-order|901|902|111']={account:'Ozon',supplyId:'901',sku:'111'};assert.equal(transferViolation(s,next).reason,'fbo-transfer-already-accounted');assert.equal(transferViolation(s,structuredClone(s)),null);
});
test('APK receives canonical names, shared stock and warehouse revision without rewriting config hash',()=>{
 const s=fixture(),prepared={configHash:'unchanged',state:{items:[{sku:'111',name:'Ozon'}],shipments:[],ownStocks:[],productNames:{111:'Old APK'}},plans:[{item:{sku:'111',name:'Ozon'},qty:101,pack:1,missing:null}]};const before=JSON.stringify(prepared),out=enrichPreparedWithWarehouse(prepared,{ready:true,revision:8,state:s,stockRows:[]},'Ozon');assert.equal(out.warehouseRevision,8);assert.equal(out.configHash,'unchanged');assert.equal(out.state.items[0].name,'Складское название');assert.equal(out.state.productNames['111'],'Складское название');assert.equal(out.state.ownStocks[0].qty,100);assert.equal(out.plans[0].allocated,100);assert.equal(out.plans[0].shortage,1);assert.equal(JSON.stringify(prepared),before);
});
test('legacy unit-cost-only lots keep proportional value when split for FBO',()=>{
 const s=fixture();delete s.purchases[0].buyTotal;s.purchases[0].unitCost=5;s.purchases[1].status='';createDraft(s,request('cost-split-0001',25),resolver(s),'Ozon');dispatchDraft(s,'cost-split-0001',remote(25));assert.equal(s.purchases.find(p=>p.id==='sale').remainingQty,95);assert.equal(s.settings.ozonFboTransfers['Ozon|900|901|902|111'].unitCost,120/25);
 const other=fixture();delete other.purchases[0].buyTotal;other.purchases[0].unitCost=5;createDraft(other,request('cost-part-00001',5),resolver(other),'Ozon');dispatchDraft(other,'cost-part-00001',remote(5));assert.equal(other.purchases.find(p=>p.id==='wh').buyTotal,75);assert.equal(other.purchases.find(p=>p.id.startsWith('fbo-lot-')).buyTotal,25);
});
test.after(()=>pool.end());
