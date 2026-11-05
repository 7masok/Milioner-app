import test from 'node:test';
import assert from 'node:assert/strict';
import {accountWbSupply,resolveWbSupplyProduct,supplyKey} from '../src/wb3-supply-accounting.js';
import {enableSupplyState,mergeSupplyList} from '../src/wb3-supply-sync.js';
import {inventory,cancelDraft,draftGroups,transferViolation} from '../src/fbo-warehouse/core.js';
import {stockLedgerViolation} from '../src/warehouse-ledger.js';
const state=()=>({products:[{id:'p',name:'Товар',stock:10,cost:100,wb:'item'}],purchases:[{id:'lot',productId:'p',status:'received',qty:10,remainingQty:10,buyTotal:800,delivery:200,date:1}],reservations:[],movements:[],settings:{}});
const goods=(qty=3)=>[{barcode:'123',vendorCode:'item',nmID:7,quantity:qty,acceptedQuantity:0,readyForSaleQuantity:0}];
const supply=(statusID=2)=>({preorderID:123,supplyID:null,statusID,createDate:'2026-11-04T18:00:00Z'});
test('preparation including permission to ship only reserves; departure consumes once with FIFO',()=>{
 const a=state(),r=accountWbSupply(a,supply(3),goods(),1000);assert.equal(a.reservations.length,0);assert.equal(r.state.products[0].stock,10);assert.equal(inventory(r.state).get('p').sale,7);assert.equal(r.state.movements.length,0);
 const sent=accountWbSupply(r.state,{...supply(6),supplyID:456},goods(),2000);assert.equal(sent.state.products[0].stock,7);assert.equal(sent.state.purchases[0].remainingQty,7);assert.equal(sent.state.movements[0].type,'FBO WB3');assert.equal(sent.state.movements[0].fifoLots[0].unitCost,100);assert.equal(Object.values(sent.state.settings.wb3FboTransfers)[0].unitCost,100);assert.equal(stockLedgerViolation(r.state,sent.state),null);
 const repeat=accountWbSupply(sent.state,supply(6),goods(),3000);assert.equal(repeat.changed,true); // supplyID observation changed, stock did not
 assert.equal(repeat.state.products[0].stock,7);assert.equal(repeat.state.movements.length,1);assert.equal(repeat.state.settings.ozonFboTransfers,undefined);
 const stable=accountWbSupply(repeat.state,supply(6),goods(),4000);assert.equal(stable.changed,false);
});
test('warehouse lots split without losing purchase or delivery cost',()=>{
 const a=state();a.products[0].stock=0;a.purchases=[{id:'wh',productId:'p',status:'at_warehouse',qty:10,buyTotal:800,delivery:200}];
 const r=accountWbSupply(a,supply(4),goods(),2000);assert.equal(r.state.products[0].stock,0);assert.equal(r.state.purchases.reduce((n,p)=>n+p.qty,0),10);assert.equal(r.state.purchases.reduce((n,p)=>n+p.buyTotal+p.delivery,0),1000);assert.equal(Object.values(r.state.settings.wb3FboTransfers)[0].unitCost,100);assert.equal(stockLedgerViolation(a,r.state),null);
});
test('incomplete mapping and insufficient stock leave the whole supply untouched',()=>{
 const a=state(),original=structuredClone(a);assert.throws(()=>accountWbSupply(a,supply(),[...goods(),{barcode:'unknown',quantity:1,vendorCode:'missing'}]),/привязки/);assert.deepEqual(a,original);
 assert.throws(()=>accountWbSupply(a,supply(),goods(20)),/Недостаточно/);assert.deepEqual(a,original);
});
test('composition edits replace reservation atomically; rejected edit keeps the old one',()=>{
 const a=accountWbSupply(state(),supply(),goods()).state;
 const b=accountWbSupply(a,supply(),goods(5)).state;assert.equal(inventory(b).get('p').sale,5);assert.equal(b.reservations.filter(r=>r.active).length,1);
 assert.throws(()=>accountWbSupply(b,supply(),goods(50)),/Недостаточно/);assert.equal(inventory(b).get('p').sale,5);
});
test('manual release remains released; missing or unknown statuses cannot consume stock',()=>{
 const a=accountWbSupply(state(),supply(),goods()).state;cancelDraft(a,draftGroups(a)[0].id);
 assert.equal(accountWbSupply(a,supply(6),goods()).status,'cancelled');assert.equal(a.products[0].stock,10);
 assert.equal(accountWbSupply(state(),supply(9),goods()).changed,false);
 assert.equal(supplyKey({supplyID:456}),'');
});
test('acceptance shortfall does not return or debit own stock again',()=>{
 const a=accountWbSupply(state(),supply(6),goods()).state;
 const b=accountWbSupply(a,supply(5),[{...goods()[0],acceptedQuantity:2,readyForSaleQuantity:1}]).state;
 assert.equal(b.products[0].stock,7);assert.equal(b.movements.length,1);assert.equal(b.settings.wb3SupplyReceipts['preorder:123'].lines[0].accepted,2);
 const tamper=structuredClone(b);delete tamper.settings.wb3FboTransfers;assert.equal(transferViolation(b,tamper).reason,'fbo-transfer-history-protected');
});
test('exact barcode selects size, shared articles and conflicting barcodes are blocked',()=>{
 const a=state();a.products=[{id:'s1',kind:'variant',wb:'item',wbVariant:{nmId:7,barcode:'one'}},{id:'s2',kind:'variant',wb:'item',wbVariant:{nmId:7,barcode:'two'}}];
 assert.equal(resolveWbSupplyProduct(a,{nmID:7,barcode:'two',vendorCode:'item'}).id,'s2');assert.throws(()=>resolveWbSupplyProduct(a,{nmID:7,barcode:'unknown',vendorCode:'item'}));
 a.products.push({...a.products[1],id:'s3'});assert.throws(()=>resolveWbSupplyProduct(a,{nmID:7,barcode:'two'}),/несколько/);
});
test('activation baselines history; delayed historical rows are excluded; known preparation survives supplyID assignment',()=>{
 const now=Date.parse('2026-11-04T17:00:00Z');let a=enableSupplyState({listAt:now,supplies:[supply(2),{...supply(6),preorderID:456}]},now);
 assert.deepEqual(a.excluded,['preorder:456']);assert.throws(()=>enableSupplyState({listAt:now-1800001},now));
 a=mergeSupplyList(a,[{...supply(6),supplyID:999},{...supply(5),preorderID:789,createDate:'2026-08-01T00:00:00Z'}],now+1000);
 assert.ok(!a.excluded.includes('preorder:123'));assert.ok(a.excluded.includes('preorder:789'));
});
test('re-enabling does not strand a previously tracked reserve when shipment happened during pause',()=>{
 const now=Date.parse('2026-11-04T17:00:00Z');const s=enableSupplyState({listAt:now,enabled:false,observedPreparing:['preorder:123'],supplies:[supply(6)]},now);
 assert.ok(!s.excluded.includes('preorder:123'));assert.ok(s.observedPreparing.includes('preorder:123'));
});
test('a current-day shipment is not incorrectly treated as old history on activation',()=>{
 const now=Date.parse('2026-11-04T18:00:00Z');const s=enableSupplyState({listAt:now,supplies:[{...supply(6),factDate:'2026-11-04T17:00:00Z'},{...supply(5),preorderID:999,factDate:'2026-08-01T00:00:00Z'}]},now);
 assert.ok(!s.excluded.includes('preorder:123'));assert.ok(s.excluded.includes('preorder:999'));
 const next=mergeSupplyList({...s,observedPreparing:[]},[{...supply(6),preorderID:456,createDate:'2026-10-01T00:00:00Z',factDate:'2026-11-04T18:10:00Z'}],now+900000);
 assert.ok(!next.excluded.includes('preorder:456'));
});

test('saved nmID and characteristic link survives missing duplicate barcode metadata, with exact catalog evidence',async()=>{
 const {enrichSupplyGoods}=await import('../src/wb3-supply-view.js');
 const a=state();a.products=[{id:'pink',name:'ВФ розовый',stock:0,cost:211.35,wb:'ВФ розовый',wbIdentity:{nmId:'1187433677',chrtId:1749120906,vendorCode:'ВФ розовый'}}];a.purchases=[{id:'pink-lot',productId:'pink',status:'at_warehouse',qty:50,buyTotal:9495,delivery:1072.565}];
 const sync={catalog:[{nmId:'1187433677',vendorCode:'ВФ розовый',sizes:[{chrtId:1749120906,size:'A',barcodes:['2052587286559']}]}]};
 const rows=enrichSupplyGoods(sync,'preorder:123',[{barcode:'2052587286559',nmID:1187433677,techSize:'A',vendorCode:'ВФ розовый',quantity:50}]);
 assert.equal(resolveWbSupplyProduct(a,rows[0]).id,'pink');
 const sent=accountWbSupply(a,supply(6),rows,2000);assert.equal(inventory(sent.state).get('pink').warehouse,0);assert.equal(sent.state.products[0].stock,0);assert.equal(Object.values(sent.state.settings.wb3FboTransfers)[0].qty,50);assert.equal(stockLedgerViolation(a,sent.state),null);
 const repeat=accountWbSupply(sent.state,supply(6),rows,3000);assert.equal(repeat.changed,false);assert.equal(sent.state.movements.length,2);
 const wrong=structuredClone(sync);wrong.catalog[0].sizes[0].chrtId=999;assert.throws(()=>resolveWbSupplyProduct(a,enrichSupplyGoods(wrong,'preorder:123',rows)[0]),/привязки/);
 const renamed=structuredClone(sync);renamed.catalog[0].vendorCode='renamed elsewhere';assert.throws(()=>resolveWbSupplyProduct(a,enrichSupplyGoods(renamed,'preorder:123',rows)[0]),/привязки/);
});
