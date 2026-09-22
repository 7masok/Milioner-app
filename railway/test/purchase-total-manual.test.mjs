import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');

function extract(name,next){
  const start=html.indexOf('function '+name+'(');
  const end=html.indexOf('function '+next+'(',start+1);
  assert.ok(start>=0&&end>start,'function '+name+' not found');
  return html.slice(start,end);
}

test('new purchase total is always manual and never auto-filled from recommendations',()=>{
  const fn=extract('purchaseForm','lightweightPurchaseOptions');
  assert.doesNotMatch(fn,/suggestedTotal/);
  assert.match(fn,/id="porBuyTotal"[^>]*value=""/);
  assert.match(fn,/placeholder="Введите сумму продавца"/);
  assert.match(fn,/Заполняется только вручную по фактической цене продавца/);
  assert.doesNotMatch(fn,/value="\$\{hint\.estimatedCost/);
});

test('per-product historical estimate remains visible below the product',()=>{
  const start=html.indexOf('function purchaseAverageEstimate(');
  const end=html.indexOf('function updatePurchaseAverageEstimates(',start);
  assert.ok(start>=0&&end>start);
  const fn=html.slice(start,end);
  assert.match(fn,/Ориентировочно без доставки/);
  assert.match(fn,/средняя закупочная цена/);
});
