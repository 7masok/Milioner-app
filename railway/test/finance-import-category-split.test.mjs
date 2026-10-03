import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const read=path=>readFileSync(new URL(path,import.meta.url),'utf8');

test('finance import category/split addon has valid JavaScript syntax',()=>{
  const path=fileURLToPath(new URL('../../finance-import-tools-v1.js',import.meta.url));
  const result=spawnSync(process.execPath,['--check',path],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
});

test('finance import addon is loaded directly by the app',()=>{
  const html=read('../../index.html');
  assert.match(html,/finance-import-tools-v1\.js\?v=20261003-split-many/);
});

test('category picker can create a category during statement import',()=>{
  const source=read('../../finance-import-tools-v1.js');
  assert.match(source,/\+ Добавить категорию/);
  assert.match(source,/financeStatementQuickAddCategory/);
  assert.match(source,/\/api\/finance\/categories/);
  assert.match(source,/financeStatementChooseCategory/);
});

test('statement payment can split into exact category amounts without doubling balance',()=>{
  const source=read('../../finance-import-tools-v1.js');
  assert.match(source,/Разделить платёж по категориям/);
  assert.match(source,/splitSum\(state\)/);
  assert.match(source,/Math\.abs\(diff\)>\.009/);
  assert.match(source,/expanded\[index\]=splitPartRow/);
  assert.match(source,/statementFingerprint/);
  assert.match(source,/#split:/);
  assert.match(source,/bankOperationKey/);
  assert.match(source,/originalImportStatement\(\)/);
  assert.match(source,/Ещё категория/);
  assert.match(source,/financeStatementAddSplitPart/);
  assert.match(source,/financeStatementRemoveSplitPart/);
  assert.match(source,/for\(let p=1;p<parts\.length;p\+\+\)/);
});
