import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');

test('product list shows unit cost and unit profit in the right column',()=>{
  const line=html.split('\n').find(row=>row.startsWith('function productCard('));
  assert.match(line,/Себестоимость/);
  assert.match(line,/Прибыль \/ шт\./);
  assert.match(line,/hasProfitData=Number\(profit\?\.qty\)>0/);
});
