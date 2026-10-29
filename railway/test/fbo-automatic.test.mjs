import test from 'node:test';
import assert from 'node:assert/strict';
import {accountAutomaticOrder,historicalOrders,runAutoAccounting,setAutoAccounting,readAutoAccounting} from '../src/fbo-warehouse/automatic.js';
import {pool} from '../src/db.js';
import {createDraft,resolver} from '../src/fbo-warehouse/core.js';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const account={id:'Ozon',clientId:'cabinet'};
function state(){return {products:[{id:'p',name:'Имя склада',ozon:'111',stock:50,cost:4}],purchases:[{id:'wh',productId:'p',qty:20,status:'at_warehouse',buyTotal:100,date:1},{id:'sale',productId:'p',qty:50,remainingQty:50,status:'received',landedUnitCost:4,receivedAt:1}],reservations:[{id:'customer',productId:'p',source:'Kaspi',qty:10,active:true}],settings:{},movements:[]}}
const part=(orderId='900',status='IN_TRANSIT',qty=30)=>({orderId,supplyId:orderId+'1',bundleId:orderId+'2',state:status,orderState:status,cluster:'Казань',clusterId:'10',items:[{sku:'111',qty}]});
function fixture(){
 let row={account:'Ozon',client_id:'cabinet',enabled:true,enabled_at:1000,excluded_orders:[],checked_at:0,last_results:[]},warehouse=state(),tail=Promise.resolve(),writes=0;
 const query=async(sql,args=[])=>{
  if(sql.startsWith('SELECT')&&sql.includes('fbo_auto_accounting'))return {rows:row?[structuredClone(row)]:[]};
  if(sql.includes('array_append'))row.excluded_orders.push(args[1]);
  if(sql.startsWith('INSERT INTO fbo_auto_accounting'))row={account:args[0],enabled:args[1],enabled_at:args[2],excluded_orders:args[3],client_id:args[4],checked_at:0,last_results:[]};
  if(sql.includes('SET checked_at')&&row.enabled&&row.enabled_at===args[3]&&row.client_id===args[4]){row.checked_at=args[1];row.last_results=JSON.parse(args[2])}
  return {rows:[]};
 };
 const db={query},transact=fn=>{const work=tail.then(()=>fn(db));tail=work.catch(()=>{});return work};
 const options={db,transact,now:2000,writesEnabled:true,readContext:async()=>({state:structuredClone(warehouse),stockRows:[],revision:1,ready:true}),persist:async(_c,ctx)=>{warehouse=structuredClone(ctx.state);writes++},mirror:async()=>{}};
 return {options,get row(){return row},get state(){return warehouse},get writes(){return writes}};
}
test('automatic dispatch is atomic, warehouse-first, FIFO-accounted and idempotent against manual or server records',()=>{
 const before=state(),context={state:before,stockRows:[]},payload={supplies:[part()]},out=accountAutomaticOrder(context,payload,'Ozon','900',2000);
 assert.equal(out.changed,true);assert.equal(out.state.products[0].stock,40);assert.equal(before.products[0].stock,50);
 assert.equal(out.state.purchases.find(x=>x.id==='wh').remainingQty,0);assert.equal(out.state.reservations.find(x=>x.id==='customer').active,true);
 assert.equal(out.state.movements.find(x=>x.type==='FBO Ozon').qty,-30);
 assert.equal(accountAutomaticOrder({state:out.state},payload,'Ozon','900').changed,false);
 const partial=structuredClone(out.state);Object.values(partial.settings.ozonFboTransfers)[0].qty=29;
 assert.throws(()=>accountAutomaticOrder({state:partial},payload,'Ozon','900'),/частично/);
});
test('preparation, incomplete orders, ambiguous products and shortages cannot mutate any stock',()=>{
 for(const payload of [{supplies:[part('900','READY_TO_SUPPLY')]},{supplies:[{...part(),items:[]}]},{supplies:[part('900','IN_TRANSIT',100)]},{supplies:[part(),{...part(),supplyId:'different',items:[]}]}]){
  const s=state(),before=JSON.stringify(s);assert.throws(()=>accountAutomaticOrder({state:s,stockRows:[]},payload,'Ozon','900'));assert.equal(JSON.stringify(s),before);
 }
 const s=state();s.products.push({...s.products[0],id:'other'});assert.throws(()=>accountAutomaticOrder({state:s}, {supplies:[part()]},'Ozon','900'),/привяжите/);
});
test('activation excludes historical dispatched and terminal orders, leaving preparation eligible for a future confirmation',async()=>{
 const payload={supplies:[part('old'),part('done','COMPLETED'),part('cancel','CANCELLED'),part('next','READY_TO_SUPPLY'),part('unknown','UNSPECIFIED')]};
 assert.deepEqual(historicalOrders(payload),['old','done','cancel','unknown']);
 const f=fixture();f.row.enabled=false;await setAutoAccounting(account,{payload,updated_at:1900},true,{transact:f.options.transact,now:2000});
 assert.deepEqual(f.row.excluded_orders,['old','done','cancel','unknown']);assert.equal(f.writes,0);assert.equal(f.row.enabled_at,2000);
 await assert.rejects(setAutoAccounting(account,{payload},true,{transact:f.options.transact,now:2000}),/свежего/);
});
test('two concurrent worker passes consume one order once and persist the same protected warehouse history',async()=>{
 const f=fixture(),source={payload:{supplies:[part()]},updated_at:1500};
 await Promise.all([runAutoAccounting(account,source,f.options),runAutoAccounting(account,source,f.options)]);
 assert.equal(f.writes,1);assert.equal(f.state.products[0].stock,40);assert.deepEqual(f.row.excluded_orders,['900']);
 assert.equal(Object.keys(f.state.settings.ozonFboTransfers).length,1);
});
test('worker respects opt-in, writes switch, activation boundary, cabinet identity and historical baseline',async()=>{
 for(const variant of ['disabled','writes','boundary','cabinet','baseline']){
  const f=fixture(),source={payload:{supplies:[part()]},updated_at:1500},opts={...f.options};
  if(variant==='disabled')f.row.enabled=false;if(variant==='writes')opts.writesEnabled=false;if(variant==='boundary')source.updated_at=1000;if(variant==='cabinet')f.row.client_id='another';if(variant==='baseline')f.row.excluded_orders=['900'];
  await runAutoAccounting(account,source,opts);assert.equal(f.writes,0,variant);
 }
 const f=fixture(),publicState=await readAutoAccounting(f.options.db,'Ozon','cabinet');assert.equal(publicState.enabled,true);assert.equal(JSON.stringify(publicState).includes('cabinet'),false);
});
test('insufficient stock produces visible attention with no partial reservations or movements',async()=>{
 const f=fixture();await runAutoAccounting(account,{payload:{supplies:[part('900','IN_TRANSIT',100)]},updated_at:1500},f.options);
 assert.equal(f.writes,0);assert.equal(f.state.reservations.length,1);assert.equal(f.row.last_results[0].status,'attention');assert.equal(f.row.last_results[0].orderId,'900');
});
test('an exact reserved plan is consumed automatically; ambiguous plans and missing composition require attention',async()=>{
 const s=state();createDraft(s,{id:'reserved-123',lines:[{sku:'111',qty:30,clusterKey:'id:10',cluster:'Казань'}]},resolver(s),'Ozon');
 const out=accountAutomaticOrder({state:s}, {supplies:[part()]},'Ozon','900',2000);assert.equal(out.draft.id,'reserved-123');assert.equal(out.draft.status,'sent');assert.equal(out.state.reservations.filter(r=>r.source==='FBO').length,1);
 createDraft(s,{id:'reserved-456',lines:[{sku:'111',qty:30,clusterKey:'id:10',cluster:'Казань'}]},resolver(s),'Ozon');
 assert.throws(()=>accountAutomaticOrder({state:s}, {supplies:[part()]},'Ozon','900',2000),/Несколько планов/);
 const f=fixture();await runAutoAccounting(account,{payload:{supplies:[{...part(),items:[]}]},updated_at:1500},f.options);assert.equal(f.writes,0);assert.equal(f.row.last_results[0].status,'attention');
});
test('UI displays server opt-in and requires confirmation before enabling; toggle itself never consumes stock',async()=>{
 const el={innerHTML:''},requests=[],alerts=[];let approved=false;
 const data={warehouse:{revision:2},autoAccounting:{enabled:false,results:[]}};
 const c={window:{fboWarehouseData:()=>data,fboWarehouseReload:async()=>{}},document:{getElementById:()=>el,addEventListener(){}},confirm:()=>approved,alert:m=>alerts.push(m),MILLIONER_API:'',AbortSignal,console,requireWarehouseEditReady:()=>true,fetch:async(url,opts)=>{requests.push({url,body:JSON.parse(opts.body)});return {ok:true,json:async()=>({ok:true})}}};
 vm.runInNewContext(readFileSync(new URL('../../fbo-warehouse-v1.js',import.meta.url),'utf8'),c);
 c.window.renderFboAutoAccounting(data);assert.match(el.innerHTML,/Автосписание новых отправок · выключено/);assert.doesNotMatch(el.innerHTML,/<input[^>]*checked/);
 const input={checked:true,disabled:false};await c.window.setFboAutoAccounting(input);assert.equal(requests.length,0);assert.equal(input.checked,false);
 approved=true;input.checked=true;await c.window.setFboAutoAccounting(input);assert.deepEqual(requests,[{url:'/api/fbo-warehouse/automatic',body:{enabled:true,baseRevision:2}}]);assert.equal(input.disabled,false);assert.equal(alerts.length,0);
});
test.after(()=>pool.end());
