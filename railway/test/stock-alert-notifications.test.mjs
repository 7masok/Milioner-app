import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source=readFileSync(new URL('../../stock-alerts-rescue-v1.js',import.meta.url),'utf8');
const lines=source.split('\n');
const activeFunction=lines.find(line=>line.startsWith('function activeAlertsFrom('));
const unreadFunction=lines.find(line=>line.startsWith('function unreadAlertsFrom('));

test('reading a stock alert clears only the unread badge, not the active list',()=>{
  const context={};
  vm.runInNewContext(`${lines.find(line=>line.startsWith('function alertIdentity('))}\n${lines.find(line=>line.startsWith('function isHiddenRecord('))}\n${activeFunction}\n${unreadFunction}`,context);
  const rows=[{p:{id:'a'}},{p:{id:'b'}}];
  const active=context.activeAlertsFrom(rows,{});
  assert.equal(active.length,2);
  assert.equal(context.unreadAlertsFrom(active,{a:{seen:true}}).length,1);
  assert.equal(context.activeAlertsFrom(rows,{a:{dismissed:true}}).length,1);
});

test('stock bell alerts only when sale stock is zero and warehouse stock can be released',()=>{
  const predicate=lines.find(line=>line.startsWith('function shouldAlertWarehouseRelease('));
  const context={};
  vm.runInNewContext(predicate,context);
  assert.equal(context.shouldAlertWarehouseRelease(0,5),true);
  assert.equal(context.shouldAlertWarehouseRelease(1,5),false);
  assert.equal(context.shouldAlertWarehouseRelease(0,0),false);
  assert.doesNotMatch(source,/openStockAlertPurchase/);
  assert.doesNotMatch(source,/>Закупить</);
  assert.match(source,/>Выставить со склада</);
});

function restockFixture(){
 const context={};const start=source.indexOf('function reserveRestockAlerts('),end=source.indexOf('function reserveAlertRows(',start);
 vm.runInNewContext(lines.find(l=>l.startsWith('function safeNum('))+'\n'+source.slice(start,end),context);
 const state={products:[{id:'a',name:'Товар А',stock:0}],reservations:[{id:'r',source:'Kaspi',externalKey:'Kaspi:o:e',productId:'a',qty:2,date:100,active:true}],purchases:[{id:'lot',shipmentId:'ship',productId:'a',qty:5,status:'at_warehouse',warehouseReceivedAt:200}],kaspiOrderFeed:[{orderId:'o',entryId:'e',market:'Kaspi',code:'123',productId:'a',qty:2,creationDate:100}]};
 return {state,build:context.reserveRestockAlerts,context};
}
test('receipt for a waiting reservation creates a separate alert with exact order and quantity without changing stock',()=>{
 const f=restockFixture(),before=structuredClone(f.state),rows=f.build(f.state);assert.equal(rows.length,1);assert.equal(rows[0].kind,'reserve-restock');assert.equal(rows[0].orders[0].code,'123');assert.equal(rows[0].orders[0].orderId,'o');assert.equal(rows[0].orders[0].available,2);assert.deepEqual(f.state,before);
});
test('reminder survives full and partial release, with the same identity so reading it does not re-alert',()=>{
 const f=restockFixture(),id=f.build(f.state)[0].alertId;f.state.products[0].stock=2;f.state.purchases[0].qty=3;f.state.purchases.push({...f.state.purchases[0],id:'released',qty:2,status:'received',receivedAt:250});assert.equal(f.build(f.state)[0].alertId,id);
 f.state.products[0].stock=5;f.state.purchases=[{...f.state.purchases[0],qty:5,status:'received',receivedAt:250}];assert.equal(f.build(f.state)[0].alertId,id);f.state.reservations[0].active=false;assert.equal(f.build(f.state).length,0);
});
test('in-transit purchase, no stock, cancelled reservation and orders created after arrival do not alert',()=>{
 for(const mutate of [s=>s.purchases[0].status='to_me',s=>s.purchases=[],s=>s.reservations[0].active=false,s=>s.reservations[0].date=300]){const f=restockFixture();mutate(f.state);assert.equal(f.build(f.state).length,0)}
 const f=restockFixture();f.context.marketplaceLifecycleStage=()=> 'cancelled';assert.equal(f.build(f.state).length,0);f.context.marketplaceLifecycleStage=()=> 'delivery';assert.equal(f.build(f.state).length,0);
});
test('an already sufficient original stock does not create a restock reminder',()=>{const f=restockFixture();f.state.products[0].stock=20;assert.equal(f.build(f.state).length,0)});
test('a partial arrival allocates scarce units to older reservations and does not promise a complete shipment',()=>{
 const f=restockFixture();f.state.purchases[0].qty=1;f.state.reservations.push({...f.state.reservations[0],id:'r2',externalKey:'Kaspi:o2:e2',date:110});f.state.kaspiOrderFeed.push({market:'Kaspi',orderId:'o2',entryId:'e2',code:'456'});const rows=f.build(f.state);assert.equal(rows[0].orders.length,1);assert.equal(rows[0].orders[0].available,1);assert.equal(rows[0].orders[0].qty,2);assert.equal(rows[0].orders[0].code,'123');
});
test('bundle reservation uses physical component quantities; WB2 is kept as a distinct account',()=>{
 const f=restockFixture();f.state.products.push({id:'bundle',kind:'bundle',name:'Набор',components:[{productId:'a',qty:3}]});f.state.reservations[0]={...f.state.reservations[0],source:'WB2',externalKey:'WB2:o:e',productId:'bundle',qty:1};f.state.wbOrderFeed=[{market:'WB2',orderId:'o',entryId:'e',code:'WB-2'}];const rows=f.build(f.state);assert.equal(rows[0].orders[0].qty,3);assert.equal(rows[0].orders[0].source,'WB2');assert.equal(rows[0].orders[0].bundle,'Набор');
});
test('a new shipment creates a fresh unread identity and two receipts at the same arrival time are summed',()=>{
 const f=restockFixture(),id=f.build(f.state)[0].alertId;f.state.purchases.push({...f.state.purchases[0],id:'lot2',shipmentId:'ship2',warehouseReceivedAt:300});assert.notEqual(f.build(f.state)[0].alertId,id);
 f.state.products[0].stock=10;f.state.purchases[0].status='received';f.state.purchases[1].status='received';f.state.purchases[1].warehouseReceivedAt=200;assert.equal(f.build(f.state).length,1);
});
test('hiding an ordinary warehouse alert does not hide the order reminder for that same product',()=>{
 const ctx={};vm.runInNewContext(lines.find(l=>l.startsWith('function alertIdentity('))+'\n'+lines.find(l=>l.startsWith('function isHiddenRecord('))+'\n'+activeFunction+'\n'+unreadFunction,ctx);const rows=[{p:{id:'a'}},{p:{id:'a'},alertId:'reserve-restock:a:lot'}];assert.equal(ctx.activeAlertsFrom(rows,{a:true}).length,1);assert.equal(ctx.unreadAlertsFrom(rows,{a:true}).length,1);assert.equal(ctx.unreadAlertsFrom(rows,{'reserve-restock:a:lot':true}).length,1);
});

test('same-day receipt uses the recorded arrival time rather than midnight and remains stable when released',()=>{
 const f=restockFixture();f.state.reservations[0].date=150;f.state.purchases[0].warehouseReceivedAt=100;f.state.purchases[0].receiptRecordedAt=200;const rows=f.build(f.state);assert.equal(rows.length,1);f.state.purchases[0].status='received';f.state.purchases[0].receivedAt=300;f.state.products[0].stock=5;assert.equal(f.build(f.state)[0].alertId,rows[0].alertId);
});
test('opening a notification sets exact marketplace, order search and creation-date range without warehouse writes',()=>{
 const start=source.indexOf('window.openRestockedReserveOrder=function'),end=source.indexOf('\n};',start)+3,inputs={orderSearch:{value:''}},snapshot={products:[{id:'a',stock:5}],reservations:[],kaspiOrderFeed:[{market:'Kaspi',orderId:'o',code:'123',creationDate:100}]},before=structuredClone(snapshot);let rendered=0;
 const ctx={window:{},state:snapshot,document:{getElementById:id=>inputs[id],querySelectorAll:()=>[]},closeModal(){},openView(){},normalizeName:s=>String(s).toLowerCase(),orderDateValue:()=> '2026-10-18',renderOrderPeriodControls(){},renderMarketplaceOrders(){rendered++},setTimeout(){},alert(){throw Error('navigation failed')}};
 vm.runInNewContext(source.slice(start,end),ctx);ctx.window.openRestockedReserveOrder('Kaspi','o','123');assert.equal(ctx.selectedOrderMarket,'Kaspi');assert.equal(ctx.orderSearchText,'123');assert.equal(ctx.orderCustomFrom,'2026-10-18');assert.equal(ctx.orderCustomTo,ctx.orderCustomFrom);assert.equal(ctx.unmatchedOrderFilter,false);assert.equal(inputs.orderSearch.value,'123');assert.equal(rendered,1);assert.deepEqual(snapshot,before);
});

test('notification links safely encode apostrophes from shipment names and order codes',()=>{const ctx={};vm.runInNewContext(lines.find(l=>l.startsWith('function encodedAlertArg(')),ctx);assert.equal(ctx.encodedAlertArg("Китай 'поставка'"),encodeURIComponent("Китай 'поставка'").replace(/'/g,'%27'));assert.ok(!ctx.encodedAlertArg("12'3").includes("'"));});

function notificationFixture({shared={},legacy={},reserve=false}={}){
 const stored=new Map([['milioner_warehouse_release_hidden_v1',JSON.stringify(legacy)]]),state={settings:structuredClone(shared),products:[{id:'a',name:"Товар 'А'",stock:0}],purchases:[{id:'lot',productId:'a',qty:3,status:'at_warehouse',warehouseReceivedAt:200}],reservations:reserve?[{id:'r',source:'Kaspi',externalKey:'Kaspi:o:e',productId:'a',qty:1,date:100,active:true}]:[],kaspiOrderFeed:reserve?[{market:'Kaspi',orderId:'o',entryId:'e',code:'123',creationDate:100}]:[]};let sheet='',saves=0;
 const ctx=vm.createContext({window:{},state,warehouseRemoteReady:true,homeOrdersSettled:true,document:{readyState:'loading',addEventListener(){},getElementById:id=>id==='stockAlertStyle'?{}:null,querySelector:()=>null},localStorage:{getItem:key=>stored.get(key)||null,setItem:(key,value)=>stored.set(key,value)},setTimeout(){},setInterval(){},Date,console,prod:id=>state.products.find(p=>p.id===id),stockProducts:()=>state.products,isBundleProduct:()=>false,reserved:p=>state.reservations.filter(r=>r.active&&r.productId===p.id).reduce((n,r)=>n+r.qty,0),productAvailableStock:p=>Math.max(0,p.stock-state.reservations.filter(r=>r.active&&r.productId===p.id).reduce((n,r)=>n+r.qty,0)),purchaseAtWarehouseQty:id=>state.purchases.filter(r=>r.productId===id&&r.status==='at_warehouse').reduce((n,r)=>n+r.qty,0),showSheet:s=>sheet=s,save:()=>saves++,closeModal(){},requireWarehouseEditReady:()=>true,alert(){assert.fail('the bell must open a recoverable list instead of a browser alert')}});
 vm.runInContext(source.replace(/\}\)\(\);\s*$/,'window.testApi={activeAlerts,hiddenAlertEntries,readHidden};})();'),ctx);
 return{ctx,state,stored,window:ctx.window,get sheet(){return sheet},get saves(){return saves}};
}
test('hiding the last stock alert keeps Hidden accessible, and Restore returns the active reminder without changing stock',()=>{
 const f=notificationFixture(),physical=JSON.stringify({products:f.state.products,purchases:f.state.purchases,reservations:f.state.reservations});f.window.hideStockAlert('a');
 assert.equal(f.window.testApi.activeAlerts().length,0);assert.equal(f.window.testApi.hiddenAlertEntries().length,1);assert.match(f.sheet,/Скрытые · 1/);assert.match(f.sheet,/нет активных предупреждений/);
 f.window.openStockAlerts('hidden');assert.match(f.sheet,/Вернуть/);assert.match(f.sheet,/Товар &#39;А&#39;/);f.window.restoreHiddenStockAlert('a');assert.equal(f.window.testApi.activeAlerts().length,1);assert.equal(f.window.testApi.hiddenAlertEntries().length,0);assert.equal(f.state.settings.warehouseReleaseAlertDismissals.a.dismissed,false);
 assert.equal(JSON.stringify({products:f.state.products,purchases:f.state.purchases,reservations:f.state.reservations}),physical);
});
test('legacy hidden alerts restore on this device and cannot be rehidden by old local storage on another device',()=>{
 const f=notificationFixture({legacy:{a:{dismissed:true,at:1}}});f.window.openStockAlerts();assert.match(f.sheet,/Скрытые · 1/);f.window.restoreHiddenStockAlert('a');assert.equal(f.window.testApi.activeAlerts().length,1);
 const another=notificationFixture({shared:f.state.settings,legacy:{a:{dismissed:true,at:1}}});assert.equal(another.window.testApi.activeAlerts().length,1);assert.equal(another.window.testApi.hiddenAlertEntries().length,0);
});
test('restoring resolved or deleted hidden alerts does not fabricate a new active warning',()=>{
 for(const deleted of [false,true]){const f=notificationFixture({shared:{warehouseReleaseAlertDismissals:{a:{dismissed:true,name:'Старый товар'}}}});f.state.purchases=[];if(deleted)f.state.products=[];f.window.openStockAlerts('hidden');assert.match(f.sheet,/сейчас не требуется/);f.window.restoreHiddenStockAlert('a');assert.equal(f.window.testApi.activeAlerts().length,0);assert.equal(f.window.testApi.hiddenAlertEntries().length,0);assert.match(f.sheet,/Активные · 0/)}
});
test('reserved-restock reminders have their own restorable identity and closed reservations never reappear',()=>{
 const f=notificationFixture({reserve:true}),reminder=f.window.testApi.activeAlerts().find(x=>x.kind==='reserve-restock'),id=reminder.alertId;f.window.hideReserveRestockAlert(encodeURIComponent(id));assert.equal(f.window.testApi.hiddenAlertEntries()[0].id,id);assert.match(f.sheet,/Скрытые · 1/);
 f.window.restoreHiddenStockAlert(encodeURIComponent(id));assert.ok(f.window.testApi.activeAlerts().some(x=>x.alertId===id));f.window.hideReserveRestockAlert(encodeURIComponent(id));f.state.reservations[0].active=false;f.window.restoreHiddenStockAlert(encodeURIComponent(id));assert.ok(f.window.testApi.activeAlerts().every(x=>x.kind!=='reserve-restock'));
});
