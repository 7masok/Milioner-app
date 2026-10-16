import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const core=await fs.readFile(new URL('../../finances/core.js',import.meta.url),'utf8');
const addon=await fs.readFile(new URL('../../finance-import-tools-v1.js',import.meta.url),'utf8');
const input={statement:{bank:'Kaspi Bank',currency:'KZT',accountNumber:'KZFIXTURE'},transactions:[{date:'2026-10-16',type:'expense',amount:59300,title:'Покупка',statementFingerprint:'original-fp',bankOperationKey:'original-key'}]};
function harness(source=addon){
  const nodes=[],alerts=[],commands=[];let preview='',fail=false;
  const create=()=>{const node={id:'',value:'',checked:false,disabled:false,hidden:false,innerHTML:'',textContent:'',className:'',dataset:{},children:[],scrollIntoView(){},focus(){},appendChild(child){node.children.push(child);child.parent=node;return child;},remove(){for(const child of node.children)child.remove();const i=nodes.indexOf(node);if(i>=0)nodes.splice(i,1);}};nodes.push(node);return node;};
  const element=(id,value='')=>{const n=create();n.id=id;n.value=value;return n;};
  const body=create(),head=create();
  element('financeStatementAccount','a');element('financeStatementCategory-0','c1');element('financeStatementCategoryButton-0');
  for(const name of ['Transfer','Refund','RefundMode'])element('financeStatement'+name+'-0');
  element('financeStatementSplitLaunch-0');element('financeStatementSplitBox-0');element('financeStatementSplitStatus-0');
  for(const id of ['financeStatementSelectedCount','financeStatementExpenseTotal','financeStatementIncomeTotal','financeStatementExcludedCount'])element(id);
  const check=create();check.className='finance-statement-use';check.dataset.index='0';check.checked=true;
  const selects=selector=>{const index=selector.match(/data-index="(\d+)"/);return nodes.filter(n=>n.className==='finance-statement-use'&&(!selector.includes(':checked')||n.checked)&&(!index||n.dataset.index===index[1]));};
  const c={console,Date,Intl,document:{getElementById:id=>nodes.find(n=>n.id===id),createElement:create,body,head,querySelector:selector=>selects(selector)[0],querySelectorAll:selects},localStorage:{getItem(){return null}},setTimeout(){},alert:s=>alerts.push(s),showSheet:s=>{preview=s;},closeModal(){},navigator:{onLine:false}};c.window=c;vm.createContext(c);
  vm.runInContext("const KEY='fixture';const state={settings:{}};const esc=String;const fmt=String;",c);vm.runInContext(core,c);
  vm.runInContext("state.settings={personalFinanceAccounts:[{id:'a',name:'Kaspi',currency:'KZT',balance:100000,balanceDefault:100000,iban:'KZFIXTURE'}],personalFinanceCategories:[{id:'c1',name:'Байстор',kind:'expense'},{id:'c2',name:'Газмяс',kind:'expense'}],personalFinanceTransactions:[]};financeHydrated=true",c);
  c.financeStatementRememberAccount=async()=>false;c.financeRevealStatementRows=()=>{};
  c.financeRunLocalMutation=async(mutation,queue)=>{if(fail)throw Error('storage fixture failure');const result=mutation();commands.push(...queue(result));return result;};
  vm.runInContext(source,c);c.financeStatementPreview(structuredClone(input));
  return {c,alerts,commands,nodes,get preview(){return preview;},node:id=>c.document.getElementById(id),rows:()=>c.financeTransactions(),draft:()=>vm.runInContext('financeStatementDraft',c),balance:()=>c.financeAccounts()[0].balance,setFailure:v=>{fail=v;}};
}
test('button opens split controls with the actual lexical APK draft, absent on window',()=>{
  const h=harness();assert.equal(h.c.financeStatementDraft,undefined);assert.match(h.preview,/onclick="financeStatementEnableSplit\(0\)"/);
  h.c.financeStatementEnableSplit(0);assert.match(h.node('financeStatementSplitBox-0').innerHTML,/Категория/);assert.equal(h.node('financeStatementSplitLaunch-0').hidden,true);
  assert.equal(h.node('financeStatementTransfer-0').disabled,true);assert.equal(h.node('financeStatementRefundMode-0').disabled,true);assert.equal(h.balance(),100000);assert.equal(h.rows().length,0);
  h.c.financeStatementDisableSplit(0);assert.equal(h.node('financeStatementSplitBox-0').innerHTML,'');assert.equal(h.node('financeStatementTransfer-0').disabled,false);
});
test('59300 is allocated to two categories plus transit, imported once with exact total and stable keys',async()=>{
  const h=harness();h.c.financeStatementEnableSplit(0);
  await h.c.financeImportStatementDraft();assert.equal(h.rows().length,0);assert.equal(h.commands.length,0);assert.ok(h.alerts.length>0,'invalid allocation must block import');
  h.c.financeStatementSplitAmountChanged(0,0,'20000');h.c.financeStatementAddSplitPart(0);h.c.financeStatementSplitCategoryChanged(0,1,'c2');h.c.financeStatementSplitAmountChanged(0,1,'30000');h.c.financeStatementSplitCategoryChanged(0,2,'__transit__');
  assert.equal(h.node('financeStatementExpenseTotal').textContent,'50000');assert.equal(h.node('financeStatementExcludedCount').textContent,'1');
  await h.c.financeImportStatementDraft();assert.equal(h.rows().length,3);assert.equal(h.rows().reduce((n,row)=>n+row.amount,0),59300);assert.equal(h.balance(),40700);
  assert.deepEqual(Array.from(h.rows(),r=>r.amount),[20000,30000,9300]);assert.deepEqual(Array.from(h.rows(),r=>r.categoryId),['c1','c2','']);assert.equal(h.rows()[2].type,'transit_out');
  const batch=h.commands[0].body.transactions;assert.equal(batch[0].bankOperationKey,'original-key');assert.equal(batch[0].statementFingerprint,'original-fp');assert.equal(new Set(batch.map(r=>r.bankOperationKey)).size,3);
  assert.equal(h.draft(),null);assert.equal(h.node('financeStatementSplitImportHelpers'),undefined);
  h.c.financeStatementPreview(structuredClone(input));h.c.financeStatementEnableSplit(0);assert.match(h.alerts.at(-1),/уже импортирован/);await h.c.financeImportStatementDraft();assert.equal(h.rows().length,3);assert.equal(h.balance(),40700);
});
test('failed import restores the original lexical draft and removes temporary controls for a retry',async()=>{
  const h=harness();h.c.financeStatementEnableSplit(0);h.c.financeStatementSplitAmountChanged(0,0,'20000');h.c.financeStatementSplitCategoryChanged(0,1,'c2');
  h.setFailure(true);await h.c.financeImportStatementDraft();assert.equal(h.rows().length,0);assert.equal(h.balance(),100000);assert.equal(h.draft().transactions.length,1);assert.equal(h.draft().transactions[0].amount,59300);assert.equal(h.node('financeStatementSplitImportHelpers'),undefined);assert.match(h.alerts.at(-1),/storage fixture failure/);
  h.setFailure(false);await h.c.financeImportStatementDraft();assert.equal(h.rows().length,2);assert.equal(h.balance(),40700);
});
test('obsolete preview produces a visible explanation instead of a silent button',()=>{
  const h=harness();vm.runInContext('financeStatementDraft=null',h.c);h.c.financeStatementEnableSplit(0);assert.match(h.alerts.at(-1),/Откройте выписку заново/);
});
