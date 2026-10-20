import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {normalizedPurchase} from '../src/warehouse-purchases.js';

const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8'),lines=html.split('\n');
const feature=html.slice(html.indexOf('let purchaseCartPickerDraft='),html.indexOf('function purchaseHistoricalUnitCosts('));
const fn=name=>lines.find(line=>line.startsWith('function '+name+'('));
function fixture(){
  const products=[{id:'a',name:'Товар А',stock:5},{id:'b',name:'Товар Б',stock:8},{id:'c',name:'Новый товар В',stock:0}];
  const workflow=[{id:'cart',name:'Корзина',days:0},{id:'paid',name:'Оплачено',days:0},{id:'delivery_warehouse',name:'Китай',days:20},{id:'arrived',name:'Алматы',days:0}];
  const purchase=(id,productId,qty,shipmentId='seller-one',stage='cart')=>({id,productId,qty,remainingQty:0,shipmentId,batch:shipmentId==='seller-one'?'Продавец 1':'Продавец 2',status:'to_forwarder',workflowStageId:stage,workflowStageAt:123,orderedAt:100,date:100,createdAt:100,buyTotal:qty*100,unitCost:100,delivery:qty*10,shipmentPurchaseTotal:900,shipmentDeliveryTotal:90,receivedAt:0,customStatus:'Ожидаю покупки'});
  const state={products,purchases:[purchase('old-a','a',4),purchase('old-b','b',5),purchase('other','c',2,'seller-two'),purchase('paid','a',3,'paid-shipment','paid')],movements:[],settings:{purchaseWorkflow:workflow}};
  const elements=new Map(),draft=[],alerts=[],screens=[],deletes=[],receipts=[];let saves=0,ready=true,next=1;
  const element=id=>{if(!elements.has(id))elements.set(id,{value:'',dataset:{},disabled:false,insertAdjacentHTML(){}});return elements.get(id);};
  const ctx={state,window:{},document:{getElementById:element},purchasePlanSelection:new Set(['c']),
    prod:id=>products.find(p=>p.id===id),isBundleProduct:()=>false,normalizeName:s=>String(s).toLowerCase().trim(),
    requireWarehouseEditReady:()=>ready,purchaseWorkflow:()=>workflow,purchaseWorkflowStage:r=>r.workflowStageId,
    purchaseRecommendations:()=>[{productId:'c',qty:7,unitCost:150,product:products[2]}],
    productNameById:id=>products.find(p=>p.id===id)?.name||'—',esc:s=>String(s).replace(/</g,'&lt;'),
    alert:s=>alerts.push(s),id:()=>`new-${next++}`,localDateInputValue:()=> '2026-10-07',localDateStart:()=>100,
    showSheet(s){screens.push(s);draft.splice(0);for(const key of ['editPorDate','editPorBatch','editPorBuyTotal','editPorDelivery']){const match=s.match(new RegExp('id="'+key+'"[^>]*value="([^"]*)"'));element(key).value=match?.[1]||'';}for(const key of ['editPorStage','quickPurchaseStage']){const select=s.match(new RegExp('<select id="'+key+'" data-current-stage="([^"]*)"'));element(key).value=select?.[1]||'';element(key).dataset.currentStage=select?.[1]||'';}element('editPurchaseItems').dataset={};},
    addEditPurchaseItem(productId,qty){draft.push({productId,qty:Number(qty),query:'',selectedName:products.find(p=>p.id===productId)?.name||''});},
    editPurchaseDraftRows:()=>draft,updateEditPurchaseCalculator(){},
    rememberPurchaseDeletes:ids=>deletes.push(...ids),save(){saves++;return true;},closeModal(){},render(){},renderPurchases(){},setTimeout(){},openReceivePurchaseShipment:key=>receipts.push(key),
    openCorrectReceivedPurchaseShipment(){throw Error('must not enter received correction');},
    openModal:type=>screens.push('open:'+type),purchasePage:1,
  };
  vm.createContext(ctx);vm.runInContext([fn('purchaseStatus'),fn('isRealPurchase'),fn('purchaseShipmentStage'),fn('purchaseShipmentGroups'),fn('purchaseShipmentRows'),fn('purchaseShipmentTotals'),fn('purchaseDraftCosts'),feature,fn('purchaseWorkflowPhase'),fn('purchaseEditStageField'),fn('purchaseEditStagePlan'),fn('applyPurchaseEditStage'),fn('quickEditPurchaseBatch'),fn('saveQuickPurchaseBatch'),fn('openEditPurchaseShipment'),fn('savePurchaseShipmentEdit')].join('\n'),ctx);
  return {ctx,state,products,elements,element,draft,alerts,screens,deletes,receipts,get saves(){return saves;},set ready(v){ready=v;}};
}

test('a new item joins the same seller cart shipment, preserving old IDs, stage, totals and stock',()=>{
  const f=fixture(),{ctx,state,draft,element}=f,before=structuredClone(state);
  ctx.openSelectedPurchaseCartShipment();assert.match(f.screens.at(-1),/Выберите закупку у нужного продавца/);assert.match(f.screens.at(-1),/Товар А, Товар Б/);assert.doesNotMatch(f.screens.at(-1),/paid-shipment/);
  ctx.addSelectedPurchaseToCartShipment('seller-one');
  assert.deepEqual(draft.map(r=>[r.productId,r.qty]),[['c',7],['a',4],['b',5]],'editor displays Новый товар В, Товар А, Товар Б in alphabetical order');
  assert.deepEqual(state,before,'opening the draft does not write purchases');
  assert.equal(element('editPorBuyTotal').value,'900','historical estimates do not auto-fill the actual invoice');
  element('editPorBuyTotal').value='1600';element('editPorDelivery').value='160';
  ctx.savePurchaseShipmentEdit('seller-one');
  const rows=state.purchases.filter(r=>r.shipmentId==='seller-one').sort((a,b)=>a.productId.localeCompare(b.productId));assert.equal(rows.length,3);
  assert.deepEqual(rows.map(r=>r.id).slice(0,2),['old-a','old-b']);assert.equal(rows[2].qty,7);
  assert.ok(rows.every(r=>r.status==='to_forwarder'&&r.workflowStageId==='cart'&&r.workflowStageAt===123&&r.remainingQty===0));
  assert.equal(rows.reduce((s,r)=>s+r.buyTotal,0),1600);assert.equal(rows.reduce((s,r)=>s+r.delivery,0),160);
  assert.equal(rows[2].customStatus,'Ожидаю покупки');assert.equal(rows[2].landedUnitCost,0);
  assert.deepEqual(state.purchases.find(r=>r.id==='other'),before.purchases.find(r=>r.id==='other'));
  assert.deepEqual(state.products,before.products);assert.deepEqual(state.movements,[]);assert.equal(f.saves,1);assert.equal(ctx.purchasePlanSelection.size,0);
  assert.deepEqual(normalizedPurchase(rows[2]),JSON.parse(JSON.stringify(rows[2])),'PostgreSQL purchase payload retains cart stage and shipment identity');
});

test('an existing product merges quantities into one line and rejects invalid or deleted source items',()=>{
  const f=fixture(),{ctx,state}=f;
  const merged=ctx.mergePurchaseShipmentDraftItems(state.purchases.slice(0,2),[{productId:'a',qty:3},{productId:'c',qty:7}]);
  assert.deepEqual(JSON.parse(JSON.stringify(merged)),[{productId:'a',qty:7},{productId:'b',qty:5},{productId:'c',qty:7}]);
  for(const item of [{productId:'missing',qty:7},{productId:'c',qty:0},{productId:'c',qty:1.5},{productId:'c',qty:Infinity}])assert.throws(()=>ctx.mergePurchaseShipmentDraftItems([], [item]),/Проверьте/);
  assert.equal(state.purchases[0].qty,4);
});

test('cart destinations exclude paid, mixed and received shipments and respect warehouse readiness',()=>{
  const f=fixture(),{ctx,state}=f;
  assert.deepEqual(Array.from(ctx.purchaseCartShipmentGroups(),g=>g.key),['seller-one','seller-two']);
  state.purchases.find(r=>r.id==='old-b').workflowStageId='paid';assert.deepEqual(Array.from(ctx.purchaseCartShipmentGroups(),g=>g.key),['seller-two']);
  ctx.openSelectedPurchaseCartShipment();ctx.addSelectedPurchaseToCartShipment('seller-one');assert.match(f.alerts.at(-1),/вышла из корзины/);assert.equal(f.saves,0);
  state.purchases.find(r=>r.id==='other').status='received';assert.equal(ctx.purchaseCartShipmentGroups().length,0);
  ctx.openEditPurchaseShipment('seller-two',[{productId:'c',qty:7}]);assert.match(f.alerts.at(-1),/только в поставку из корзины/);
  f.ready=false;const n=f.screens.length;ctx.openSelectedPurchaseCartShipment();assert.equal(f.screens.length,n);
});

test('stale changes, a cart departure or deleted destination block save without writing',()=>{
  for(const mutate of [s=>{s.purchases[0].qty=8;},s=>{s.purchases[0].workflowStageId='paid';},s=>{s.purchases=s.purchases.filter(r=>r.shipmentId!=='seller-one');}]){
    const f=fixture(),{ctx,state}=f;ctx.openSelectedPurchaseCartShipment();ctx.addSelectedPurchaseToCartShipment('seller-one');mutate(state);const before=structuredClone(state);ctx.savePurchaseShipmentEdit('seller-one');
    assert.match(f.alerts.at(-1),/Поставка изменилась/);assert.deepEqual(state,before);assert.equal(f.saves,0);assert.equal(ctx.purchasePlanSelection.has('c'),true);
  }
});

test('validation keeps the draft and selection; saving twice after closing does not add more rows',()=>{
  const f=fixture(),{ctx,draft,state}=f;ctx.openSelectedPurchaseCartShipment();ctx.addSelectedPurchaseToCartShipment('seller-one');draft[2].qty=0;draft[2].query='Новый товар';ctx.savePurchaseShipmentEdit('seller-one');assert.equal(f.saves,0);assert.equal(ctx.purchasePlanSelection.has('c'),true);
  draft[2].qty=7;draft[2].query='';ctx.savePurchaseShipmentEdit('seller-one');const saved=JSON.stringify(state.purchases);ctx.savePurchaseShipmentEdit('seller-one');assert.equal(JSON.stringify(state.purchases),saved);assert.match(f.alerts.at(-1),/Поставка изменилась/);
});

test('an empty cart offers a new manual purchase and the selection button enables with checkboxes',()=>{
  const f=fixture(),{ctx,state}=f;state.purchases.forEach(r=>r.workflowStageId='paid');ctx.openSelectedPurchaseCartShipment();assert.match(f.screens.at(-1),/В корзине пока нет поставок/);ctx.openNewPurchaseFromCartPicker();assert.equal(ctx.window.pendingPurchaseRecommendations[0].productId,'c');assert.equal(ctx.window.pendingPurchaseRecommendations[0].qty,7);assert.equal(f.screens.at(-1),'open:purchase');
  assert.match(fn('updatePurchasePlanBulkControls'),/shipmentBtn\.disabled=count===0/);assert.match(html,/id="purchasePlanShipmentBtn"[^>]*onclick="openSelectedPurchaseCartShipment\(\)"/);
});


test('track and delivery stage save together in the quick editor without changing inventory or another shipment',()=>{
 const f=fixture(),stock=JSON.stringify(f.products),other=JSON.stringify(f.state.purchases.filter(x=>x.shipmentId!=='seller-one'));
 f.ctx.quickEditPurchaseBatch('seller-one');assert.match(f.screens.at(-1),/Статус поставки/);
 f.element('quickPurchaseBatch').value='NEW-TRACK';f.element('quickPurchaseStage').value='delivery_warehouse';f.ctx.saveQuickPurchaseBatch('seller-one');
 const rows=f.state.purchases.filter(x=>x.shipmentId==='seller-one');assert.ok(rows.every(x=>x.batch==='NEW-TRACK'&&x.status==='to_me'&&x.workflowStageId==='delivery_warehouse'&&x.forwarderReceivedAt>0&&x.remainingQty===0));
 assert.equal(f.saves,1);assert.equal(JSON.stringify(f.products),stock);assert.equal(JSON.stringify(f.state.purchases.filter(x=>x.shipmentId!=='seller-one')),other);assert.equal(f.state.movements.length,0);
});
test('the full editor saves a changed track and stage while retaining purchase IDs and amounts',()=>{
 const f=fixture();f.ctx.openEditPurchaseShipment('seller-one');f.element('editPorBatch').value='TRACK-2';f.element('editPorStage').value='paid';f.ctx.savePurchaseShipmentEdit('seller-one');
 const rows=f.state.purchases.filter(x=>x.shipmentId==='seller-one');assert.deepEqual(rows.map(x=>x.id).sort(),['old-a','old-b']);assert.ok(rows.every(x=>x.batch==='TRACK-2'&&x.workflowStageId==='paid'&&x.status==='to_forwarder'&&x.workflowStageAt>123));assert.equal(rows.reduce((n,x)=>n+x.buyTotal,0),900);assert.equal(f.saves,1);
});
test('invalid or stale stage selection cannot partially save a changed track',()=>{
 for(const stale of [false,true]){
  const f=fixture();f.ctx.quickEditPurchaseBatch('seller-one');f.element('quickPurchaseBatch').value='UNSAVED';f.element('quickPurchaseStage').value=stale?'paid':'missing';
  if(stale)f.state.purchases.find(x=>x.id==='old-a').workflowStageId='paid';const before=JSON.stringify(f.state);f.ctx.saveQuickPurchaseBatch('seller-one');assert.equal(JSON.stringify(f.state),before);assert.equal(f.saves,0);assert.ok(f.alerts.length);
 }
});
test('arrival selection saves the track then opens the existing receipt confirmation without posting inventory',()=>{
 const f=fixture();for(const x of f.state.purchases.filter(x=>x.shipmentId==='seller-one')){x.status='to_me';x.workflowStageId='delivery_warehouse';}
 f.ctx.quickEditPurchaseBatch('seller-one');f.element('quickPurchaseBatch').value='ARRIVAL-TRACK';f.element('quickPurchaseStage').value='arrived';f.ctx.saveQuickPurchaseBatch('seller-one');
 assert.deepEqual(f.receipts,['seller-one']);assert.equal(f.saves,1);assert.ok(f.state.purchases.filter(x=>x.shipmentId==='seller-one').every(x=>x.status==='to_me'&&x.batch==='ARRIVAL-TRACK'&&x.remainingQty===0));assert.equal(f.state.movements.length,0);
});
test('the editor cannot skip the delivery phase or roll back a shipment already received into sale',()=>{
 for(const status of ['to_forwarder','received','at_warehouse']){
  const f=fixture();for(const x of f.state.purchases.filter(x=>x.shipmentId==='seller-one'))x.status=status;
  f.ctx.quickEditPurchaseBatch('seller-one');f.element('quickPurchaseBatch').value='UNSAVED';f.element('quickPurchaseStage').dataset={};f.element('quickPurchaseStage').value=status==='to_forwarder'?'arrived':'paid';const before=JSON.stringify(f.state);f.ctx.saveQuickPurchaseBatch('seller-one');assert.equal(JSON.stringify(f.state),before);assert.equal(f.saves,0);assert.equal(f.receipts.length,0);
 }
});
