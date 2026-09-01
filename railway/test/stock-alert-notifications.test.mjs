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

test('stock bell alerts only when sale stock is zero and warehouse stock can be released',()=>{
  const predicate=lines.find(line=>line.startsWith('function shouldAlertWarehouseRelease('));
  const context={};
  vm.runInNewContext(predicate,context);
  assert.equal(context.shouldAlertWarehouseRelease(0,5),true);
  assert.equal(context.shouldAlertWarehouseRelease(1,5),false);
  assert.equal(context.shouldAlertWarehouseRelease(0,0),false);
  assert.doesNotMatch(source,/openStockAlertPurchase/);
  assert.doesNotMatch(source,/>Закупить</);
  assert.match(source,/>Выставить со склада</);
});
