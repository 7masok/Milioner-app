import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');

function extract(name,next){
  const start=html.indexOf('function '+name+'(');
  const end=html.indexOf('function '+next+'(',start+1);
  assert.ok(start>=0&&end>start,'function '+name+' not found');
  return html.slice(start,end);
}

test('new purchase accepts a manual grand total explicitly and never auto-fills from recommendations',()=>{
  const fn=extract('purchaseForm','lightweightPurchaseOptions');
  assert.doesNotMatch(fn,/suggestedTotal/);
  assert.match(fn,/id="porBuyTotal"[^>]*oninput="markPurchaseTotalDraft/);assert.doesNotMatch(fn,/id="porBuyTotal"[^>]*readonly/);
  assert.match(fn,/Распределить по количеству/);assert.match(fn,/Отменить общую сумму/);
  assert.doesNotMatch(fn,/распределится автоматически по количеству/);
  assert.doesNotMatch(fn,/value="\$\{hint\.estimatedCost/);
});

test('per-product historical estimate remains visible below the product',()=>{
  const start=html.indexOf('function purchaseAverageEstimate(');
  const end=html.indexOf('function updatePurchaseAverageEstimates(',start);
  assert.ok(start>=0&&end>start);
  const fn=html.slice(start,end);
  assert.match(fn,/Ориентировочно без доставки/);
  assert.match(fn,/средняя закупочная цена/);
});


function runReceivedCorrection({remainingQty=20,newQty=0,addReplacement=true,status='received',warehouseWrittenOffQty=0,reference=false,keepOther=false,delivery=0}={}){
  const oldProduct={id:'black',name:'Чёрный',stock:20};
  const replacement={id:'blue',name:'Синий',stock:0};
  const products=new Map([[oldProduct.id,oldProduct],[replacement.id,replacement]]);
  const state={purchases:[{
    id:'old-row',shipmentId:'ship-1',status,warehouseWrittenOffQty,productId:'black',
    qty:20,remainingQty,buyTotal:200,unitCost:10,delivery:0,landedUnitCost:10,
    batch:'Поставка',orderedAt:1,receivedAt:2,date:1
  }]};
  state.sales=reference?[{fifoLots:[{purchaseId:'old-row',qty:2}]}]:[];
  const existingEl={
    dataset:{id:'old-row'},
    querySelector(selector){
      if(selector==='.correct-purchase-qty')return {value:String(newQty)};
      if(selector==='.correct-purchase-unit')return {value:'10'};
      return null;
    }
  };
  const replacementEl={
    querySelector(selector){
      if(selector==='.correct-purchase-product')return {value:'blue'};
      if(selector==='.correct-purchase-q')return {value:''};
      if(selector==='.correct-purchase-qty-new')return {value:'20'};
      if(selector==='.correct-purchase-unit-new')return {value:'10'};
      return null;
    }
  };
  if(keepOther)state.purchases.push({id:'keep-row',shipmentId:'ship-1',status:'at_warehouse',productId:'blue',qty:20,remainingQty:0,unitCost:10,buyTotal:200,delivery:0});
  const keepEl={dataset:{id:'keep-row'},querySelector:s=>({value:s==='.correct-purchase-qty'?'20':'10'})};
  const fields={
    correctPorDate:{value:'2026-10-01'},
    correctPorBatch:{value:'Поставка'},
    correctPorDelivery:{value:String(delivery)}
  };
  const alerts=[],movements=[];
  const context={
    state,
    document:{
      querySelectorAll(selector){
        if(selector==='.correct-purchase-row')return keepOther?[existingEl,keepEl]:[existingEl];
        if(selector==='.correct-purchase-new-row')return addReplacement?[replacementEl]:[];
        return [];
      },
      getElementById(id){return fields[id]||null}
    },
    purchaseShipmentRows(){
      return state.purchases.filter(row=>String(row.shipmentId||row.id)==='ship-1');
    },
    purchaseStatus(row){return String(row.status||'received')},
    productNameById(id,fallback='—'){return products.get(String(id))?.name||fallback},
    prod(id){return products.get(String(id))||null},
    log(type,productId,qty,note){movements.push({type,productId,qty,note})},
    id(){return 'replacement-row'},
    localDateStart(){return 1},
    refreshProductAverageCost(){},
    save(){},
    closeModal(){},
    render(){},
    alert(message){alerts.push(String(message))},
    fmt(value){return String(value)}
  };
  vm.createContext(context);
  vm.runInContext(extract('purchaseCorrectionMinimumQty','removeCorrectPurchaseItem'),context);
  vm.runInContext(extract('saveCorrectReceivedPurchaseShipment','addEditPurchaseItem'),context);
  vm.runInContext("saveCorrectReceivedPurchaseShipment('ship-1')",context);
  return {state,oldProduct,replacement,alerts,movements};
}

test('received purchase correction can replace a completely unsold color with another color',()=>{
  const result=runReceivedCorrection();
  assert.equal(result.state.purchases.some(row=>row.id==='old-row'),false);
  assert.equal(result.state.purchases.some(row=>row.productId==='blue'&&row.qty===20),true);
  assert.equal(result.oldProduct.stock,0);
  assert.equal(result.replacement.stock,20);
  assert.equal(result.alerts.some(message=>message.includes('нельзя указать меньше')),false);
  assert.ok(result.alerts.some(message=>message.includes('Поставка исправлена')));
  assert.ok(result.movements.some(row=>row.productId==='black'&&row.qty===-20));
  assert.ok(result.movements.some(row=>row.productId==='blue'&&row.qty===20));
});

test('received purchase correction still cannot go below units already consumed from the FIFO lot',()=>{
  const result=runReceivedCorrection({remainingQty:17,newQty:2,addReplacement:false});
  assert.ok(result.alerts.some(message=>message.includes('нельзя указать меньше 3 шт.')));
  assert.equal(result.state.purchases[0].qty,20);
  assert.equal(result.oldProduct.stock,20);
});


test('a warehouse-only mistaken item can be removed without changing sale stock or the product catalog',()=>{
 const r=runReceivedCorrection({status:'at_warehouse'});
 assert.equal(r.state.purchases.some(x=>x.id==='old-row'),false);
 assert.equal(r.oldProduct.stock,20);
 assert.ok(r.movements.some(x=>x.productId==='black'&&x.qty===0&&x.note.includes('ошибочно добавленный')));
 assert.ok(r.state.purchases.some(x=>x.productId==='blue'&&x.qty===20));
});
for(const opts of [{status:'at_warehouse',warehouseWrittenOffQty:3},{status:'at_warehouse',reference:true}])test('used warehouse lot cannot disappear: '+JSON.stringify(opts),()=>{
 const r=runReceivedCorrection(opts);assert.ok(r.state.purchases.some(x=>x.id==='old-row'&&x.qty===20));assert.equal(r.oldProduct.stock,20);assert.equal(r.movements.length,0);assert.equal(r.replacement.stock,0);
});
test('the last line cannot be removed through correction and requires explicit whole-shipment deletion',()=>{
 const r=runReceivedCorrection({status:'at_warehouse',addReplacement:false});assert.equal(r.state.purchases[0].qty,20);assert.equal(r.movements.length,0);assert.ok(r.alerts.some(x=>x.includes('хотя бы один товар')));
});

test('removing only one warehouse line keeps its neighbour and reallocates the entered delivery total',()=>{
 const r=runReceivedCorrection({status:'at_warehouse',addReplacement:false,keepOther:true,delivery:120});
 assert.equal(r.state.purchases.length,1);const kept=r.state.purchases[0];assert.equal(kept.id,'keep-row');assert.equal(kept.qty,20);assert.equal(kept.buyTotal,200);assert.equal(kept.delivery,120);assert.equal(kept.landedUnitCost,16);assert.equal(kept.shipmentPurchaseTotal,200);assert.equal(kept.shipmentDeliveryTotal,120);assert.equal(r.oldProduct.stock,20);assert.equal(r.replacement.stock,0);
});
