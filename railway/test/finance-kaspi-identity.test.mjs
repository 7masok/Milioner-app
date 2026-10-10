import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {createHash,webcrypto} from 'node:crypto';
import '../../finance-kaspi-identity.js';
import {parseKaspiStatement} from '../src/ai-assistant.js';

const model=globalThis.FinanceKaspiIdentity;
const sha=value=>createHash('sha256').update(value).digest('hex');
const footer=n=>`АО «Kaspi Bank», БИК CASPKZKA, www.kaspi.kz\nПриложение к Справке No${n} от 10 октября 2026`;
const row=(extra={})=>({date:'2026-10-07',time:'',type:'income',amount:250000,title:'Поступление со Со своего Счета в Kaspi Pay своего счета',bankOperationKey:'old',statementFingerprint:'fp',...extra});
const draft=rows=>({statement:{bank:'Kaspi Bank',currency:'KZT',accountNumber:'KZFIXTURE'},transactions:rows});
const tx=(extra={})=>({id:'saved',source:'bank_statement',statementBank:'kaspi',statementAccountId:'a',statementAccountNumber:'KZFIXTURE',accountId:'a',currency:'KZT',date:'07.10.2026',statementTime:'',bankStatus:'posted',affectsBalance:true,type:'income',amount:250000,title:row().title,bankOperationKey:'old',statementFingerprint:'fp',...extra});
const pdfText=(number,last,duplicate=false)=>`Kaspi Gold\nВЫПИСКА\nза период с 01.10.26 по 10.10.26\nНомер счета: KZFIXTURE\nДата Сумма Операция Детали\n07.10.26+ 250 000,00 ₸ Поступление со Со своего Счета в Kaspi Pay\nсвоего счета\n${footer(number)}\n${duplicate?'07.10.26+ 250 000,00 ₸ Поступление со Со своего Счета в Kaspi Pay\nсвоего счета\n':''}${last?'10.10.26- 300,00 ₸ Перевод Получатель Т.\n':''}`;

test('page footer/certificate/date do not enter titles or stable keys; real long names are preserved',()=>{
  const first=parseKaspiStatement(pdfText(111,true),'first-hash','first.pdf');
  const later=parseKaspiStatement(pdfText(222,true),'second-hash','renamed.pdf');
  assert.equal(first.transactions.length,2);
  assert.equal(first.transactions[0].title,row().title);
  assert.deepEqual(first.transactions.map(x=>x.bankOperationKey),later.transactions.map(x=>x.bankOperationKey));
  const end=parseKaspiStatement(pdfText(333,false),'third','third.pdf');
  assert.equal(end.transactions[0].bankOperationKey,first.transactions[0].bankOperationKey);
  const name='ТОО «Компания с очень длинным настоящим названием» '+ 'Подразделение '.repeat(8);
  assert.equal(model.cleanTitle(name),name.trim());
});

test('two genuine identical same-day payments on different pages stay distinct and stable',()=>{
  const parsed=parseKaspiStatement(pdfText(111,true,true),'first','a.pdf');
  const again=parseKaspiStatement(pdfText(999,true,true),'later','b.pdf');
  assert.equal(parsed.transactions.length,3);
  assert.notEqual(parsed.transactions[0].bankOperationKey,parsed.transactions[1].bankOperationKey);
  assert.deepEqual(parsed.transactions.map(x=>x.bankOperationKey),again.transactions.map(x=>x.bankOperationKey));
});

test('new APK cleans an unchanged old backend response and uses the same keys as the fixed parser',async()=>{
  const response=draft([row({title:row().title+' '+footer(111)}),row({title:row().title,bankOperationKey:'key-two',statementFingerprint:'fp-two'})]);
  const before=structuredClone(response);
  const prepared=await model.prepareDraft(response,sha);
  const server=parseKaspiStatement(pdfText(555,true,true),'server','fixture.pdf');
  assert.deepEqual(prepared.transactions.map(x=>x.bankOperationKey),server.transactions.slice(0,2).map(x=>x.bankOperationKey));
  assert.equal(prepared.transactions[0]._kaspiHadPageMetadata,true);
  assert.equal(prepared.transactions[0].title,row().title);
  assert.deepEqual(response,before,'preparation cannot modify the server response/ledger');
  const bcc={statement:{bank:'BCC'},transactions:[row()]};assert.equal(await model.prepareDraft(bcc,sha),bcc);
});

test('old keyed footer-polluted import is matched despite a new PDF number; balances and identities stay unchanged',async()=>{
  const saved=tx({title:row().title+' '+footer(111),bankOperationKey:'saved-old-key',statementFingerprint:'saved-old-fp'}),history=[saved],before=structuredClone(history);
  const prepared=await model.prepareDraft(draft([row({title:row().title+' '+footer(222),bankOperationKey:'new-old-key',statementFingerprint:'new-old-fp'})]),sha);
  assert.equal(model.legacyMatches(prepared,'a',history).get(prepared.transactions[0]),saved);
  assert.deepEqual(history,before);
});

test('one saved movement does not suppress two genuine identical incoming payments',async()=>{
  const saved=tx({title:row().title+' '+footer(111),bankOperationKey:'historic',statementFingerprint:'historic-fp'});
  const prepared=await model.prepareDraft(draft([row({title:row().title+' '+footer(222),statementFingerprint:'new1'}),row({statementFingerprint:'new2'})]),sha);
  const matches=model.legacyMatches(prepared,'a',[saved]);
  assert.equal(matches.size,1);assert.equal(matches.get(prepared.transactions[0]),saved);
  const second=tx({id:'second',bankOperationKey:prepared.transactions[1].bankOperationKey,statementFingerprint:'other-fp'});
  const both=model.legacyMatches(prepared,'a',[second,saved]);
  assert.equal(both.size,2);assert.equal(both.get(prepared.transactions[0]),saved);assert.equal(both.get(prepared.transactions[1]),second);
});

test('legacy fallback requires footer evidence and exact account, date, direction, amount, currency and details',async()=>{
  const prepared=await model.prepareDraft(draft([row({bankOperationKey:'new-key',statementFingerprint:'new-fp'})]),sha),incoming=prepared.transactions[0];
  const clean=tx({bankOperationKey:'different',statementFingerprint:'different'});
  assert.equal(model.legacyMatches(prepared,'a',[clean]).size,0,'different valid bank keys are not guessed');
  const dirty=tx({title:row().title+' '+footer(111),bankOperationKey:'different',statementFingerprint:'different'});
  for(const change of [{source:'manual'},{statementAccountId:'b'},{date:'08.10.2026'},{type:'expense'},{amount:250001},{currency:'USD'},{title:'Совсем другой перевод '+footer(111)},{statementBank:'bcc'},{statementAccountNumber:'OTHER'},{bankStatus:'blocked'}]){
    assert.equal(model.legacyMatches(prepared,'a',[{...dirty,...change}]).size,0,JSON.stringify(change));
  }
  assert.equal(model.legacyMatches(prepared,'a',[dirty]).get(incoming),dirty);
});

test('transit and own-account transfer retain bank direction; split parts count as one original amount',async()=>{
  const prepared=await model.prepareDraft(draft([row({statementFingerprint:'new-fp',bankOperationKey:'new-key'})]),sha),incoming=prepared.transactions[0];
  for(const change of [{type:'transit_in'},{type:'transfer',statementDirection:'income',accountId:'other',toAccountId:'a',toAmount:250000,toCurrency:'KZT'}]){
    const saved=tx({...change,title:row().title+' '+footer(111),bankOperationKey:'historic',statementFingerprint:'historic-fp'});assert.equal(model.legacyMatches(prepared,'a',[saved]).get(incoming),saved);
  }
  const parts=[tx({id:'part1',amount:100000,title:row().title+' '+footer(111),bankOperationKey:'split',statementFingerprint:'split-fp'}),tx({id:'part2',amount:150000,type:'transit_in',title:row().title+' '+footer(111),bankOperationKey:'split#split:2',statementFingerprint:'split-fp#split:2'})];
  assert.equal(model.legacyMatches(prepared,'a',parts).get(incoming),parts[0]);
  assert.equal(model.legacyMatches(prepared,'a',[parts[0]]).size,0,'a partial split cannot hide the original amount');
});

test('APK preview unchecks old footer imports and batch reuses the saved identity, even on the old backend',async()=>{
  const source=await fs.readFile(new URL('../../finance-kaspi-identity.js',import.meta.url),'utf8');
  const saved=tx({title:row().title+' '+footer(111),bankOperationKey:'historic-key',statementFingerprint:'historic-fp'});
  let preview,outgoing,restoreCalls=0;
  const c={crypto:webcrypto,TextEncoder,Uint8Array,Date,console,document:{getElementById:()=>({value:'a'})},financeTransactions:()=>[saved],financeStatementDraft:null,financeStatementPreview:data=>{preview=data;c.financeStatementDraft=data;},financeStatementExactDuplicate:(r)=>r.bankOperationKey===saved.bankOperationKey?saved:null,financeStatementMainAccountChanged:()=>{},financeImportStatementDraft:async()=>{outgoing=structuredClone(c.financeStatementDraft.transactions);restoreCalls++;},showSheet:message=>{throw Error(message);},esc:String};c.window=c;vm.createContext(c);vm.runInContext(source,c);
  await c.financeStatementPreview(draft([row({title:row().title+' '+footer(222),bankOperationKey:'new-old-key',statementFingerprint:'new-old-fp'})]));
  const canonical=preview.transactions[0].bankOperationKey;
  assert.equal(c.financeStatementExactDuplicate(preview.transactions[0],'a').id,saved.id);
  await c.financeImportStatementDraft();
  assert.equal(outgoing[0].bankOperationKey,saved.bankOperationKey);assert.equal(outgoing[0].statementFingerprint,saved.statementFingerprint);assert.equal(restoreCalls,1);
  assert.equal(preview.transactions[0].bankOperationKey,canonical,'temporary outgoing identity cannot pollute another account preview');
  assert.equal(saved.amount,250000);
});
