import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const core=await fs.readFile(new URL('../../finances/core.js',import.meta.url),'utf8');
function preview(rows){
  let html='';
  const c={Date,Intl,console,document:{getElementById(){return null}},localStorage:{getItem(){return null}},setTimeout(){},showSheet:s=>{html=s}};
  c.window=c;vm.createContext(c);
  vm.runInContext("const KEY='fixture';const state={settings:{personalFinanceAccounts:[{id:'a',name:'BCC',currency:'KZT',balance:0,iban:'KZFIXTURE'}],personalFinanceCategories:[],personalFinanceTransactions:[]}};const esc=String;const fmt=String;",c);
  vm.runInContext(core,c);
  const data={statement:{bank:'Bank CenterCredit',currency:'KZT',accountNumber:'KZFIXTURE'},transactions:rows},before=structuredClone(data);
  c.financeStatementPreview(data);
  assert.deepEqual(data,before,'render must not reorder or rewrite parser rows or bank identifiers');
  return {html,order:[...html.matchAll(/id="financeStatementRow-(\d+)"/g)].map(m=>+m[1])};
}
const row=(date,time,extra={})=>({date,time,type:'expense',amount:100,title:'Fixture purchase',statementFingerprint:'fixture-fp',bankOperationKey:'fixture-key',bankStatus:'posted',...extra});

test('actual preview interleaves appended BCC blocked rows by operation date/time and retains original control indices',()=>{
  const rows=[row('2026-10-16',''),row('2026-10-15',''),row('2026-10-09',''),row('2026-10-15','17:11:36',{bankStatus:'blocked'}),row('2026-10-15','19:18:17',{bankStatus:'blocked'}),row('2026-10-14','15:53:40',{bankStatus:'blocked'})];
  const {html,order}=preview(rows);
  assert.deepEqual(order,[0,4,3,1,5,2]);
  for(const index of order)assert.ok(html.includes('data-index="'+index+'"'),'controls still refer to parser index '+index);
});

test('equal date/time order stays stable; empty or invalid dates are last and valid seconds decide same-day order',()=>{
  const {order}=preview([row('2026-10-15','17:11:36'),row('2026-10-15','17:11:36'),row('','23:59'),row('2026-02-30','23:59'),row('2026-10-15','17:11:37'),row('2026-10-15','17:12'),row('2026-10-15','25:00'),row('2026-10-15','')]);
  assert.deepEqual(order,[5,4,0,1,6,7,2,3]);
});
