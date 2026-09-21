import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');

test('product list shows unit cost and unit profit in the right column',()=>{
  const line=html.split('\n').find(row=>row.startsWith('function productCard('));
  assert.match(line,/Себестоимость/);
  assert.match(line,/Средняя прибыль \/ шт\./);
  assert.match(line,/Прибыль за 30 дней/);
  assert.match(line,/hasProfitData=Number\(profit\?\.qty\)>0/);
});


test('projected stock profit is transparent and product cost input is rounded',()=>{
  assert.match(html,/Ожидаемая прибыль с остатка/);
  assert.match(html,/onclick="openStockProfitBreakdown\(\)"/);
  assert.match(html,/function warehouseProjectedProfitRows\(profitStats\)/);
  assert.match(html,/свободный остаток × средняя чистая прибыль/);
  assert.match(html,/последним 30 дням: Kaspi \+ WB1 \+ WB2/);
  assert.match(html,/продано за 30 дней/);
  assert.match(html,/Прибыль за 30 дней/);
  assert.match(html,/sources:value\?\.sources/);
  assert.match(html,/возвраты уменьшают саму прибыль/);
  assert.match(html,/id="ecost"[^>]*step="0\.01"[^>]*Math\.round/);
});
