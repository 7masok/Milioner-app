import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWarehousePayload, snapshotSummary } from '../src/ai-assistant.js';

test('GPT context parses warehouse JSON stored as text', () => {
  const raw=JSON.stringify({products:[{id:'p1',name:'Рулетка',stock:7,min:3,kaspi:'123'}],sales:[{productId:'p1',qty:2,channel:'Kaspi',date:10}]});
  assert.equal(parseWarehousePayload(raw).products[0].name,'Рулетка');
  const context=snapshotSummary(raw,[{market:'Kaspi',order_id:'o1',product_name:'Рулетка',qty:1,creation_date:20}]);
  assert.deepEqual(context.counts,{products:1,purchases:0,sales:1,orders:1});
  assert.equal(context.products[0].stock,7);
  assert.equal(context.sales[0].market,'Kaspi');
  assert.equal(context.orders[0].name,'Рулетка');
});

test('GPT context tolerates an invalid warehouse payload', () => {
  const context=snapshotSummary('{broken');
  assert.equal(context.counts.products,0);
});
