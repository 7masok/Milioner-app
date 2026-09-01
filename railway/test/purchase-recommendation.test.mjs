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
