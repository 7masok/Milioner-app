import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const core=await fs.readFile(new URL('../../finances/core.js',import.meta.url),'utf8');
const tools=await fs.readFile(new URL('../../finance-import-tools-v1.js',import.meta.url),'utf8');
const purchase=(extra={})=>({id:'purchase',type:'expense',amount:59300,defaultAmount:59300,currency:'KZT',accountId:'a',categoryId:'c1',category:'Байстор',title:'Покупка ИП EDONKZ',date:'16.10.2026',createdAt:1,affectsBalance:true,...extra});
const incoming=(extra={})=>({type:'income',amount:10500,date:'2026-10-16',title:'Пополнение Со счета в Kaspi',statementFingerprint:'refund-fp',bankOperationKey:'refund-key',...extra});
function harness(rows=[incoming()],history=[purchase()],balance=0){
  const nodes=[],alerts=[],commands=[];let fail=false;
  const create=()=>{const n={id:'',value:'',checked:false,disabled:false,hidden:false,innerHTML:'',textContent:'',className:'',dataset:{},children:[],scrollIntoView(){},focus(){},appendChild(child){n.children.push(child);return child;},remove(){for(const c of n.children)c.remove();nodes.splice(nodes.indexOf(n),1);}};nodes.push(n);return n;};
  const element=(id,value='')=>{const n=create();n.id=id;n.value=value;return n;};
  const check=i=>nodes.find(n=>n.className==='finance-statement-use'&&n.dataset.index===String(i));
  const query=selector=>{const match=selector.match(/data-index="(\d+)"/);return nodes.filter(n=>n.className==='finance-statement-use'&&(!match||n.dataset.index===match[1])&&(!selector.includes(':checked')||n.checked));};
  element('financeStatementAccount','a');
  for(let i=0;i<rows.length;i++){
    const n=create();n.className='finance-statement-use';n.dataset.index=String(i);n.checked=true;
    element('financeStatementCategory-'+i,rows[i].type==='expense'?'c1':'');element('financeStatementCategoryButton-'+i);
    for(const name of ['Transfer','Refund','RefundMode','RefundPicker','RefundHint','RefundSource','RefundSearch','SplitLaunch','SplitBox','SplitStatus'])element('financeStatement'+name+'-'+i);
  }
  for(const id of ['financeStatementSelectedCount','financeStatementExpenseTotal','financeStatementIncomeTotal','financeStatementExcludedCount'])element(id);
  const c={Date,Intl,console,document:{getElementById:id=>nodes.find(n=>n.id===id),createElement:create,querySelector:s=>query(s)[0],querySelectorAll:query,body:create(),head:create()},localStorage:{getItem(){return null}},setTimeout(){},showSheet(){},closeModal(){},alert:s=>alerts.push(s),navigator:{onLine:false}};c.window=c;vm.createContext(c);
  vm.runInContext("const KEY='fixture';const state={settings:{}};const esc=s=>String(s??'').replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c]));const fmt=String;",c);vm.runInContext(core,c);
  c.fixture={history,balance};vm.runInContext("state.settings={personalFinanceAccounts:[{id:'a',name:'Kaspi',currency:'KZT',balance:fixture.balance,balanceDefault:fixture.balance,iban:'KZFIXTURE'},{id:'b',name:'BCC',currency:'KZT',balance:200000}],personalFinanceCategories:[{id:'c1',name:'Байстор',kind:'expense'},{id:'c2',name:'Другое',kind:'expense'}],personalFinanceTransactions:fixture.history};financeHydrated=true",c);
  c.financeStatementRememberAccount=async()=>false;c.financeRevealStatementRows=()=>{};
  c.financeRunLocalMutation=async(mutation,queue)=>{if(fail)throw Error('storage fixture failure');const result=mutation();commands.push(...queue(result));return result;};
  vm.runInContext(tools,c);c.financeStatementPreview({statement:{bank:'Kaspi Bank',currency:'KZT',accountNumber:'KZFIXTURE'},transactions:rows});
  const node=id=>c.document.getElementById(id);
  return {c,alerts,commands,node,check,rows:()=>c.financeTransactions(),balance:()=>c.financeAccounts()[0].balance,draft:()=>vm.runInContext('financeStatementDraft',c),setFailure:v=>{fail=v;},mode(index){node('financeStatementRefundMode-'+index).value='refund';c.financeStatementRefundChanged(index);},choose(index,ref){node('financeStatementRefundSource-'+index).value=ref;c.financeStatementRefundSourceChanged(index);}};
}
test('manual partial refund selects 59300 purchase for 10500, lowers category expense to 48800 and credits balance once',async()=>{
  const original=purchase(),h=harness([incoming()],[original]);h.mode(0);
  assert.equal(h.node('financeStatementRefund-0').value,'','source must be selected manually');assert.match(h.node('financeStatementRefundSource-0').innerHTML,/purchase/);
  h.choose(0,'purchase');assert.equal(h.node('financeStatementRefund-0').value,'purchase');assert.match(h.node('financeStatementRefundHint-0').innerHTML,/48800/);
  await h.c.financeImportStatementDraft();const refund=h.rows().find(r=>r.refundOfId==='purchase');assert.ok(refund);assert.equal(original.amount,59300);assert.equal(refund.amount,10500);assert.equal(refund.refundCategoryId,'c1');assert.equal(refund.excludedFromAnalytics,true);assert.equal(h.balance(),10500);
  assert.equal(h.c.financeAnalyticsEntry(original).amount+h.c.financeAnalyticsEntry(refund).amount,48800);assert.equal(h.c.financeAnalyticsEntry(refund).mode,'expense');
  assert.equal(h.commands[0].body.transactions[0].refundOfId,'purchase');
  h.c.financeStatementPreview({statement:{bank:'Kaspi Bank',currency:'KZT'},transactions:[incoming()]});h.node('financeStatementRefundMode-0').value='';await h.c.financeImportStatementDraft();assert.equal(h.rows().length,2);assert.equal(h.balance(),10500);
});
test('purchase and partial refund from the same PDF link to generated purchase ID',async()=>{
  const rows=[{...purchase(),date:'2026-10-16',bankOperationKey:'purchase-key',statementFingerprint:'purchase-fp'},incoming()],h=harness(rows,[],59300);
  h.mode(1);h.choose(1,'draft:0');await h.c.financeImportStatementDraft();assert.equal(h.rows().length,2);assert.equal(h.balance(),10500);
  const p=h.rows().find(r=>r.type==='expense'),r=h.rows().find(r=>r.refundOfId);assert.equal(p.amount,59300);assert.equal(r.refundOfId,p.id);assert.equal(r.refundCategoryId,'c1');
});
test('refund can select the second split part in the same PDF and survives a failed save before retry',async()=>{
  const rows=[{...purchase(),date:'2026-10-16',bankOperationKey:'purchase-key',statementFingerprint:'purchase-fp'},incoming()],h=harness(rows,[],59300);
  h.c.financeStatementEnableSplit(0);h.c.financeStatementSplitAmountChanged(0,0,'10500');h.c.financeStatementSplitCategoryChanged(0,1,'c1');
  h.mode(1);h.choose(1,'draft:0:part:1');assert.equal(h.node('financeStatementRefund-1').value,'draft:0:part:1');
  h.setFailure(true);await h.c.financeImportStatementDraft();assert.equal(h.rows().length,0);assert.equal(h.draft().transactions.length,2);assert.equal(h.node('financeStatementRefund-1').value,'draft:0:part:1');assert.equal(h.node('financeStatementSplitImportHelpers'),undefined);
  h.setFailure(false);await h.c.financeImportStatementDraft();assert.equal(h.rows().length,3);assert.equal(h.balance(),10500);
  const source=h.rows().find(r=>r.amount===48800),refund=h.rows().find(r=>r.refundOfId);assert.equal(refund.refundOfId,source.id);assert.equal(refund.refundCategoryId,'c1');assert.equal(h.rows().reduce((n,r)=>n+(h.c.financeAnalyticsEntry(r)?.amount||0),0),48800);
});
test('previous and pending refunds reserve the amount; over-refund is rejected before any mutation',async()=>{
  const history=[purchase(),{id:'old-refund',type:'income',amount:10000,accountId:'a',currency:'KZT',refundOfId:'purchase'}];
  const h=harness([incoming({amount:25000}),incoming({amount:25000,bankOperationKey:'second',statementFingerprint:'second-fp'})],history);
  h.mode(0);h.choose(0,'purchase');h.mode(1);assert.doesNotMatch(h.node('financeStatementRefundSource-1').innerHTML,/value="purchase"/);
  h.node('financeStatementRefund-1').value='purchase';await h.c.financeImportStatementDraft();assert.equal(h.rows().length,2);assert.equal(h.commands.length,0);assert.match(h.alerts.at(-1),/превышает/);
  h.check(1).checked=false;await h.c.financeImportStatementDraft();assert.equal(h.rows().length,3);assert.equal(h.balance(),25000);
});
test('manual list supports older and other-account expenses, search, and rejects wrong currency, future dates or transfers',()=>{
  const history=[purchase({date:'01.01.2026'}),purchase({id:'other-account',accountId:'b'}),purchase({id:'usd',currency:'USD'}),purchase({id:'future',date:'17.10.2026'}),purchase({id:'transfer',type:'transfer',toAccountId:'b'})],h=harness([incoming()],history);
  h.mode(0);const html=h.node('financeStatementRefundSource-0').innerHTML;assert.match(html,/value="purchase"/);assert.match(html,/value="other-account"/);assert.doesNotMatch(html,/value="(?:usd|future|transfer)"/);
  h.node('financeStatementRefundSearch-0').value='нет такого';h.c.financeStatementRefundChanged(0);assert.doesNotMatch(h.node('financeStatementRefundSource-0').innerHTML,/value="purchase"/);
  h.node('financeStatementRefundSearch-0').value='Байстор';h.c.financeStatementRefundChanged(0);assert.match(h.node('financeStatementRefundSource-0').innerHTML,/value="purchase"/);
});
