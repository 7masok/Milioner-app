import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source=readFileSync(new URL('../../stock-alerts-rescue-v1.js',import.meta.url),'utf8');
const lines=source.split('\n');
const activeFunction=lines.find(line=>line.startsWith('function activeAlertsFrom('));
const unreadFunction=lines.find(line=>line.startsWith('function unreadAlertsFrom('));

test('reading a stock alert clears only the unread badge, not the active list',()=>{
  const context={};
  vm.runInNewContext(`${activeFunction}\n${unreadFunction}`,context);
  const rows=[{p:{id:'a'}},{p:{id:'b'}}];
  const active=context.activeAlertsFrom(rows,{});
  assert.equal(active.length,2);
  assert.equal(context.unreadAlertsFrom(active,{a:{seen:true}}).length,1);
  assert.equal(context.activeAlertsFrom(rows,{a:{dismissed:true}}).length,1);
});

test('stock bell uses the same full-batch purchase formula as the purchase plan',()=>{
  assert.match(source,/fullPurchaseBatchQty\(daily,available,coming,COVER_DAYS\)/);
  assert.doesNotMatch(source,/target-available-warehouse-coming/);
  assert.doesNotMatch(source,/x\.buyQty\|\|Math\.ceil/);
  assert.match(source,/if\(!x\.buyQty\)return alert\('Повторная закупка не нужна/);
});
