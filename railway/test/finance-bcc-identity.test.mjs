import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {createHash,webcrypto} from 'node:crypto';
import '../../finance-bcc-identity.js';

const model=globalThis.FinanceBccIdentity,sha=s=>createHash('sha256').update(s).digest('hex');
const row=(extra={})=>({date:'2026-10-08',time:'19:12:24',type:'expense',amount:2683,title:'1688.com',originalAmount:5.52,originalCurrency:'USD',amountEstimated:true,bankStatus:'blocked',bankOperationKey:'new-bank-key',statementFingerprint:'new-fp',...extra});
const draft=rows=>({statement:{bank:'Bank CenterCredit',currency:'KZT',accountNumber:'KZFIXTURE'},transactions:rows});
const tx=(extra={})=>({id:'saved',source:'bank_statement',statementBank:'bcc',statementAccountId:'a',statementAccountNumber:'KZFIXTURE',accountId:'a',currency:'KZT',date:'08.10.2026',statementTime:'19:12:24',type:'expense',amount:2600,title:'Операция ALIPAY',originalAmount:5.52,originalCurrency:'USD',amountEstimated:true,bankStatus:'blocked',bankOperationKey:'historic-key',statementFingerprint:'historic-fp',categoryId:'goods',category:'Товар',affectsBalance:true,...extra});

test('BCC refined merchant and FX estimate retain identity; history stays unchanged',async()=>{
  const old=draft([row({title:'Операция ALIPAY',amount:2600})]),newer=draft([row({title:'1688.com',amount:2683})]);
  const a=await model.prepareDraft(old,sha),b=await model.prepareDraft(newer,sha);
  assert.equal(a.transactions[0].bankOperationKey,b.transactions[0].bankOperationKey);
  const saved=tx(),before=structuredClone(saved);
  assert.equal(model.matches(b,'a',[saved]).get(b.transactions[0]),saved);
  assert.deepEqual(saved,before);assert.equal(old.transactions[0].bankOperationKey,'new-bank-key');
});
test('fallback requires exact banking coordinates, original amount/currency and direction',async()=>{
  const data=await model.prepareDraft(draft([row()]),sha);
  for(const change of [{source:'manual'},{statementBank:'kaspi'},{statementAccountId:'b'},{statementAccountNumber:'OTHER'},{currency:'USD'},{date:'09.10.2026'},{statementTime:'19:12:25'},{statementTime:'19:12'},{originalAmount:5.53},{originalCurrency:'EUR'},{type:'income'}])assert.equal(model.matches(data,'a',[tx(change)]).size,0,JSON.stringify(change));
  assert.equal(model.matches(data,'', [tx()]).size,0);
});
test('one saved operation suppresses one incoming operation; exact second match is reserved first',async()=>{
  const data=await model.prepareDraft(draft([row({statementFingerprint:'fp1',bankOperationKey:'raw1'}),row({statementFingerprint:'fp2',bankOperationKey:'raw2'})]),sha);
  assert.notEqual(data.transactions[0].bankOperationKey,data.transactions[1].bankOperationKey);
  const saved=tx();assert.equal(model.matches(data,'a',[saved]).size,1);
  const second=tx({id:'second',bankOperationKey:data.transactions[1].bankOperationKey,statementFingerprint:'other'});
  const matches=model.matches(data,'a',[second,saved]);assert.equal(matches.size,2);assert.equal(matches.get(data.transactions[0]),saved);assert.equal(matches.get(data.transactions[1]),second);
  const different=await model.prepareDraft(draft([row(),row({time:'19:12:25'})]),sha);assert.equal(model.matches(different,'a',[saved]).size,1);
});
test('missing time cannot turn changed descriptions or a same-day amount into an exact duplicate',async()=>{
  const data=await model.prepareDraft(draft([row({time:''})]),sha);
  assert.equal(model.matches(data,'a',[tx()]).size,0);
  const noOriginal=tx({originalAmount:0,originalCurrency:''});assert.equal(model.matches(draft([row()]),'a',[noOriginal]).size,0);
  const sameCurrency=tx({originalAmount:0,originalCurrency:'',amountEstimated:false,amount:2683});
  assert.equal(model.matches(draft([row({originalAmount:2683,originalCurrency:'KZT',amountEstimated:false})]),'a',[sameCurrency]).size,1);
});
test('transit, own-account transfers and complete split groups preserve the original movement',async()=>{
  const data=await model.prepareDraft(draft([row()]),sha),incoming=data.transactions[0];
  for(const change of [{type:'transit_out'},{type:'transfer',statementDirection:'expense',toAccountId:'other',toAmount:2600,toCurrency:'KZT'}])assert.equal(model.matches(data,'a',[tx(change)]).get(incoming)?.id,'saved');
  const parts=[tx({id:'p1',amount:1000,originalAmount:2,bankOperationKey:'split',statementFingerprint:'split-fp'}),tx({id:'p2',type:'transit_out',amount:1600,originalAmount:3.52,bankOperationKey:'split#split:2',statementFingerprint:'split-fp#split:2'})];
  assert.equal(model.matches(data,'a',parts).get(incoming)?.id,'p1');assert.equal(model.matches(data,'a',[parts[0]]).size,0);
});
test('posted rows without time need a unique unchanged merchant; ambiguous rows remain separate',()=>{
  const posted=row({time:'',title:'Покупка 1688.com',bankStatus:'posted'}),saved=tx({title:'1688.com'});
  assert.equal(model.matches(draft([posted]),'a',[saved]).get(posted),saved);
  assert.equal(model.matches(draft([posted,{...posted,bankOperationKey:'other',statementFingerprint:'other'}]),'a',[saved]).size,0);
  assert.equal(model.matches(draft([{...posted,title:'Другой магазин'}]),'a',[saved]).size,0);
});

test('actual APK engine unchecks a refined BCC import and forced retry reuses old keys without changing balances',async()=>{
  const core=await fs.readFile(new URL('../../finances/core.js',import.meta.url),'utf8'),source=await fs.readFile(new URL('../../finance-bcc-identity.js',import.meta.url),'utf8');
  const saved=tx(),nodes=new Map(),check={dataset:{index:'0'},checked:true};let html='',outgoing,result;
  for(const [id,value]of [['financeStatementAccount','a'],['financeStatementCategory-0','goods'],['financeStatementTransfer-0',''],['financeStatementRefundMode-0',''],['financeStatementRefund-0','']])nodes.set(id,{value,focus(){},scrollIntoView(){}});
  const c={crypto:webcrypto,TextEncoder,Uint8Array,Date,Intl,console,document:{getElementById:id=>nodes.get(id),querySelectorAll:()=>[check]},localStorage:{getItem(){return null}},setTimeout(){},navigator:{onLine:false},showSheet:s=>{html=s},closeModal(){},alert(){}};c.window=c;vm.createContext(c);
  vm.runInContext("const KEY='fixture';const state={settings:{}};const esc=String;const fmt=String;function saveLocalOnly(){throw Error('write forbidden')}",c);vm.runInContext(core,c);
  c.saved=saved;vm.runInContext("state.settings={personalFinanceAccounts:[{id:'a',name:'BCC',currency:'KZT',balance:500,iban:'KZFIXTURE'}],personalFinanceCategories:[{id:'goods',name:'Товар',kind:'expense'}],personalFinanceTransactions:[saved]};financeHydrated=true",c);
  c.financeStatementRememberAccount=async()=>false;c.financeRevealStatementRows=()=>{};
  c.financeRunLocalMutation=async(mutation,commands)=>{result=mutation();outgoing=commands()[0].body.transactions;return result;};
  vm.runInContext(source,c);await c.financeStatementPreview(draft([row()]));
  assert.match(html,/уже импортирован/);assert.doesNotMatch(html,/<input class="finance-statement-use"[^>]*\bchecked\b/);
  assert.equal(c.financeStatementExactDuplicate(vm.runInContext('financeStatementDraft.transactions[0]',c),'a').id,'saved');
  await c.financeImportStatementDraft();assert.equal(result.skipped.length,1);assert.equal(result.transactions.length,0);
  assert.equal(outgoing[0].bankOperationKey,'historic-key');assert.equal(outgoing[0].statementFingerprint,'historic-fp');
  assert.equal(vm.runInContext('financeAccounts()[0].balance',c),500);assert.equal(vm.runInContext('financeTransactions().length',c),1);assert.equal(saved.categoryId,'goods');assert.equal(saved.amount,2600);
});
