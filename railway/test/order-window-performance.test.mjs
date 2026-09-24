import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
const orders=readFileSync(new URL('../src/orders.js',import.meta.url),'utf8');
const migration=readFileSync(new URL('../migrations/130_order_lines_creation_date.sql',import.meta.url),'utf8');

test('normal Home order reads are bounded to a recent window',()=>{
  assert.match(html,/function orderFeedAfterTimestamp\(\)\{const recent=Date\.now\(\)-45\*86400000/);
  assert.match(html,/\/api\/orders\?limit=15000&after='\+encodeURIComponent\(afterTs\)/);
  assert.match(html,/async function loadSharedOrderCache\(\{silent=true,after=null\}=\{\}\)/);
});

test('custom old order periods request their own older history',()=>{
  assert.match(html,/function ensureCustomOrderHistory\(\)/);
  assert.match(html,/loadSharedOrderCache\(\{silent:true,after\}\)/);
  assert.match(html,/if\(mode==='custom'\)ensureCustomOrderHistory\(\)/);
  assert.match(html,/renderMarketplaceOrders\(\);ensureCustomOrderHistory\(\)/);
});

test('orders API supports an indexed creation-date lower bound',()=>{
  assert.match(orders,/const after = Math\.max\(0, Number\(req\.query\.after \|\| 0\) \|\| 0\)/);
  assert.match(orders,/clauses\.push\('o\.creation_date >= \\
  assert.match(migration,/idx_order_lines_creation_date ON marketplace_order_lines\(creation_date DESC\)/);
});

test('explicit history can stay in memory while the first-paint cache remains compact',()=>{
  assert.match(html,/\.slice\(0,15000\)/);
  assert.match(html,/return combined\.slice\(0,5000\)/);
});
 \+ params\.push\(after\)\)/);
  assert.match(orders,/clauses\.push\('o\.market=\\
  assert.match(migration,/idx_order_lines_creation_date ON marketplace_order_lines\(creation_date DESC\)/);
});

test('explicit history can stay in memory while the first-paint cache remains compact',()=>{
  assert.match(html,/\.slice\(0,15000\)/);
  assert.match(html,/return combined\.slice\(0,5000\)/);
});
 \+ params\.push\(selected\)\)/);
  assert.match(migration,/idx_order_lines_creation_date ON marketplace_order_lines\(creation_date DESC\)/);
});

test('explicit history can stay in memory while the first-paint cache remains compact',()=>{
  assert.match(html,/\.slice\(0,15000\)/);
  assert.match(html,/return combined\.slice\(0,5000\)/);
});
