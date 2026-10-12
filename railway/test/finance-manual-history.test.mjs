import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {financeTransactionEffects} from '../src/finance-ledger-core.js';

const core=await fs.readFile(new URL('../../finances/core.js',import.meta.url),'utf8');
const statements=await fs.readFile(new URL('../../finances/statements.js',import.meta.url),'utf8');
function harness(){
  const nodes=new Map(),commands=[],alerts=[];let html='',stamp=Date.parse('2026-10-12T12:00:00');
  class Clock extends Date {constructor(...args){super(...(args.length?args:[stamp]));}static now(){return stamp++;}}
  const node=(id,value='')=>{const n={id,value,checked:false,hidden:false,disabled:false,textContent:'',innerHTML:'',tagName:'INPUT',options:[]};Object.defineProperty(n,'selectedOptions',{get:()=>[{value:n.value,textContent:n.value}]});nodes.set(id,n);return n;};
  for(const prefix of ['financeTransaction','financeTransfer']){node(prefix+'Date','2024-04-07');node(prefix+'HistoryOnly').checked=true;node(prefix+'HistoryHint');}
  node('financeTransactionType','expense');node('financeTransactionAccount','a');node('financeTransactionAmount','650000');node('financeTransactionTitle','Стулья');node('financeTransactionCategory','chairs');node('financeTransactionNote','История');
  node('financeTransferFrom','a');node('financeTransferTo','b');node('financeTransferAmount','45000');node('financeTransferNote','Старый перевод');
  for(const [id,value]of [['financePeriodFilter','custom'],['financeTypeFilter','all'],['financeAccountFilter','all'],['financeCategoryFilter','all'],['financeStatementFrom','2024-04-01'],['financeStatementTo','2024-04-30'],['financeStatementFormat','csv']])node(id,value).tagName='SELECT';
  for(const id of ['financeTransactions','financeStatementSummary','financeStatementSave','financeStatementStatus','financeCustomPeriod'])node(id);
  let exported;
  const c={Date:Clock,Intl,TextEncoder,Uint8Array,console,document:{getElementById:id=>nodes.get(id),addEventListener(){}},localStorage:{getItem(){return null},setItem(){}},setTimeout(){},showSheet:s=>{html=s;},closeModal(){},alert:s=>alerts.push(s)};c.window=c;vm.createContext(c);
  vm.runInContext("const KEY='fixture';const state={settings:{}};const esc=String;const fmt=String;",c);vm.runInContext(core,c);
  vm.runInContext("state.settings={personalFinanceAccounts:[{id:'a',name:'Стулья',currency:'KZT',balance:1000000,balanceDefault:1000000},{id:'b',name:'BCC',currency:'KZT',balance:200000,balanceDefault:200000}],personalFinanceCategories:[{id:'chairs',name:'Стулья',kind:'both'}],personalFinanceTransactions:[]};financeHydrated=true",c);
  c.financeRunLocalMutation=async(mutation,queue)=>{const result=mutation();commands.push(...queue(result));return result;};
  c.AndroidFinances={saveStatement:async(text,name,mime)=>{exported={text,name,mime};}};
  vm.runInContext(statements,c);
  return {c,nodes,commands,alerts,get html(){return html;},get exported(){return exported;},balances:()=>Array.from(c.financeAccounts(),a=>[a.balance,a.balanceDefault]),rows:()=>c.financeTransactions()};
}
test('backdated 650000 expense remains in history/category/CSV and has no local or server balance effect',async()=>{
  const h=harness(),before=h.balances();const row=await h.c.saveFinanceTransaction();
  assert.equal(row.date,'07.04.2024');assert.equal(row.affectsBalance,false);assert.deepEqual(h.balances(),before);assert.equal(h.rows().length,1);
  assert.deepEqual(financeTransactionEffects(h.commands[0].body.transaction),[]);assert.equal(h.commands[0].body.transaction.affectsBalance,false);
  assert.equal(h.c.financeTransactionTime(row),new Date(2024,3,7,12).getTime());assert.equal(h.c.financeAnalyticsEntry(row).amount,650000);assert.equal(h.c.financeCountsInIncomeExpense(row),true);
  h.c.renderFinanceTransactions();assert.match(h.nodes.get('financeTransactions').innerHTML,/история без изменения баланса/);
  await h.c.financeSaveStatement();assert.ok(h.exported,h.nodes.get('financeStatementStatus').textContent);assert.match(h.exported.text,/07\.04\.2024/);assert.match(h.exported.text,/650000/);assert.match(h.exported.text,/"Нет"/);
  assert.deepEqual(h.balances(),before);
});
test('history-only income/transit/transfer do not change either account; normal mode still changes balances',async()=>{
  for(const type of ['income','expense','transit_in','transit_out','transfer']){
    const h=harness(),before=h.balances();h.nodes.get('financeTransactionType').value=type;
    const row=type==='transfer'?await h.c.saveFinanceTransfer():await h.c.saveFinanceTransaction();
    assert.equal(row.affectsBalance,false);assert.deepEqual(h.balances(),before,type);assert.deepEqual(financeTransactionEffects(row),[]);
    h.nodes.get((type==='transfer'?'financeTransfer':'financeTransaction')+'HistoryOnly').checked=false;
    const regular=type==='transfer'?await h.c.saveFinanceTransfer():await h.c.saveFinanceTransaction();assert.equal(regular.affectsBalance,true);
    assert.equal(h.balances()[0][0],before[0][0]+(['income','transit_in'].includes(type)?650000:type==='transfer'?-45000:-650000));
    if(type==='transfer')assert.equal(h.balances()[1][0],245000);
  }
});
test('date and amount edits preserve history-only mode and creation timestamp; delete has no effect',async()=>{
  const h=harness(),before=h.balances(),created=await h.c.saveFinanceTransaction(),stamp=created.createdAt;
  h.nodes.get('financeTransactionDate').value='2023-12-31';h.nodes.get('financeTransactionAmount').value='700000';h.nodes.get('financeTransactionHistoryOnly').checked=false;
  const edited=await h.c.saveFinanceTransaction(created.id);assert.equal(edited.date,'31.12.2023');assert.equal(edited.affectsBalance,false);assert.equal(edited.createdAt,stamp);assert.deepEqual(h.balances(),before);
  h.c.financeLocalDeleteTransaction(edited.id);assert.equal(h.rows().length,0);assert.deepEqual(h.balances(),before);
  const transfer=await h.c.saveFinanceTransfer();h.nodes.get('financeTransferDate').value='2023-12-31';h.nodes.get('financeTransferAmount').value='80000';
  const changed=await h.c.saveFinanceTransfer(transfer.id);assert.equal(changed.affectsBalance,false);assert.equal(changed.date,'31.12.2023');assert.deepEqual(h.balances(),before);
});
test('invalid dates block both forms before any write; calendar and existing mode are shown in editors',async()=>{
  for(const value of ['', '2024-02-30','2023-02-29','2024-13-01','07/04/2024']){
    const h=harness();h.nodes.get('financeTransactionDate').value=value;h.nodes.get('financeTransferDate').value=value;
    await h.c.saveFinanceTransaction();await h.c.saveFinanceTransfer();assert.equal(h.commands.length,0);assert.equal(h.rows().length,0);assert.match(h.alerts[0],/корректную дату/);
  }
  const h=harness();h.c.openModal('financeTransaction');assert.match(h.html,/id="financeTransactionDate" type="date"/);assert.match(h.html,/Не менять текущий баланс/);
  h.c.openModal('financeTransfer');assert.match(h.html,/id="financeTransferDate" type="date"/);
  const row=await h.c.saveFinanceTransaction();h.c.openModal('financeTransaction',row.id);assert.match(h.html,/value="2024-04-07"/);assert.match(h.html,/id="financeTransactionHistoryOnly" type="checkbox" checked disabled/);
  assert.equal(h.c.financeOperationDateValue({date:'2024-02-29'}),'2024-02-29');
});
test('a bank date and time stay authoritative over creation/import timestamp',()=>{
  const h=harness(),ts=h.c.financeTransactionTime({date:'07.04.2024',statementTime:'23:59:59',createdAt:Date.parse('2026-10-12')});
  assert.equal(ts,new Date(2024,3,7,23,59,59).getTime());assert.equal(h.c.financeTransactionTime({createdAt:12345}),12345);
});
