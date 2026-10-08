import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import '../../finance-statement-transfers.js';
import { financeTransactionType, financePositive, financeTransactionEffects, financeMergeEffects } from '../src/finance-ledger-core.js';
const model=globalThis.FinanceStatementTransfers;
const first={id:'first',type:'transfer',accountId:'bcc',toAccountId:'kaspi',amount:10000,toAmount:10000,currency:'KZT',toCurrency:'KZT',date:'08.10.2026',title:'Kaspi перевод',source:'bank_statement',statementTransfer:true,statementDirection:'expense',statementAccountId:'bcc',bankOperationKey:'bcc-op',statementFingerprint:'bcc-fp',bankStatus:'posted',affectsBalance:true,createdAt:100,updatedAt:100};
const second={...first,id:'second',statementAccountId:'kaspi',statementDirection:'income',bankOperationKey:'kaspi-op',statementFingerprint:'kaspi-fp',statementTransferMatchId:'first'};

test('two bank sides are linked without changing the original movement',()=>{
 assert.equal(model.canLink(first,second),true);
 const linked=model.link(first,second);
 assert.deepEqual(financeTransactionEffects(linked),financeTransactionEffects(first));
 assert.equal(linked.id,'first');assert.equal(linked.bankOperationKey,'bcc-op');assert.equal(linked.statementLinks.length,1);
 assert.equal(model.isAlias(linked,second),true);assert.equal(model.isAlias(linked,{...second,statementAccountId:'another'}),false);
 assert.strictEqual(model.link(linked,second),linked);
 assert.equal(model.canLink(linked,{...second,bankOperationKey:'another-op',statementFingerprint:'another-fp'}),false);
});

test('either bank can be imported first; adjacent bank posting dates are offered',()=>{
 const incomingFirst={...second,id:'incoming-first'};delete incomingFirst.statementTransferMatchId;
 assert.equal(model.canLink(incomingFirst,first),true);
 assert.equal(model.canLink(first,{...second,date:'09.10.2026'}),true);
});

test('wrong accounts direction amount currency dates and invalid movements cannot be linked',()=>{
 const cases=[{accountId:'other'},{toAccountId:'other'},{amount:11000},{toAmount:9000},{currency:'USD'},{toCurrency:'USD'},{date:'11.10.2026'},{date:''},{statementDirection:'expense'},{statementAccountId:'other'},{statementAccountId:'bcc'},{source:'manual'},{type:'income'},{bankStatus:'blocked'},{affectsBalance:false},{statementTransfer:false},{bankOperationKey:'',statementFingerprint:''}];
 for(const change of cases){assert.equal(model.canLink(first,{...second,...change}),false,JSON.stringify(change));assert.throws(()=>model.link(first,{...second,...change}));}
 assert.equal(model.canLink({...first,affectsBalance:false},second),false);
 assert.equal(model.canLink({...first,splitCommandId:'split'},second),false);
});

const html=await fs.readFile(new URL('../../index.html',import.meta.url),'utf8');
const ledger=await fs.readFile(new URL('../src/finance-ledger.js',import.meta.url),'utf8');
function line(name){const start=html.indexOf('function '+name+'(');assert.ok(start>=0);return html.slice(start,html.indexOf('\n',start));}

test('local import links once and repeated PDFs do not create movements or change balances',()=>{
 const rows=[structuredClone(first)];let effects=0;
 const context={globalThis,Date,financeTransactions:()=>rows,financeLocalCreateTransaction:()=>{effects++;throw Error('must not create a movement')},financeLocalUpdateTransaction:()=>{effects++;throw Error('must not change a movement')}};
 vm.createContext(context);vm.runInContext(line('financeLocalStatementExisting')+'\n'+line('financeLocalImportBatch')+'\n'+line('financeStatementExactDuplicate'),context);
 const result=context.financeLocalImportBatch([second]);
 assert.deepEqual(Array.from(result.linked),['first']);assert.equal(rows.length,1);assert.equal(effects,0);
 assert.equal(context.financeStatementExactDuplicate({bankOperationKey:'kaspi-op'},'kaspi').id,'first');
 for(let i=0;i<5;i++)context.financeLocalImportBatch([{...second,id:'retry-'+i,statementFingerprint:'different-pdf-'+i}]);
 assert.equal(rows.length,1);assert.equal(rows[0].statementLinks.length,1);assert.equal(effects,0);
});

test('repeated equal transfers keep separate identities and require an explicit target',()=>{
 const other={...first,id:'other',bankOperationKey:'bcc-other',statementFingerprint:'bcc-other-fp'};
 assert.equal([first,other].filter(x=>model.canLink(x,second)).length,2);
 const linked=model.link(other,second);assert.equal(linked.id,'other');assert.equal(model.isAlias(first,second),false);
 const noModel=html.slice(html.indexOf('async function financeImportStatementDraft('));
 assert.match(noModel,/if\(match&&!match.value\)/);
 assert.match(noModel,/matchChoice!==\s*'__new__'/);
});

function dbRow(tx){return{id:tx.id,sort_order:0,type:tx.type,account_id:tx.accountId,to_account_id:tx.toAccountId,category_id:'',amount:tx.amount,default_amount:null,currency:tx.currency,transaction_date:tx.date,created_at:tx.createdAt,updated_at:tx.updatedAt,statement_fingerprint:tx.statementFingerprint,payload:structuredClone(tx)}}
function server(){
 const handlers={};const router={get(){},put(){},post(path,...args){handlers[path]=args.at(-1)},patch(){},delete(){}};
 const rows=new Map([['first',dbRow(first)]]);let balanceWrites=0,revision=1,audits=0;
 const client={async query(sql,args=[]){
  if(sql.includes('pg_advisory_xact_lock'))return{rows:[]};
  if(sql.includes('FROM finance_state_meta'))return{rows:[{revision,updated_at:100}]};
  if(sql.includes('INSERT INTO finance_state_meta')){revision=args[0];return{rows:[]}};
  if(sql.includes('FROM finance_accounts'))return{rows:[{id:args[0],currency:'KZT',balance:123,payload:{}}]};
  if(sql.includes('UPDATE finance_accounts')){balanceWrites++;throw Error('unexpected balance update')};
  if(sql.includes('FROM finance_transactions WHERE id=$1'))return{rows:rows.has(args[0])?[rows.get(args[0])]:[]};
  if(sql.includes('FROM finance_transactions')&&sql.includes('statement_fingerprint=$1')){
   assert.match(sql,/jsonb_array_elements/);assert.match(sql,/link->>'accountId'=\$3/);
   const [fp,key,account]=args;
   const found=[...rows.values()].find(r=>model.isAlias(r.payload,{statementAccountId:account,statementFingerprint:fp,bankOperationKey:key})||(r.statement_fingerprint===fp||r.payload.bankOperationKey===key)&&[r.account_id,r.to_account_id,r.payload.statementAccountId].includes(account));
   return{rows:found?[found]:[]};
  }
  if(sql.includes('INSERT INTO finance_transactions')){rows.set(args[0],dbRow(JSON.parse(args[13])));return{rows:[]}};
  if(sql.includes('INSERT INTO finance_audit')){audits++;return{rows:[{id:audits}]}};
  throw Error('Unexpected query '+sql);
 }};
 const context={globalThis,console:{log(){}},Date,Set,Map,Number,String,Array,Math,JSON,express:{Router:()=>router},pool:{},transaction:fn=>fn(client),asyncRoute:fn=>fn,requireTrustedOrigin(){},requireWritesEnabled(){},financeTransactionType,financePositive,financeTransactionEffects,financeMergeEffects};
 vm.createContext(context);
 vm.runInContext(ledger.replace(/^import .*;\n/gm,'').replace('export const financeLedgerRouter','const financeLedgerRouter')+'\nthis.createTransactionLocked=createTransactionLocked;',context);
 return{context,client,handlers,rows,stats:()=>({balanceWrites,revision,audits})};
}

test('server batch persists the link audits and bumps revision without changing balances; retry is idempotent',async()=>{
 const app=server();let response;
 const req={body:{transactions:[second]}},res={json(value){response=value}};
 await app.handlers['/finance/transactions/batch'](req,res);
 assert.equal(response.revision,2);assert.equal(response.transactions.length,0);assert.equal(response.skippedTransactions[0].id,'first');
 assert.equal(app.rows.size,1);assert.equal(app.rows.get('first').payload.statementLinks.length,1);assert.deepEqual(app.stats(),{balanceWrites:0,revision:2,audits:1});
 await app.handlers['/finance/transactions/batch'](req,res);
 assert.equal(response.revision,2);assert.deepEqual(app.stats(),{balanceWrites:0,revision:2,audits:1});
});

test('server rejects stale invalid targets before writing and prevents caller-supplied link aliases',async()=>{
 const app=server();await assert.rejects(app.context.createTransactionLocked(app.client,{...second,amount:11000}),/не соответствует/);
 await assert.rejects(app.context.createTransactionLocked(app.client,{...second,statementTransferMatchId:'missing'}),/не найден/);
 assert.deepEqual(app.stats(),{balanceWrites:0,revision:1,audits:0});
 const result=await app.context.createTransactionLocked(app.client,{...second,statementLinks:[{accountId:'forged',bankOperationKey:'fake'}]});
 assert.equal(result.transaction.statementLinks.length,1);assert.equal(result.transaction.statementLinks[0].accountId,'kaspi');
 assert.equal(result.transaction.statementTransferMatchId,undefined);
});

test('new matching controls stay static before owner startup and preserve existing transfer controls',()=>{
 assert.ok(html.indexOf('finance-statement-transfers.js')<html.indexOf('<script>initOwnerAuth();'));
 assert.match(line('financeStatementTransferSelect'),/financeStatementTransferMatchBox/);
 assert.match(line('financeStatementTransferChanged'),/financeStatementRenderTransferMatch\(index\)/);
 assert.match(line('financeStatementRenderTransferMatch'),/matches\.map/);
 assert.match(line('financeStatementRenderTransferMatch'),/Это новый перевод/);
});

test('actual preview renders multiple choices and blocks an unresolved transfer before import mutations',async()=>{
 const elements=new Map();const alerts=[];
 const first2={...first,id:'first2',bankOperationKey:'bcc-op-2'};
 const rows=[first,first2],accounts=[{id:'bcc',currency:'KZT'},{id:'kaspi',currency:'KZT'}];
 const draft={statement:{currency:'KZT'},transactions:[{...second,type:'income',date:'2026-10-08'}]};
 elements.set('financeStatementAccount',{value:'kaspi'});
 elements.set('financeStatementTransfer-0',{value:'bcc'});
 const box={markup:'',set innerHTML(html){this.markup=html;elements.delete('financeStatementTransferMatch-0');if(html.includes('id="financeStatementTransferMatch-0"'))elements.set('financeStatementTransferMatch-0',{value:'',focus(){this.focused=true}})},get innerHTML(){return this.markup}};
 elements.set('financeStatementTransferMatchBox-0',box);
 const document={getElementById:id=>elements.get(id)||null,querySelectorAll:()=>[{dataset:{index:'0'}}]};
 const context={globalThis,document,financeStatementDraft:draft,financeTransactions:()=>rows,financeAccounts:()=>accounts,financeStatementDateRu:date=>date.split('-').reverse().join('.'),financeMoney:(amount,currency)=>amount+' '+currency,esc:value=>String(value),alert:message=>alerts.push(message)};
 vm.createContext(context);
 vm.runInContext(line('financeStatementTransferCandidate')+'\n'+line('financeStatementRenderTransferMatch')+'\n'+line('financeStatementExactDuplicate')+'\nasync '+line('financeImportStatementDraft'),context);
 context.financeStatementRenderTransferMatch(0);
 assert.match(box.markup,/value="first"/);assert.match(box.markup,/value="first2"/);
 assert.equal(elements.get('financeStatementTransferMatch-0').value,'');
 await context.financeImportStatementDraft();
 assert.equal(alerts.length,1);assert.match(alerts[0],/похожий учтённый перевод/);
 assert.equal(elements.get('financeStatementTransferMatch-0').focused,true);
 elements.get('financeStatementTransferMatch-0').value='first2';
 context.financeStatementRenderTransferMatch(0);
 assert.equal(elements.get('financeStatementTransferMatch-0').value,'first2');
 elements.get('financeStatementTransfer-0').value='another-account';
 context.financeStatementRenderTransferMatch(0);
 assert.equal(box.markup,'');assert.equal(elements.has('financeStatementTransferMatch-0'),false);
});

test('Railway exposes the shared transfer model as a frontend asset',async()=>{
 const source=await fs.readFile(new URL('../src/server.js',import.meta.url),'utf8');
 assert.match(source,/'finance-statement-transfers\.js'/);
});
