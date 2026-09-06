import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
const source=html.slice(html.indexOf('function warehouseAttentionRows()'),html.indexOf('function renderAttention()'));
test('attention catches zero stock without a minimum, shortages and unreleased arrivals',()=>{
 const products=[{id:'a',name:'A',stock:0,min:0},{id:'b',name:'B',stock:2,cost:10},{id:'c',name:'C',stock:3,cost:0}];
 const context={stockProducts:()=>products,reserved:p=>p.id==='b'?4:0,prod:id=>products.find(p=>p.id===id),purchaseStatus:r=>r.status,state:{purchases:[{productId:'a',qty:8,status:'at_warehouse'}]}};
 vm.runInNewContext(source,context);const rows=context.warehouseAttentionRows();
 assert.equal(rows[0].title,'Не хватает под заказы');
 assert.ok(rows.some(r=>r.p.id==='a'&&r.title==='Нет свободного товара'));
 assert.ok(rows.some(r=>r.p.id==='c'&&r.title==='Не задана себестоимость'));
 assert.ok(rows.some(r=>r.p.id==='a'&&r.detail.startsWith('8 шт. прибыли')));
});
