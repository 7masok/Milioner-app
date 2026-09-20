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
