import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const reports=readFileSync(new URL('../src/reports.js',import.meta.url),'utf8');
const reportUi=readFileSync(new URL('../../kaspi-report-v2.js',import.meta.url),'utf8');
const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');

test('WB product finance exposes weighted commission percent and actual logistics per sold unit',()=>{
  assert.match(reports,/commissionPercent/);
  assert.match(reports,/commission_percent/);
  assert.match(reports,/AS "commissionPctWeighted"/);
  assert.match(reports,/AS "commissionPctWeight"/);
  assert.match(reports,/avgDelivery = saleQty > 0 \? Math\.max\(0, Number\(row\.delivery \|\| 0\) \+ Number\(row\.rebill \|\| 0\)\) \/ saleQty : null/);
  assert.match(reports,/avgCommissionPct = commissionPctWeight > 0 \? Number\(row\.commissionPctWeighted \|\| 0\) \/ commissionPctWeight : null/);
});

test('WB product economics stay separated by WB1 and WB2 in selected-period product stats',()=>{
  assert.match(reportUi,/deliveryTotal:0,commissionPctWeighted:0,commissionPctWeight:0/);
  assert.match(reportUi,/commissionPct:Number\(part\.commissionPctWeight\)>0/);
  assert.match(reportUi,/deliveryTotal=Math\.max\(0,Number\(x\.delivery\|\|0\)\+Number\(x\.rebill\|\|0\)\)/);
  assert.match(reportUi,/Логистика \/ шт\.<\/th><th>Комиссия<\/th>/);
});

test('Product details show WB average logistics and commission without changing other marketplace rows',()=>{
  assert.match(html,/isWb=name==='WB'\|\|name==='WB2'/);
  assert.match(html,/логистика \/ шт\.<\/span>/);
  assert.match(html,/commissionPct/);
  assert.match(html,/maximumFractionDigits:1/);
});
