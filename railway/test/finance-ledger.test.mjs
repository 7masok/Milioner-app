import test from 'node:test';
import assert from 'node:assert/strict';
import { financeMergeEffects, financeTransactionEffects } from '../src/finance-ledger-core.js';

test('income increases one account', () => {
  assert.deepEqual(financeTransactionEffects({type:'income',accountId:'a',amount:5000}), [
    {accountId:'a',delta:5000,defaultDelta:NaN}
  ]);
});

test('expense decreases one account', () => {
  assert.deepEqual(financeTransactionEffects({type:'expense',accountId:'a',amount:5000}), [
    {accountId:'a',delta:-5000,defaultDelta:NaN}
  ]);
});

test('transfer moves money between two accounts', () => {
  assert.deepEqual(financeTransactionEffects({type:'transfer',accountId:'a',toAccountId:'b',amount:45000,toAmount:45000}), [
    {accountId:'a',delta:-45000,defaultDelta:NaN},
    {accountId:'b',delta:45000,defaultDelta:NaN}
  ]);
});

test('adjustment keeps the sign', () => {
  assert.deepEqual(financeTransactionEffects({type:'adjustment',accountId:'a',amount:-5000}), [
    {accountId:'a',delta:-5000,defaultDelta:NaN}
  ]);
});

test('affectsBalance false produces no effects', () => {
  assert.deepEqual(financeTransactionEffects({type:'expense',accountId:'a',amount:5000,affectsBalance:false}), []);
});

test('merge effects combines repeated account deltas', () => {
  assert.deepEqual(financeMergeEffects([
    {accountId:'a',delta:-100,defaultDelta:NaN},
    {accountId:'a',delta:25,defaultDelta:NaN},
    {accountId:'b',delta:50,defaultDelta:75}
  ]), [
    {accountId:'a',delta:-75,defaultDelta:0,hasDefault:false},
    {accountId:'b',delta:50,defaultDelta:75,hasDefault:true}
  ]);
});

test('transfer rejects same source and destination', () => {
  assert.throws(() => financeTransactionEffects({type:'transfer',accountId:'a',toAccountId:'a',amount:1}), /different destination/);
});

test('negative adjustment also decreases default-currency balance', () => {
  assert.deepEqual(financeTransactionEffects({type:'adjustment',accountId:'a',amount:-5,defaultAmount:2500}), [
    {accountId:'a',delta:-5,defaultDelta:-2500}
  ]);
});


test('10000 randomized server ledger effects match an independent reference model', () => {
  let seed=246813579;
  function rnd(){seed=(seed*1664525+1013904223)>>>0;return seed/4294967296}
  const ids=['a','b','c'],types=['income','expense','transit_in','transit_out','adjustment','transfer'];
  for(let i=0;i<10000;i++){
    const type=types[Math.floor(rnd()*types.length)],accountId=ids[Math.floor(rnd()*ids.length)],amount=Math.floor(rnd()*100000)+1,defaultAmount=Math.floor(rnd()*500000)+1,affectsBalance=rnd()>.08;
    let tx={type,accountId,amount,defaultAmount,affectsBalance};
    if(type==='adjustment')tx.amount=rnd()<.5?-amount:amount;
    if(type==='transfer'){
      let toAccountId=ids[Math.floor(rnd()*ids.length)];
      if(toAccountId===accountId)toAccountId=ids[(ids.indexOf(accountId)+1)%ids.length];
      tx={...tx,toAccountId,toAmount:amount+Math.floor(rnd()*1000),toDefaultAmount:defaultAmount+Math.floor(rnd()*2000)};
    }
    const actual=financeTransactionEffects(tx);
    let expected=[];
    if(affectsBalance){
      if(type==='income'||type==='transit_in')expected=[{accountId,delta:amount,defaultDelta:defaultAmount}];
      else if(type==='expense'||type==='transit_out')expected=[{accountId,delta:-amount,defaultDelta:-defaultAmount}];
      else if(type==='adjustment')expected=[{accountId,delta:tx.amount,defaultDelta:Math.sign(tx.amount)*defaultAmount}];
      else if(type==='transfer')expected=[
        {accountId,delta:-amount,defaultDelta:-defaultAmount},
        {accountId:tx.toAccountId,delta:tx.toAmount,defaultDelta:tx.toDefaultAmount}
      ];
    }
    assert.deepEqual(actual,expected,`mismatch at randomized server ledger step ${i}`);
  }
});
