import test from 'node:test';
import assert from 'node:assert/strict';
import {allocateWbOrderAdvertising,wbOrderDay} from '../src/wb-order-advertising.js';

const order=(srid,extra={})=>({market:'WB',productId:'a',srid,orderDay:'2026-10-10',qty:1,source:'order_cache',cacheKey:srid,...extra});
const ad=(amount,extra={})=>({market:'WB',productId:'a',day:'2026-10-10',currency:'KZT',amount,...extra});
test('5000 is shared by 25 placed units including cancelled and not-yet-received orders',()=>{
 const orders=Array.from({length:25},(_,i)=>order('uid-'+i,{status:i%2?'cancelled':'new'})),finance=[{productId:'a',srid:'uid-0',shkId:'123',nmId:'100',saleQty:1,date:Date.parse('2026-10-12')}];
 const before=JSON.stringify({orders,finance}),out=allocateWbOrderAdvertising({market:'WB',orders,finance,advertising:[ad(5000)]});
 assert.equal(out.entries.length,25);assert.ok(out.entries.every(x=>x.amount===200));assert.equal(out.allocation[0].qty,25);assert.equal(out.allocation[0].allocated,5000);assert.equal(out.allocation[0].unallocated,0);assert.equal(out.entries[0].shkId,'123');assert.equal(out.entries[1].shkId,'');assert.equal(JSON.stringify({orders,finance}),before);
});
test('order quantity, product, day and cabinet stay isolated; delivery date is not a denominator',()=>{
 const orders=[order('one',{qty:2}),order('two',{qty:3}),order('later',{orderDay:'2026-10-11'}),order('other',{productId:'b'}),order('WB2',{market:'WB2'})];
 const out=allocateWbOrderAdvertising({market:'WB',orders,advertising:[ad(1000),ad(900,{day:'2026-10-11'})]});
 assert.deepEqual(out.entries.map(x=>[x.srid,x.amount]),[['one',400],['two',600],['later',900]]);assert.deepEqual(out.allocation.map(x=>x.qty),[5,1]);
});
test('repeated cached rows, finance deliveries and sale/return do not count an order twice; WB-stock order fallback is included',()=>{
 const orders=[order('a'),order('a'),order('a',{source:'finance_order_date'}),order('b',{source:'finance_order_date'}),order('b',{source:'finance_order_date'})];
 const out=allocateWbOrderAdvertising({market:'WB',orders,advertising:[ad(5000)]});assert.equal(out.allocation[0].qty,2);assert.deepEqual(out.entries.map(x=>x.amount),[2500,2500]);
});
test('zero orders leave budget unallocated, zero budgets add no virtual operations, and currencies are not converted',()=>{
 const zero=allocateWbOrderAdvertising({market:'WB',orders:[order('prior-day',{orderDay:'2026-10-09'})],advertising:[ad(5000)]});assert.equal(zero.entries.length,0);assert.equal(zero.allocation[0].unallocated,5000);assert.equal(zero.allocation[0].perUnit,null);
 const none=allocateWbOrderAdvertising({market:'WB',orders:[order('a')],advertising:[ad(0)]});assert.equal(none.entries.length,0);
 const currencies=allocateWbOrderAdvertising({market:'WB',orders:[order('a')],advertising:[ad(100),ad(200,{currency:'RUB'})]});assert.deepEqual(currencies.entries.map(x=>[x.currency,x.amount]),[['KZT',100],['RUB',200]]);
});
test('spend from four empty days and the order day is combined once, even across the displayed period boundary',()=>{
 const orders=[
  order('first',{orderDay:'2026-10-09'}),order('second',{orderDay:'2026-10-09',qty:3}),
  order('before',{orderDay:'2026-10-04'}),order('after',{orderDay:'2026-10-10'}),
  order('other',{productId:'b',orderDay:'2026-10-06'}),order('wb2',{market:'WB2',orderDay:'2026-10-07'})
 ];
 const advertising=[5,6,7,8,9].map(n=>ad(200,{day:'2026-10-0'+n}));
 advertising.push(ad(120,{day:'2026-10-10'}),ad(70,{day:'2026-10-11'}),ad(300,{market:'WB2',day:'2026-10-05'}));
 const out=allocateWbOrderAdvertising({market:'WB',orders,advertising,days:['2026-10-08','2026-10-09','2026-10-10','2026-10-11']});
 assert.deepEqual(out.entries.map(x=>[x.srid,x.amount]),[['first',250],['second',750],['after',120]]);
 assert.deepEqual(out.allocation.map(x=>[x.day,x.orderDay,x.reason,x.unallocated]),[
  ['2026-10-08','2026-10-09','carried',0],['2026-10-09','2026-10-09','allocated',0],
  ['2026-10-10','2026-10-10','allocated',0],['2026-10-11','','no_orders',70]
 ]);
 assert.deepEqual(out.entries[0].allocation,{day:'2026-10-09',firstSpendDay:'2026-10-05',lastSpendDay:'2026-10-09',budget:1000,dayQty:4,qty:1,source:'cached_orders',estimated:true});
});
test('a day with orders resets carry even if it had no advertising of its own',()=>{
 const out=allocateWbOrderAdvertising({market:'WB',orders:[order('early',{orderDay:'2026-10-07'}),order('late')],advertising:[ad(100,{day:'2026-10-05'}),ad(150,{day:'2026-10-08'})]});
 assert.deepEqual(out.entries.map(x=>[x.srid,x.amount]),[['early',100],['late',150]]);
});
test('penny allocation conserves total; real negative ad correction is retained',()=>{
 for(const budget of [1000,-1000]){
  const out=allocateWbOrderAdvertising({market:'WB',orders:[order('a'),order('b'),order('c')],advertising:[ad(budget)]});assert.equal(out.entries.reduce((s,x)=>s+x.amount,0),budget);assert.equal(out.allocation[0].unallocated,0);assert.ok(out.entries.every(x=>Math.sign(x.amount)===Math.sign(budget)));
 }
});
test('contradictory order dates and multiple physical stickers never guess a date or piece',()=>{
 const out=allocateWbOrderAdvertising({market:'WB',orders:[order('a'),order('a',{orderDay:'2026-10-11'}),order('b')],finance:[{productId:'a',srid:'b',shkId:'1',nmId:'100'},{productId:'a',srid:'b',shkId:'2',nmId:'100'}],advertising:[ad(1000)]});assert.equal(out.conflicts.length,1);assert.equal(out.entries.length,1);assert.equal(out.entries[0].shkId,'');assert.equal(out.entries[0].amount,1000);
});
test('billing day uses Moscow order creation time and never invents an unknown date',()=>{
 assert.equal(wbOrderDay('2026-10-10T21:30:00Z'),'2026-10-11');assert.equal(wbOrderDay('2026-10-10T22:30:00+05:00'),'2026-10-10');assert.equal(wbOrderDay('2026-10-10T23:30:00'),'2026-10-10');assert.equal(wbOrderDay('2026-10-10'),'2026-10-10');assert.equal(wbOrderDay('1970-01-01T00:00:00Z'),'');assert.equal(wbOrderDay('bad'),'');assert.equal(wbOrderDay(0),'');
});
test('original cached placement date takes priority over a conflicting report fallback in either input order',()=>{
 const cached=order('a'),fallback=order('a',{orderDay:'2026-10-11',source:'finance_order_date'});
 for(const orders of [[cached,fallback],[fallback,cached]]){const out=allocateWbOrderAdvertising({market:'WB',orders,advertising:[ad(1000)]});assert.equal(out.conflicts.length,0);assert.equal(out.entries.length,1);assert.equal(out.entries[0].orderDay,'2026-10-10');assert.equal(out.entries[0].amount,1000);}
});
