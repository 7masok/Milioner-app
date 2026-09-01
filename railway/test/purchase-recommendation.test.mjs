import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
const sourceLines=html.split('\n');
const constants=sourceLines.find(line=>line.startsWith('const MIN_PURCHASE_COVER_DAYS='));
const coverFunction=sourceLines.find(line=>line.startsWith('function purchaseCoverDays()'));
const batchFunction=sourceLines.find(line=>line.startsWith('function fullPurchaseBatchQty('));
const costFunction=sourceLines.find(line=>line.startsWith('function purchasePlanCostSummary('));
const lightweightOptionsFunction=sourceLines.find(line=>line.startsWith('function lightweightPurchaseOptions('));

test('purchase planning period never drops below 25 days',()=>{
  for(const [saved,expected] of [[undefined,25],[10,25],[25,25],[40,40],[999,180]]){
    const context={state:{settings:{purchaseCoverDays:saved}}};
    vm.runInNewContext(`${constants}\n${coverFunction}\nresult=purchaseCoverDays()`,context);
    assert.equal(context.result,expected);
  }
});

test('recommends a full 25-day batch when stock coverage is below 25 days',()=>{
  const context={};
  vm.runInNewContext(`${constants}\nfunction purchaseCoverDays(){return 25}\n${batchFunction}`,context);
  assert.equal(context.fullPurchaseBatchQty(2,48,0,25),50);
  assert.equal(context.fullPurchaseBatchQty(2,0,49,25),50);
  assert.equal(context.fullPurchaseBatchQty(2,50,0,25),0);
  assert.equal(context.fullPurchaseBatchQty(2,48,50,25),0);
  assert.equal(context.fullPurchaseBatchQty(0,0,0,25),0);
});

test('purchase plan cost includes only positions with a known purchase price',()=>{
  const context={};
  vm.runInNewContext(`${costFunction}\nresult=purchasePlanCostSummary([{unitCost:100,estimatedCost:500},{unitCost:0,estimatedCost:0},{unitCost:200,estimatedCost:600}])`,context);
  assert.equal(context.result.total,1100);
  assert.equal(context.result.missing,1);
});

test('bulk purchase rows initially render only their selected product option',()=>{
  const context={
    prod:id=>id==='p1'?{id:'p1',name:'Товар 1'}:null,
    isBundleProduct:()=>false,
    esc:value=>String(value),
  };
  vm.runInNewContext(`${lightweightOptionsFunction}\nselected=lightweightPurchaseOptions('p1');empty=lightweightPurchaseOptions('')`,context);
  assert.equal((context.selected.match(/<option/g)||[]).length,1);
  assert.match(context.selected,/Товар 1/);
  assert.equal((context.empty.match(/<option/g)||[]).length,1);
  assert.match(context.empty,/Начните вводить название/);
});

test('purchase plan reuses calculated rows and collapses without a full redraw',()=>{
  assert.match(html,/rows=Array\.isArray\(cached\)\?cached:purchaseRecommendations\(\)/);
  assert.match(html,/body\.hidden=!expanded/);
  assert.match(html,/document\.querySelectorAll\('\.purchase-plan-check'\)\.forEach\(x=>x\.checked=true\)/);
  assert.match(html,/available=Math\.max\(0,\(Number\(product\.stock\)\|\|0\)-\(reservedByProduct\.get\(productId\)\|\|0\)\)/);
});
