import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const financePath=fileURLToPath(new URL('../src/finance.js',import.meta.url));
const source=await fs.readFile(financePath,'utf8');

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
