import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeAccruals } from '../src/ozon-fbo.js';

const source=readFileSync(new URL('../src/ozon-fbo.js',import.meta.url),'utf8');

test('Ozon finance normalization preserves service linkage fields for crossdock attribution',()=>{
  const rows=normalizeAccruals([{
    accrual_id:'a1',
    unit_number:'SUP-123',
    accrued_category:'SERVICES',
    non_item_fee:{type_id:77,accrued:{amount:'-1200.50',currency:'KZT'}}
  }],'2026-10-01',new Map([['77','Кросс-докинг FBO']]));
  assert.equal(rows.length,1);
  assert.equal(rows[0].operation_type_name,'Кросс-докинг FBO');
  assert.equal(rows[0].operation_type_id,'77');
  assert.equal(rows[0].unit_number,'SUP-123');
  assert.equal(rows[0].accrued_category,'SERVICES');
  assert.equal(rows[0].fee_scope,'non_item_fee');
  assert.equal(rows[0].amount,-1200.5);
  assert.deepEqual(rows[0].items,[]);
});

test('Ozon item finance fees keep SKU and fee scope',()=>{
  const rows=normalizeAccruals([{
    accrual_id:'a2',
    unit_number:'ORDER-9',
    accrued_category:'SERVICES',
    item_fees:{fees:[{sku:'998877',fees:[{type_id:91,accrued:{amount:'-300',currency:'KZT'}}]}]}
  }],'2026-10-01',new Map([['91','Перемещение FBO']]));
  assert.equal(rows.length,1);
  assert.equal(rows[0].fee_scope,'item_fee');
  assert.equal(rows[0].unit_number,'ORDER-9');
  assert.deepEqual(rows[0].items,[{sku:'998877'}]);
});

test('crossdock bundle composition is cached and reused instead of refetching every sync',()=>{
  assert.match(source,/function cachedBundleItems\(previousRows\)/);
  assert.match(source,/if\(cached\.has\(bundleId\)\)\{supply\.items=cached\.get\(bundleId\);continue;\}/);
  assert.match(source,/if\(budget<=0\)\{supply\.items=\[\];supply\.bundle_pending=true;continue;\}/);
  assert.match(source,/fetchSupplyOrders\(credentials,previous\.supplies\?\.rows\|\|\[\]\)/);
});
