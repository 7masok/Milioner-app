import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const financePath=fileURLToPath(new URL('../src/finance.js',import.meta.url));
const ledgerPath=fileURLToPath(new URL('../src/finance-ledger.js',import.meta.url));
const source=await fs.readFile(financePath,'utf8');
const ledgerSource=await fs.readFile(ledgerPath,'utf8');

test('legacy finance snapshot PATCH is disabled',()=>{
  const start=source.indexOf("financeRouter.patch('/finance-state'");
  const end=source.indexOf("financeRouter.put('/finance-state'",start);
  assert.ok(start>=0&&end>start);
  const route=source.slice(start,end);
  assert.match(route,/status\(410\)/);
  assert.match(route,/finance-snapshot-patch-disabled/);
  assert.doesNotMatch(route,/DELETE FROM finance_transactions/);
});

test('full finance replacement requires explicit restore header',()=>{
  const start=source.indexOf("financeRouter.put('/finance-state'");
  assert.ok(start>=0);
  const route=source.slice(start,start+1800);
  assert.match(route,/x-finance-full-replace/);
  assert.match(route,/explicit-restore/);
  assert.match(route,/finance-full-replace-requires-explicit-restore/);
});

test('explicit restore does not depend on a stale client revision',()=>{
  const start=source.indexOf("financeRouter.put('/finance-state'");
  const route=source.slice(start,start+3200);
  assert.doesNotMatch(route,/baseRevision !== currentRevision/);
  assert.match(route,/replaceTransactions\(client, transactions\)/);
});


test('statement batch retries are idempotent and return canonical skips',()=>{
  const start=ledgerSource.indexOf("financeLedgerRouter.post('/finance/transactions/batch'");
  assert.ok(start>=0);
  const route=ledgerSource.slice(start,start+3200);
  assert.match(route,/createTransactionLocked\(client,raw,\{allowStatementDuplicate:true\}\)/);
  assert.doesNotMatch(route,/updateTransactionLocked\(client,id,raw\)/);
  assert.match(route,/skippedTransactions/);
  assert.match(route,/FINANCE_BATCH_SUMMARY/);
});

test('same transaction id is a pure retry unless statement repair is required',()=>{
  const start=ledgerSource.indexOf('async function createTransactionLocked');
  const end=ledgerSource.indexOf('async function updateTransactionLocked',start);
  assert.ok(start>=0&&end>start);
  const fn=ledgerSource.slice(start,end);
  assert.match(fn,/const sameId = await getTransactionRow/);
  assert.match(fn,/const repairBalance = before\.affectsBalance === false/);
  assert.match(fn,/const promotePosted =/);
  assert.match(fn,/idempotent:true/);
  assert.match(fn,/promote-statement/);
});


test('statement binding persists IBAN and card metadata',()=>{
  const start=ledgerSource.indexOf("financeLedgerRouter.post('/finance/accounts/:id/bind-statement'");
  assert.ok(start>=0);
  const route=ledgerSource.slice(start,start+4200);
  assert.match(route,/cardNumber/);
  assert.match(route,/iban/);
  assert.match(route,/next\.iban=iban/);
  assert.match(route,/next\.cardNumber=cardNumber/);
  assert.match(route,/bind&&key/);
  assert.doesNotMatch(route,/if\(!key\) throw httpError\('Statement binding key is required'/);
});


test('statement binding accepts multiple identity keys',()=>{
  const start=ledgerSource.indexOf("financeLedgerRouter.post('/finance/accounts/:id/bind-statement'");
  const route=ledgerSource.slice(start,start+4600);
  assert.match(route,/Array\.isArray\(req\.body\?\.keys\)/);
  assert.match(route,/keysCurrent/);
  assert.match(route,/new Set\(\[\.\.\.keysCurrent,\.\.\.keys\]\)/);
  assert.match(route,/keysCurrent\.filter\(x=>!keys\.includes\(x\)\)/);
});

test('statement metadata refreshes stale IBAN and card values',()=>{
  const start=ledgerSource.indexOf("financeLedgerRouter.post('/finance/accounts/:id/bind-statement'");
  const route=ledgerSource.slice(start,start+4600);
  assert.ok(route.includes("String(before.iban||'')!==iban"));
  assert.ok(route.includes("String(before.cardNumber||'')!==cardNumber"));
});
