import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileWbPrices,reconcileOzonPrices} from '../src/report-price-reconciliation.js';
const wb=(id,buyer,seller,extra={})=>({market:'WB2',rrd_id:id,qty:1,operation:'Продажа',retail_amount:buyer,raw_json:{currency:'KZT',srid:id,retailPriceWithDisc:seller,spp:22.78},...extra});
const order=(id,price,extra={})=>({market:'WB2',qty:1,total_price:price,raw_json:{order:{rid:id,convertedCurrencyCode:398}},...extra});
test('WB2 compares two prices of the exact same unit even when its order was created a month earlier',()=>{
 const f=wb('unit',1366.35,1769.45),o=order('unit',1366.35,{creation_date:Date.parse('2026-09-01')});
 const result=reconcileWbPrices('WB2',[{...f,sale_date:Date.parse('2026-10-02')}],[o]);
 assert.equal(result.matched,1);assert.equal(result.matchedOrderBuyer,1366.35);assert.equal(result.matchedBuyoutBuyer,1366.35);assert.equal(result.matchedBuyoutSeller,1769.45);assert.ok(Math.abs(result.discountDifference-403.1)<.0001);
});
test('WB identities stay separate across cabinets and reject duplicate or shared-cart matches',()=>{
 const finance=[wb('same',100,120),wb('unknown',200,250),wb('multiple',100,120),wb('multiple2',100,120,{raw_json:{currency:'KZT',srid:'multiple',retailPriceWithDisc:120}})];
 const result=reconcileWbPrices('WB2',finance,[order('same',100,{market:'WB'}),order('same',100),order('multiple',100)]);
 assert.equal(result.matched,1);assert.equal(result.unmatched,1);assert.equal(result.ambiguous,1);
 const noGuess=reconcileWbPrices('WB2',[wb('cart',100,120)],[{...order('cart',100),raw_json:{order:{orderUid:'cart',convertedCurrencyCode:398}}}]);assert.equal(noGuess.matched,0);
});
test('WB return signs and monetary currencies are explicit; a duplicate report row is not another sale',()=>{
 const a=wb('a',100,120),ret=wb('r',100,120,{operation:'Возврат'}),foreign=wb('rub',100,120,{raw_json:{currency:'RUB',srid:'rub',retailPriceWithDisc:120}});
 const r=reconcileWbPrices('WB2',[a,a,ret,foreign],[]);assert.equal(r.buyer,0);assert.equal(r.seller,0);assert.equal(r.saleQty,1);assert.equal(r.returnQty,1);assert.equal(r.excludedCurrency,1);
 const unknown=reconcileWbPrices('WB2',[wb('unknown',100,null)]);assert.equal(unknown.discountDifference,null);assert.equal(unknown.unknownSeller,1);
});
const START=Date.parse('2026-10-01'),END=Date.parse('2026-11-01');
const post=(n,price=100,sku='sku')=>({posting_number:n,created_at:'2026-09-01',products:[{sku,quantity:1,price,currency_code:'KZT'}]});
const sale=(id,n,amount=100,sku='sku')=>({operation_id:id,operation_date:'2026-10-01T12:00:00Z',operation_type_name:'Продажа',accruals_for_sale:amount,amount,currency_code:'KZT',unit_number:n,posting:{posting_number:''},items:[{sku}]});
test('Ozon links by account, exact posting and SKU rather than the financial month or product name',()=>{
 const a={postings:{rows:[post('1-1-1')]},finance:{rows:[sale('s','1-1-1'),sale('missing','2-2-2',250),sale('return','1-1-1',-100)]}};
 const b={postings:{rows:[post('2-2-2',250)]},finance:{rows:[]}};
 const r=reconcileOzonPrices([a,b],START,END);assert.equal(r.matched,1);assert.equal(r.samePrice,1);assert.equal(r.missing,1);assert.equal(r.missingAmount,250);assert.equal(r.sales,2);assert.equal(r.returns,1);assert.equal(r.seller,250);
});
test('Ozon repeated positive charges and duplicate SKU lines are not silently matched to one price',()=>{
 const a={postings:{rows:[post('1-1-1')]},finance:{rows:[sale('s','1-1-1'),sale('s2','1-1-1')]}};
 assert.equal(reconcileOzonPrices([a],START,END).ambiguous,1);
 a.finance.rows=[sale('s','1-1-1'),sale('s','1-1-1')];assert.equal(reconcileOzonPrices([a],START,END).samePrice,1);
 a.postings.rows.push(post('1-1-1'));assert.equal(reconcileOzonPrices([a],START,END).ambiguous,1);
});
