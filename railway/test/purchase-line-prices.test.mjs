import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
const fn=name=>{const a=html.indexOf('function '+name+'('),b=html.indexOf('\nfunction ',a+1);assert.ok(a>=0);return html.slice(a,b<0?undefined:b)};
function fixture(edit=false){
 const products=[{id:'a',name:'Товар А',stock:5},{id:'b',name:'Товар Б',stock:6}],state={products,purchases:[],movements:[]},fields=new Map(),alerts=[],lines=[];let saves=0,n=0;
 const field=id=>{if(!fields.has(id))fields.set(id,{id,value:'',innerHTML:'',dataset:{}});return fields.get(id)};
 for(const prefix of ['por','editPor']){field(prefix+'Date').value='2026-10-29';field(prefix+'Batch').value='Один продавец';field(prefix+'Delivery').value='100';field(prefix+'BuyTotal').value='99999'}
 function line(productId,qty,price,mode='unit'){
  const cls=edit?'edit-purchase':'purchase',nodes=new Map();
  const row={dataset:{priceMode:mode},classList:{contains:s=>edit&&s==='edit-purchase-item'},querySelector(selector){for(const s of selector.split(','))if(nodes.has(s))return nodes.get(s);return null},closest(){return row}};
  const input={value:String(price)},select={value:mode,closest:()=>row};nodes.set('.purchase-price',input);nodes.set('.purchase-price-mode',select);nodes.set('.'+cls+'-qty',{value:String(qty)});nodes.set('.'+cls+'-q',{value:''});nodes.set('.'+cls+'-product',{value:productId,selectedOptions:[{textContent:products.find(p=>p.id===productId)?.name||''}]});nodes.set('.'+cls+'-row-total',{textContent:''});nodes.set('.'+cls+'-unit-hint',{textContent:''});lines.push(row);return {row,nodes,input,select,qty:nodes.get('.'+cls+'-qty')};
 }
 const ctx={state,window:{},document:{getElementById:field,querySelectorAll:s=>s===(edit?'.edit-purchase-item':'.purchase-item')?lines:[]},alert:s=>alerts.push(String(s)),fmt:x=>String(x),normalizeName:s=>String(s).toLowerCase(),prod:id=>products.find(p=>p.id===id),id:()=>String(++n),localDateStart:()=>1793203200000,updatePurchaseAverageEstimates(){},schedulePurchaseCalculator(){ctx.updatePurchaseOrderCalculator()},purchaseWorkflow:()=>[{id:'paid'}],purchaseWorkflowStage:()=> 'paid',purchaseInboundQty:id=>state.purchases.filter(p=>p.productId===id).reduce((s,p)=>s+p.qty,0),productNameById:id=>products.find(p=>p.id===id)?.name,save(){saves++},closeModal(){},render(){},purchaseCartImportSaveContext:()=>null,purchaseShipmentRows:key=>state.purchases.filter(p=>p.shipmentId===key),purchaseStatus:p=>p.status,purchaseEditStagePlan:()=>null,applyPurchaseEditStage(){},rememberPurchaseDeletes(){},Date};
 vm.createContext(ctx);for(const name of ['purchaseTotalPrefix','markPurchaseTotalDraft','cancelPurchaseGrandTotal','applyPurchaseGrandTotal','readPurchaseRowPrice','purchaseDraftRows','editPurchaseDraftRows','purchaseDraftCosts','changePurchasePriceMode','updatePurchaseOrderCalculator','updateEditPurchaseCalculator','createPurchaseOrder','savePurchaseShipmentEdit','spreadCorrectPurchaseBuyTotal'])vm.runInContext(fn(name),ctx);
 return {ctx,state,field,alerts,line,lines,get saves(){return saves}};
}
test('one purchase keeps different unit/line prices, a stale total cannot override them, and it changes no stock',()=>{
 const f=fixture();f.line('a',3,100);f.line('b',2,900,'total');const before=structuredClone(f.state.products);
 f.ctx.updatePurchaseOrderCalculator();assert.equal(f.field('porBuyTotal').value,'1200');f.field('porBuyTotal').value='99999';f.ctx.createPurchaseOrder();
 assert.equal(f.saves,1);assert.equal(f.alerts.length,1);const rows=f.state.purchases.sort((a,b)=>a.productId.localeCompare(b.productId));
 assert.deepEqual(rows.map(r=>r.buyTotal),[300,900]);assert.deepEqual(rows.map(r=>r.unitCost),[100,450]);assert.deepEqual(rows.map(r=>r.delivery),[60,40]);assert.ok(rows.every(r=>r.shipmentPurchaseTotal===1200));assert.equal(new Set(rows.map(r=>r.shipmentId)).size,1);assert.deepEqual(f.state.products,before);assert.deepEqual(f.state.movements,[]);
});
test('changing quantity respects unit versus total authority and switching modes preserves line money',()=>{
 const f=fixture(),a=f.line('a',3,100),b=f.line('b',2,900,'total');a.qty.value='5';b.qty.value='3';f.ctx.updatePurchaseOrderCalculator();assert.equal(f.field('porBuyTotal').value,'1400');
 a.select.value='total';f.ctx.changePurchasePriceMode(a.select);assert.equal(a.input.value,'500');a.qty.value='10';f.ctx.updatePurchaseOrderCalculator();assert.equal(f.field('porBuyTotal').value,'1400');a.select.value='unit';f.ctx.changePurchasePriceMode(a.select);assert.equal(a.input.value,'50');assert.equal(b.input.value,'900');
});
test('editing saves each line separately and preserves purchase identity and existing stock',()=>{
 const f=fixture(true);f.state.purchases=[{id:'old-a',productId:'a',qty:3,shipmentId:'s',buyTotal:300,unitCost:100,status:'to_forwarder'},{id:'old-b',productId:'b',qty:2,shipmentId:'s',buyTotal:900,unitCost:450,status:'to_forwarder'}];f.line('a',3,330,'total');f.line('b',2,500);f.ctx.updateEditPurchaseCalculator();assert.equal(f.field('editPorBuyTotal').value,'1330');f.ctx.savePurchaseShipmentEdit('s');
 const rows=f.state.purchases.sort((a,b)=>a.productId.localeCompare(b.productId));assert.deepEqual(rows.map(r=>r.id),['old-a','old-b']);assert.deepEqual(rows.map(r=>r.buyTotal),[330,1000]);assert.deepEqual(rows.map(r=>r.unitCost),[110,500]);assert.ok(rows.every(r=>r.shipmentPurchaseTotal===1330));assert.deepEqual(f.state.products.map(p=>p.stock),[5,6]);assert.equal(f.saves,1);
});
test('invalid negative, overflow prices and fractional quantities cannot partially save',()=>{
 for(const [qty,price] of [[1,-2],[1,'Infinity'],[2,Number.MAX_VALUE],[1.5,100]]){const f=fixture();f.line('a',1,100);f.line('b',qty,price);f.ctx.createPurchaseOrder();assert.equal(f.saves,0);assert.equal(f.state.purchases.length,0);assert.ok(f.alerts.length)}
});
test('received correction updates the sum without overwriting individual prices',()=>{
 const f=fixture(),unitA={value:'100'},unitB={value:'450'},qA={value:'3'},qB={value:'2'};
 f.ctx.document.querySelectorAll=s=>s==='.correct-purchase-row'?[{querySelector:s=>s==='.correct-purchase-qty'?qA:unitA},{querySelector:s=>s==='.correct-purchase-qty'?qB:unitB}]:[];
 f.ctx.spreadCorrectPurchaseBuyTotal();assert.equal(f.field('correctPorBuyTotal').value,'1200');qA.value='5';f.ctx.spreadCorrectPurchaseBuyTotal();assert.equal(f.field('correctPorBuyTotal').value,'1400');assert.equal(unitA.value,'100');assert.equal(unitB.value,'450');
});
test('draft PDF uses the same line totals as saving instead of redistributing a grand total',()=>{
 const f=fixture();f.line('a',3,100);f.line('b',2,900,'total');const script=readFileSync(new URL('../../purchase-pdf-v1.js',import.meta.url),'utf8').replace('window.exportPurchasePdf=','window.purchasePdfInput=purchasePdfInput;window.exportPurchasePdf=');vm.runInContext(script,f.ctx);
 const out=f.ctx.window.purchasePdfInput('new');assert.deepEqual(Array.from(out.items,r=>r.buyTotal),[300,900]);assert.equal(out.delivery,100);
});
test('opening an existing shipment preloads each actual line sum without making its prices equal',()=>{
 const f=fixture(true),opened=[];f.state.purchases=[{id:'old-a',productId:'a',qty:3,shipmentId:'s',buyTotal:300,unitCost:100,status:'to_forwarder'},{id:'old-b',productId:'b',qty:2,shipmentId:'s',buyTotal:900,unitCost:450,status:'to_forwarder'}];
 Object.assign(f.ctx,{localDateInputValue:()=> '2026-10-29',purchaseShipmentTotals:()=>({buy:1200,delivery:100}),esc:String,purchaseEditStageField:()=>'',showSheet(){},addEditPurchaseItem:(...args)=>opened.push(args),updateEditPurchaseCalculator(){}});vm.runInContext(fn('openEditPurchaseShipment'),f.ctx);f.ctx.openEditPurchaseShipment('s');assert.deepEqual(opened,[['a',3,300],['b',2,900]]);
});

test('manual grand total stays pending through recalculation, blocks saving, and applies to color quantities',()=>{
 const f=fixture(),a=f.line('a',100,70),b=f.line('b',150,80),total=f.field('porBuyTotal');total.value='25000';f.ctx.markPurchaseTotalDraft(total);a.qty.value='100';f.ctx.updatePurchaseOrderCalculator();assert.equal(total.value,'25000');f.ctx.createPurchaseOrder();assert.equal(f.saves,0);assert.equal(f.state.purchases.length,0);assert.match(f.alerts.at(-1),/Общая сумма ещё не применена/);
 f.ctx.applyPurchaseGrandTotal('new');assert.equal(a.input.value,'10000.00');assert.equal(b.input.value,'15000.00');assert.equal(a.select.value,'total');assert.equal(total.dataset.pendingTotal,undefined);assert.equal(total.value,'25000');f.ctx.createPurchaseOrder();assert.equal(f.saves,1);assert.deepEqual(f.state.purchases.map(r=>r.unitCost),[100,100]);
});
test('cancelling a manual total restores the sum without touching independent product prices',()=>{
 const f=fixture(),a=f.line('a',3,100),b=f.line('b',2,900,'total'),total=f.field('porBuyTotal');total.value='7000';f.ctx.markPurchaseTotalDraft(total);f.ctx.cancelPurchaseGrandTotal('new');assert.equal(total.value,'1200');assert.equal(a.input.value,'100');assert.equal(b.input.value,'900');assert.equal(f.field('porBuyTotalActions').hidden,true);
});
test('grand total allocation conserves the last cent, and subsequent row edits flow back to the total',()=>{
 const f=fixture(),a=f.line('a',1,100),b=f.line('b',2,900,'total'),total=f.field('porBuyTotal');total.value='0.01';f.ctx.markPurchaseTotalDraft(total);f.ctx.applyPurchaseGrandTotal('new');assert.equal(Number(a.input.value)+Number(b.input.value),0.01);assert.equal(total.value,'0.01');b.input.value='25';f.ctx.updatePurchaseOrderCalculator();assert.equal(total.value,'25');
});
test('editing a saved shipment can apply a common amount while retaining IDs and stock',()=>{
 const f=fixture(true);f.state.purchases=[{id:'old-a',productId:'a',qty:3,shipmentId:'s',status:'to_forwarder'},{id:'old-b',productId:'b',qty:2,shipmentId:'s',status:'to_forwarder'}];f.line('a',3,100);f.line('b',2,900,'total');const total=f.field('editPorBuyTotal');total.value='900';f.ctx.markPurchaseTotalDraft(total);f.ctx.applyPurchaseGrandTotal('edit');f.ctx.savePurchaseShipmentEdit('s');const rows=f.state.purchases.sort((a,b)=>a.productId.localeCompare(b.productId));assert.deepEqual(rows.map(r=>r.buyTotal),[540,360]);assert.deepEqual(rows.map(r=>r.id),['old-a','old-b']);assert.deepEqual(f.state.products.map(p=>p.stock),[5,6]);
});
test('received correction supports explicit common allocation instead of changing prices implicitly',()=>{
 const f=fixture(),a={value:'100'},b={value:'450'},qA={value:'3'},qB={value:'2'};
 f.ctx.document.querySelectorAll=s=>s==='.correct-purchase-row'?[{querySelector:s=>s.includes('qty')?qA:a},{querySelector:s=>s.includes('qty')?qB:b}]:[];
 const total=f.field('correctPorBuyTotal');total.value='1500';f.ctx.markPurchaseTotalDraft(total);f.ctx.spreadCorrectPurchaseBuyTotal();assert.equal(total.value,'1500');assert.equal(a.value,'100');f.ctx.applyPurchaseGrandTotal('correct');assert.equal(a.value,'300');assert.equal(b.value,'300');assert.equal(total.value,'1500');
});
test('PDF refuses an unapplied total and invalid allocation leaves entered row prices untouched',()=>{
 const f=fixture(),a=f.line('a',3,100),b=f.line('b',2,900,'total'),total=f.field('porBuyTotal');total.value='2000';f.ctx.markPurchaseTotalDraft(total);const script=readFileSync(new URL('../../purchase-pdf-v1.js',import.meta.url),'utf8').replace('window.exportPurchasePdf=','window.purchasePdfInput=purchasePdfInput;window.exportPurchasePdf=');vm.runInContext(script,f.ctx);assert.throws(()=>f.ctx.window.purchasePdfInput('new'),/распределите общую сумму/);
 total.value='-1';f.ctx.applyPurchaseGrandTotal('new');assert.equal(a.input.value,'100');assert.equal(b.input.value,'900');assert.equal(total.dataset.pendingTotal,'1');assert.equal(f.saves,0);
});
