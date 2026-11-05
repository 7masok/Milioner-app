import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
function fn(name){const a=html.indexOf('function '+name+'('),b=html.indexOf('\nfunction ',a+1);return html.slice(a,b);}
function fixture(){
 const rows=[20,5,60].map(qty=>{const input={value:String(qty),dataset:{lastQty:String(qty)}},unit={value:String(4804/85)};return {input,unit,querySelector:s=>s.includes('qty')?input:unit};}),total={value:'4804',dataset:{}},delivery={value:'1683.64'},alerts=[];
 const c={Number,String,Math,BigInt,document:{querySelectorAll:s=>s==='.correct-purchase-row'?rows:[],getElementById:id=>id==='correctPorBuyTotal'?total:id==='correctPorDelivery'?delivery:null},alert:s=>alerts.push(s)};
 vm.createContext(c);for(const name of ['purchaseTotalPrefix','cancelPurchaseGrandTotal','applyPurchaseGrandTotal','spreadCorrectPurchaseBuyTotal','correctPurchaseQuantityChanged','removeCorrectPurchaseItem'])vm.runInContext(fn(name),c);
 return {c,rows,total,delivery,alerts};
}
test('removal preserves paid amount and delivery and reallocates only remaining items to the cent',()=>{
 const f=fixture();f.c.removeCorrectPurchaseItem({closest:()=>f.rows[0]});assert.equal(f.total.value,'4804');assert.equal(f.delivery.value,'1683.64');assert.equal(f.rows[0].input.value,'0');assert.equal(Math.round(f.rows.slice(1).reduce((n,r)=>n+Number(r.input.value)*Number(r.unit.value),0)*100),480400);assert.equal(f.alerts.length,0);
});
test('typing zero also preserves the paid amount, repeated removal does not lose money',()=>{
 const f=fixture();f.rows[0].input.value='0';f.c.correctPurchaseQuantityChanged(f.rows[0].input);f.rows[1].input.value='0';f.c.correctPurchaseQuantityChanged(f.rows[1].input);assert.equal(f.total.value,'4804');assert.equal(Number(f.rows[2].unit.value)*60,4804);
});
test('a pending manual total still requires its existing explicit confirmation',()=>{
 const f=fixture();f.total.value='5000';f.total.dataset.pendingTotal='1';const before=f.rows[1].unit.value;f.c.removeCorrectPurchaseItem({closest:()=>f.rows[0]});assert.equal(f.total.value,'5000');assert.equal(f.total.dataset.pendingTotal,'1');assert.equal(f.rows[1].unit.value,before);
});
