import test from 'node:test';
import assert from 'node:assert/strict';
import {correctKaspiContents,effectiveKaspiRow,kaspiContentSignature,kaspiContentOverride,preserveKaspiContents,contentKey} from '../src/kaspi-order-content.js';
import {stockLedgerViolation} from '../src/warehouse-ledger.js';
import {reconcileMarketplaceSales} from '../src/marketplace-sale-reconcile.js';
import {reconcileKaspiReservations} from '../src/reservation-reconcile.js';
import {pool} from '../src/db.js';
const at=Date.UTC(2026,9,19),key='Kaspi:order:entry';
function fixture(collected=true){
 const row={market:'Kaspi',order_id:'order',entry_id:'entry',code:'123',sku:'sku-a',product_id:'a',product_name:'Товар А',qty:2,unit_price:500,total_price:1000,seller_delivery_cost:100,marketplace_fee:150,status:'ACCEPTED_BY_MERCHANT',state:collected?'KASPI_DELIVERY_TRANSIT':'NEW',creation_date:at-86400000};
 const state={settings:{},products:[{id:'a',name:'А',stock:8,cost:100,kaspi:'sku-a'},{id:'b',name:'Б',stock:10,cost:200,kaspi:'sku-b'}],sales:collected?[{id:'sale-a',externalKey:key,productId:'a',qty:2,price:500,cost:100,fee:125,channel:'Kaspi',date:row.creation_date,serverReconciled:true}]:[],movements:collected?[{id:'debit-a',type:'продажа',externalKey:key,productId:'a',qty:-2,date:at-10000}]:[],reservations:collected?[]:[{id:'r-a',source:'Kaspi',externalKey:key,productId:'a',qty:2,active:true}],purchases:[{id:'lot',productId:'a',qty:10,remainingQty:10}]};
 const input={signature:kaspiContentSignature([row]),items:[{entryId:'entry',productId:'b',qty:3,version:0}],reason:'Другой цвет'};return {state,row,input};
}
test('collected Kaspi replacement restores only the exact debit, consumes actual item and preserves commercial amount and other orders',()=>{
 const {state,row,input}=fixture(),before=structuredClone(state);state.sales.push({id:'other',externalKey:'Kaspi:other:e',productId:'a',qty:1});
 const result=correctKaspiContents(state,[row],input,at);assert.equal(result.changed,true);assert.equal(state.products[0].stock,10);assert.equal(state.products[1].stock,7);
 const sale=state.sales.find(s=>s.externalKey===key);assert.equal(sale.id,'sale-a');assert.equal(sale.productId,'b');assert.equal(sale.qty,3);assert.equal(sale.price*sale.qty,1000);assert.equal(sale.fee*sale.qty,250);assert.equal(sale.cost,200);assert.ok(state.sales.some(s=>s.id==='other'));
 assert.equal(stockLedgerViolation(before,state),null);assert.deepEqual(state.purchases,before.purchases);assert.equal(row.product_id,'a');assert.equal(state.products[0].kaspi,'sku-a');assert.equal(kaspiContentOverride(state,'order','entry').history[0].reason,'Другой цвет');
});
test('before delivery only reservation changes, never physical stock or sale',()=>{
 const {state,row,input}=fixture(false),before=structuredClone(state);correctKaspiContents(state,[row],input,at);
 assert.deepEqual(state.products,before.products);assert.deepEqual(state.sales,[]);assert.deepEqual(state.movements,[]);const active=state.reservations.filter(r=>r.active);assert.equal(active.length,1);assert.equal(active[0].productId,'b');assert.equal(active[0].qty,3);
});
test('repeat request cannot deduct twice and later replacements reverse the latest item only',()=>{
 const {state,row,input}=fixture();correctKaspiContents(state,[row],input,at);const first=structuredClone(state);
 assert.throws(()=>correctKaspiContents(state,[row],input,at+1),/другом устройстве/);assert.deepEqual(state,first);
 input.items[0].version=1;assert.equal(correctKaspiContents(state,[row],input,at+1).changed,false);assert.deepEqual(state,first);
 input.items[0]={entryId:'entry',productId:'a',qty:1,version:1};correctKaspiContents(state,[row],input,at+2);assert.equal(state.products[0].stock,9);assert.equal(state.products[1].stock,10);assert.equal(state.sales.find(s=>s.externalKey===key).qty,1);assert.equal(kaspiContentOverride(state,'order','entry').history.length,2);
});
test('recount, processed return, missing debit, insufficient stock, invalid quantity and stale composition never partially write',()=>{
 for(const mutate of [f=>f.state.settings.kaspiReturnReceipts={order:{at}},f=>f.state.movements.push({type:'инвентаризация',productId:'a',date:at}),f=>f.state.movements=[],f=>f.state.products[1].stock=2,f=>f.input.items[0].qty=0,f=>f.input.signature='old',f=>f.input.items[0].productId='missing',f=>f.state.sales[0].serverReconciled=false]){
  const f=fixture();mutate(f);const before=structuredClone(f.state);assert.throws(()=>correctKaspiContents(f.state,[f.row],f.input,at));assert.deepEqual(f.state,before);
 }
});
test('other orders and bundle-component reservations reduce free replacement stock',()=>{
 const f=fixture();f.state.products.push({id:'set',kind:'bundle',components:[{productId:'b',qty:2}]});f.state.reservations.push({source:'Kaspi',externalKey:'other',productId:'set',qty:4,active:true});assert.throws(()=>correctKaspiContents(f.state,[f.row],f.input,at),/Недостаточно/);
});
test('same-product quantity correction restores the exact previous quantity and ignores historical restored debits',()=>{
 const f=fixture();f.input.items[0]={entryId:'entry',productId:'a',qty:4,version:0};correctKaspiContents(f.state,[f.row],f.input,at);assert.equal(f.state.products[0].stock,6);assert.equal(f.state.products[1].stock,10);
});
test('cancelled orders and legacy untracked shipped orders are blocked',()=>{
 const f=fixture(false);f.row.status='CANCELLED';f.input.signature=kaspiContentSignature([f.row]);assert.throws(()=>correctKaspiContents(f.state,[f.row],f.input,at),/отменён/);
 const old=fixture();old.state.sales=[];old.state.movements=[];old.row.creation_date=1;old.input.signature=kaspiContentSignature([old.row]);assert.throws(()=>correctKaspiContents(old.state,[old.row],old.input,at),/старого заказа/);
});
test('browser warehouse saves cannot inject, overwrite or delete server-owned per-order corrections',()=>{
 const f=fixture();correctKaspiContents(f.state,[f.row],f.input,at);const next={settings:{unrelated:true,kaspiOrderContents:{evil:{}}}};preserveKaspiContents(f.state,next);assert.deepEqual(next.settings.kaspiOrderContents,f.state.settings.kaspiOrderContents);assert.equal(next.settings.unrelated,true);preserveKaspiContents({},next);assert.equal(next.settings.kaspiOrderContents,undefined);
 const row=effectiveKaspiRow(f.state,f.row);assert.equal(row.product_id,'b');assert.equal(row.qty,3);assert.equal(row.unit_price*row.qty,1000);assert.equal(contentKey('a:b','c'),contentKey('a:b','c'));assert.notEqual(contentKey('a:b','c'),contentKey('a','b:c'));
});
async function fakeDb(state,rows,run){
 const original=pool.connect,queries=[];const client={release(){},async query(sql,args=[]){queries.push({sql,args});
  if(sql.includes('SELECT payload,revision FROM warehouse_state'))return {rowCount:1,rows:[{payload:JSON.stringify({settings:state.settings}),revision:5}]};
  if(sql.includes('FROM marketplace_order_lines o'))return {rows};
  for(const [table,field]of [['warehouse_products','products'],['warehouse_movements','movements'],['warehouse_sales','sales'],['warehouse_reservations','reservations'],['warehouse_purchases','purchases']])if(sql.trim().startsWith('SELECT')&&sql.includes('FROM '+table))return {rows:(state[field]||[]).map(payload=>({payload})),rowCount:(state[field]||[]).length};
  if(sql.includes('RETURNING id'))return {rows:[{id:'backup'}],rowCount:1};return {rows:[],rowCount:0};
 }};pool.connect=async()=>client;try{await run(queries)}finally{pool.connect=original}
}
test('a fresh Kaspi delivery sync consumes the per-order replacement, not the global SKU product',async()=>{
 const f=fixture(false);correctKaspiContents(f.state,[f.row],f.input,at);f.row.state='KASPI_DELIVERY_TRANSIT';
 await fakeDb(f.state,[f.row],async queries=>{const result=await reconcileMarketplaceSales('Kaspi');assert.equal(result.sold,3);
 const products=queries.find(q=>q.sql.includes('INSERT INTO warehouse_products'));const changed=JSON.parse(products.args[0]);assert.equal(changed.find(p=>p.id==='a').stock,8);assert.equal(changed.find(p=>p.id==='b').stock,7);
 const sale=queries.find(q=>q.sql.includes('INSERT INTO warehouse_sales'));assert.equal(JSON.parse(sale.args[0])[0].productId,'b');});
});
test('reservation sync retains order replacement and does not rebind the shared Kaspi SKU',async()=>{
 const f=fixture(false);correctKaspiContents(f.state,[f.row],f.input,at);f.state.settings.kaspiReservationAuthoritativeV1={at};
 await fakeDb(f.state,[f.row],async queries=>{await reconcileKaspiReservations([{orderId:'order',entryId:'entry'}]);
 assert.ok(!queries.some(q=>q.sql.includes('INSERT INTO product_links')));const write=queries.find(q=>q.sql.includes('INSERT INTO warehouse_reservations'));
 if(write){const active=JSON.parse(write.args[0]).filter(r=>r.active);assert.equal(active.length,1);assert.equal(active[0].productId,'b');assert.equal(active[0].qty,3);}});
});
test('a subsequent delivery sync never consumes the corrected shipment twice',async()=>{
 const f=fixture();correctKaspiContents(f.state,[f.row],f.input,at);await fakeDb(f.state,[f.row],async queries=>{const result=await reconcileMarketplaceSales('Kaspi');assert.equal(result.changed,false);assert.ok(!queries.some(q=>q.sql.includes('UPDATE warehouse_state')))});
});

test('save endpoint atomically writes stock, compensation, sale, reservation, backup and audit without editing Kaspi orders or SKU links',async()=>{
 const {kaspiOrderContentRouter}=await import('../src/kaspi-order-content-router.js');const f=fixture();
 const handler=kaspiOrderContentRouter.stack.find(r=>r.route?.path==='/kaspi/order-content/:orderId'&&r.route.methods.post).route.stack.at(-1).handle;
 await fakeDb(f.state,[f.row],async queries=>{
  const response=await new Promise((resolve,reject)=>handler({params:{orderId:'order'},body:{...f.input,revision:5}},{json:resolve},reject));assert.equal(response.ok,true);assert.equal(response.revision,6);
  assert.ok(queries.find(q=>q.sql.includes('FOR UPDATE')));assert.ok(queries.find(q=>q.sql.includes('FOR SHARE OF o')));
  const backup=queries.findIndex(q=>q.sql.includes('INSERT INTO warehouse_backups')),save=queries.findIndex(q=>q.sql.includes('UPDATE warehouse_state'));
  assert.ok(backup>=0&&save>backup);assert.ok(queries.find(q=>q.sql.includes('INSERT INTO warehouse_audit')));
  assert.ok(!queries.some(q=>/^(UPDATE|INSERT INTO|DELETE FROM) (marketplace_order_lines|product_links)/.test(q.sql.trim())));
  const stored=JSON.parse(queries[save].args[0]);assert.equal(stored.settings.kaspiOrderContents[contentKey('order','entry')].productId,'b');assert.equal(queries.at(-1).sql,'COMMIT');
 });
});
test('stale warehouse revision rolls back before any business write',async()=>{
 const {kaspiOrderContentRouter}=await import('../src/kaspi-order-content-router.js');const f=fixture();
 const handler=kaspiOrderContentRouter.stack.find(r=>r.route?.methods.post).route.stack.at(-1).handle;
 await fakeDb(f.state,[f.row],async queries=>{
  await assert.rejects(new Promise((resolve,reject)=>handler({params:{orderId:'order'},body:{...f.input,revision:4}},{json:resolve},reject)),/Склад обновился/);
  assert.equal(queries.at(-1).sql,'ROLLBACK');assert.ok(!queries.some(q=>/^(UPDATE|INSERT|DELETE)/.test(q.sql.trim())));
 });
});

test('Kaspi order title and composition button open the editor without changing WB cards',async()=>{
 const {readFileSync}=await import('node:fs'),vm=await import('node:vm');const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8'),source=html.split('\n').find(l=>l.startsWith('function renderMarketplaceOrders(')),list={innerHTML:''};
 const group=market=>({market,orderId:'order',code:'123',creationDate:at,status:'COMPLETED',state:'ARCHIVE',lines:[{orderId:'order',entryId:'entry',productId:'a',productName:'А',qty:2,sku:'sku-a',contentCorrectedAt:at}]});
 const ctx={document:{getElementById:id=>id==='kaspiOrderList'?list:null},renderOrderPager(){},homeOrdersSettled:true,selectedOrderMarket:'Kaspi',selectedWbAccount:'all',state:{kaspiOrderFeed:[],wbOrderFeed:[]},groupMarketplaceOrders:()=>[group('Kaspi')],filterMarketplaceOrdersByPeriod:x=>x,filterMarketplaceOrdersBySearch:x=>x,orderHasUnmatchedLine:()=>false,isPendingMarketplaceLine:()=>false,marketplaceOrderTotals:()=>({qty:2,amount:1000}),allMarketplaceOrderTotalsForPeriod:()=>({qty:2,amount:1000}),unmatchedOrderFilter:false,orderPage:1,ORDER_PAGE_SIZE:15,orderSearchText:'',marketplaceLifecycleStage:()=> 'delivery',marketplaceStatusLabel:()=> 'Доставлен',prod:()=>({id:'a',name:'А'}),fmt:String,esc:String,isWbMarket:m=>m==='WB'};
 vm.runInNewContext(source+';renderMarketplaceOrders()',ctx);assert.match(list.innerHTML,/onclick="openKaspiOrderContents\('order'\)"/);assert.match(list.innerHTML,/>Состав<\/button>/);assert.match(list.innerHTML,/Состав изменён/);assert.doesNotMatch(list.innerHTML,/>>/);
 ctx.selectedOrderMarket='WB';ctx.groupMarketplaceOrders=()=>[group('WB')];vm.runInNewContext('renderMarketplaceOrders()',ctx);assert.doesNotMatch(list.innerHTML,/openKaspiOrderContents/);
});

for(const market of ['WB','WB2']){
 test(`${market} deductions ignore Kaspi replacements and keep original product, quantity and fees`,async()=>{
  const f=fixture(false);f.state.reservations=[];f.state.settings.kaspiOrderContents={[contentKey('order','entry')]:{productId:'b',qty:99}};
  Object.assign(f.row,{market,status:'complete',state:'sorted'});
  await fakeDb(f.state,[f.row],async queries=>{const result=await reconcileMarketplaceSales(market);assert.equal(result.sold,2);
   const p=JSON.parse(queries.find(q=>q.sql.includes('INSERT INTO warehouse_products')).args[0]);assert.equal(p.find(x=>x.id==='a').stock,6);assert.equal(p.find(x=>x.id==='b').stock,10);
   const sales=JSON.parse(queries.find(q=>q.sql.includes('INSERT INTO warehouse_sales')).args[0]);assert.equal(sales[0].productId,'a');assert.equal(sales[0].qty,2);assert.equal(sales[0].price,500);assert.equal(sales[0].fee,125);assert.equal(sales[0].channel,market);
  });
 });
 test(`${market} premature-sale restoration remains unchanged and never touches the Kaspi replacement product`,async()=>{
  const f=fixture();f.state.settings.kaspiOrderContents={[contentKey('order','entry')]:{productId:'b',qty:99}};f.state.sales[0].externalKey=`${market}:order:entry`;f.state.sales[0].channel=market;f.state.movements[0].externalKey=`${market}:order:entry`;Object.assign(f.row,{market,status:'complete',state:'waiting'});
  await fakeDb(f.state,[f.row],async queries=>{const result=await reconcileMarketplaceSales(market);assert.equal(result.sold,0);assert.equal(result.restored,2);
   const p=JSON.parse(queries.find(q=>q.sql.includes('INSERT INTO warehouse_products')).args[0]);assert.equal(p.find(x=>x.id==='a').stock,10);assert.equal(p.find(x=>x.id==='b').stock,10);
  });
 });
}
