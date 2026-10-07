import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import '../../finance-split-model.js';
import { financeTransactionEffects } from '../src/finance-ledger-core.js';
import { financeLedgerRouter } from '../src/finance-ledger.js';
import { pool } from '../src/db.js';
const {buildRows}=globalThis.financeSplitModel;
const before={id:'original',type:'expense',accountId:'a',amount:310000,defaultAmount:310000,currency:'KZT',categoryId:'c1',title:'Платёж',date:'2026-10-01',createdAt:123,statementFingerprint:'bank-fp',bankOperationKey:'bank-key',source:'bank_statement',bankStatus:'posted'};
const parts=[{categoryId:'c1',amount:100000},{categoryId:'c2',amount:150000},{categoryId:'__transit__',amount:60000}];
const input={amount:before.amount,type:before.type,accountId:'a'};
test('split retains 310000 balance movement, bank identity and only counts categorized 250000 as expenses',()=>{
  const rows=buildRows(before,input,parts,'command-123',999);
  assert.equal(rows.length,3);
  assert.equal(rows.reduce((s,t)=>s+financeTransactionEffects(t)[0].delta,0),-310000);
  assert.equal(rows.filter(r=>!r.excludedFromAnalytics).reduce((s,t)=>s+t.amount,0),250000);
  assert.equal(rows[0].id,'original');assert.equal(rows[0].statementFingerprint,'bank-fp');assert.equal(rows[0].bankOperationKey,'bank-key');
  assert.equal(new Set(rows.map(r=>r.id)).size,3);
  assert.equal(new Set(rows.map(r=>r.statementFingerprint)).size,3);
  assert.ok(rows.every(r=>r.createdAt===123&&r.date==='2026-10-01'));
  assert.equal(rows[2].type,'transit_out');assert.equal(rows[2].categoryId,'');
  assert.deepEqual(rows,buildRows(before,input,parts,'command-123',999));
});
test('split validates exact positive amounts, preserves detached/foreign balances and supports income/transit',()=>{
  for(const p of [[{categoryId:'c1',amount:0},...parts.slice(1)],parts.slice(0,2),[{categoryId:'c1',amount:-1},{categoryId:'c2',amount:310001}],[{categoryId:'',amount:100000},...parts.slice(1)],[{categoryId:'c1',amount:.001},{categoryId:'c2',amount:309999.999}]])assert.throws(()=>buildRows(before,input,p,'command-123'));
  assert.throws(()=>buildRows(before,{...input,amount:400000},parts,'command-123'),/сохраняются/);
  assert.throws(()=>buildRows({...before,type:'transfer'},input,parts,'command-123'));
  assert.throws(()=>buildRows({...before,refundOfId:'x'},input,parts,'command-123'));
  assert.throws(()=>buildRows({...before,bankStatus:'blocked'},input,parts,'command-123'));
  for(const type of ['income','expense','transit_in','transit_out']){
    const base={...before,type,amount:.10,currency:'USD',defaultAmount:1.01,affectsBalance:false};
    const rows=buildRows(base,{type,amount:.10,accountId:'a'},[{categoryId:'c1',amount:.03},{categoryId:'__transit__',amount:.07}],'command-123');
    assert.equal(rows.reduce((s,r)=>s+Math.round(r.defaultAmount*100),0),101);
    assert.ok(rows.every(r=>financeTransactionEffects(r).length===0));
  }
  const foreign={...before,currency:'USD',defaultAmount:1234.56789};
  const rows=buildRows(foreign,input,parts,'command-123');
  assert.ok(Math.abs(rows.reduce((s,r)=>s+r.defaultAmount,0)-foreign.defaultAmount)<1e-9,'do not round the original FX conversion');
});

function databaseFixture(){
  const db={transactions:new Map(),account:{id:'a',name:'Kaspi',balance:690000,balance_default:690000,currency:'KZT',archived:false,updated_at:1,payload:{}},audit:[],revision:1,failInsert:false};
  const toRow=t=>({id:t.id,sort_order:0,type:t.type,account_id:t.accountId,to_account_id:'',category_id:t.categoryId,amount:t.amount,default_amount:t.defaultAmount,currency:t.currency,transaction_date:t.date,created_at:t.createdAt,updated_at:t.updatedAt||1,statement_fingerprint:t.statementFingerprint||'',payload:{...t}});
  db.transactions.set(before.id,toRow(before));
  let backup;
  const client={release(){},async query(sql,p=[]){
    if(sql==='BEGIN'){backup=structuredClone({transactions:db.transactions,account:db.account,audit:db.audit,revision:db.revision});return {rows:[]};}
    if(sql==='ROLLBACK'){Object.assign(db,backup);return {rows:[]};}
    if(sql==='COMMIT'||sql.includes('pg_advisory_xact_lock'))return {rows:[]};
    if(sql.includes('SELECT after_payload FROM finance_audit'))return {rows:db.audit.filter(a=>a.id===p[0]&&a.action==='split'&&a.after.splitCommandId===p[1]).map(a=>({after_payload:a.after}))};
    if(sql.includes("payload->>'refundOfId'"))return {rows:[]};
    if(sql.includes('FROM finance_transactions WHERE id=$1'))return {rows:db.transactions.has(p[0])?[db.transactions.get(p[0])]:[]};
    if(sql.includes('FROM finance_categories WHERE id=$1'))return {rows:['c1','c2'].includes(p[0])?[{id:p[0],name:p[0],kind:'expense',archived:false}]:[]};
    if(sql.includes('FROM finance_accounts'))return {rows:[structuredClone(db.account)]};
    if(sql.includes('UPDATE finance_accounts')){Object.assign(db.account,{balance:p[1],balance_default:p[2],payload:JSON.parse(p[3]),updated_at:p[4]});return {rows:[]};}
    if(sql.includes('MAX(sort_order)'))return {rows:[{n:db.transactions.size}]};
    if(sql.includes('INSERT INTO finance_transactions')){if(db.failInsert&&p[0]!==before.id)throw Error('fixture write failure');db.transactions.set(p[0],toRow(JSON.parse(p[13])));return {rows:[]};}
    if(sql.includes('INSERT INTO finance_audit')){db.audit.push({id:p[1],action:p[2],after:JSON.parse(p[4])});return {rows:[{id:db.audit.length}]};}
    if(sql.includes('INSERT INTO finance_state_meta')){db.revision=p[0];return {rows:[]};}
    if(sql.includes('FROM finance_state_meta'))return {rows:[{revision:db.revision,updated_at:1}]};
    throw Error('Unimplemented fixture query: '+sql);
  }};
  return {db,client,toRow};
}
test('real split route commits atomically, deduplicates retries, detects stale edits and rolls back failures',async()=>{
  const original=pool.connect,{db,client,toRow}=databaseFixture();pool.connect=async()=>client;
  const handler=financeLedgerRouter.stack.find(l=>l.route?.path==='/finance/transactions/:id/split').route.stack.at(-1).handle;
  const expected=Object.fromEntries(['amount','accountId','type','categoryId','statementFingerprint','title','note'].map(k=>[k,before[k]??'']));
  const invoke=async(commandId='command-123',extra={})=>{
    let result;await handler({params:{id:'original'},body:{commandId,expected,transaction:input,parts,...extra}}, {json(v){result=v;return this;}},e=>{throw e;});return result;
  };
  try{
    const result=await invoke();assert.equal(result.transactions.length,3);assert.equal(db.account.balance,690000);assert.equal(db.revision,2);assert.equal(db.transactions.size,3);
    const retried=await invoke();assert.equal(retried.idempotent,true);assert.equal(db.account.balance,690000);assert.equal(db.revision,2);assert.equal(db.transactions.size,3);
    const first=db.transactions.get('original');first.payload.affectsBalance=false;
    const create=financeLedgerRouter.stack.find(l=>l.route?.path==='/finance/transactions').route.stack.at(-1).handle;
    let imported;
    await create({body:{transaction:{...before,affectsBalance:true}}},{status(){return this;},json(v){imported=v;return this;}},e=>{throw e;});
    assert.equal(imported.skipped,true);assert.equal(db.transactions.get('original').amount,100000);assert.equal(db.account.balance,690000);
    await assert.rejects(()=>invoke('command-new'),/изменилась/);assert.equal(db.transactions.size,3);
    db.transactions=new Map([[before.id,toRow(before)]]);db.audit=[];db.revision=1;db.failInsert=true;
    await assert.rejects(()=>invoke(),/fixture write failure/);assert.equal(db.transactions.size,1);assert.equal(db.account.balance,690000);assert.equal(db.revision,1);assert.equal(db.audit.length,0);
    db.failInsert=false;
    await assert.rejects(()=>invoke('command-bad',{parts:[{categoryId:'c1',amount:100000},{categoryId:'missing',amount:210000}]}),/категорию/);
    assert.equal(db.transactions.size,1);assert.equal(db.account.balance,690000);
  }finally{pool.connect=original;}
});

test('local repeated statement import cannot repair a split first part into the original full payment',()=>{
  const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
  const source=html.split('\n').find(line=>line.startsWith('function financeLocalImportBatch('));
  const first={...before,amount:100000,splitCommandId:'command-123',affectsBalance:false};
  const fn=new Function('financeLocalStatementExisting','financeLocalUpdateTransaction','financeLocalCreateTransaction',source+'; return financeLocalImportBatch;')(
    ()=>first,()=>{throw Error('must not replace the split part');},()=>{throw Error('must not create a duplicate');});
  const result=fn([{...before,amount:310000,affectsBalance:true}]);
  assert.deepEqual(result.skipped,['original']);assert.equal(first.amount,100000);
});

test('editor uses one durable local command, fills remainder, supports cancellation and rolls back local storage failure',async()=>{
  const elements=new Map(),alerts=[],commands=[];let injected='',saved=0,fallback=0,fail=false;
  const element=id=>{if(!elements.has(id))elements.set(id,{value:'',disabled:false,hidden:false,innerHTML:'',textContent:'',addEventListener(){},closest(){return {insertAdjacentHTML(where,html){injected=html;}};}});return elements.get(id);};
  const transactions=[structuredClone(before)],account={balance:690000};
  const ctx={console,Number,String,Object,JSON,Date,Math,Map,Set,Error,
    document:{getElementById:element,querySelector:()=>element('save'),createElement:()=>({}),head:{appendChild(){}}},
    alert:msg=>alerts.push(msg),esc:String,financeMoney:String,
    openModal(){},saveFinanceTransaction:()=>fallback++,closeModal:()=>saved++,
    financeTransactions:()=>transactions,financeVisibleCategories:()=>[{id:'c1',kind:'expense',name:'Газмяс'},{id:'c2',kind:'expense',name:'Доставка'}],financeCategoryName:id=>id,
    financeCommand:path=>({id:'command-123',path,method:'POST'}),
    financeLocalUpdateTransaction:(id,row)=>{const i=transactions.findIndex(t=>t.id===id);account.balance+=transactions[i].amount-row.amount;transactions[i]={...row};},
    financeLocalCreateTransaction:row=>{transactions.push({...row});account.balance-=row.amount;},
    financeRunLocalMutation:async(fn,list)=>{const backup=structuredClone(transactions),balance=account.balance;try{const result=fn();if(fail)throw Error('storage failed');commands.push(...list());return result;}catch(e){transactions.splice(0,transactions.length,...backup);account.balance=balance;throw e;}}
  };ctx.window=ctx;
  runInNewContext(readFileSync(new URL('../../finance-split-model.js',import.meta.url),'utf8'),ctx);
  runInNewContext(readFileSync(new URL('../../finance-edit-split-v1.js',import.meta.url),'utf8'),ctx);
  const open=()=>{element('financeTransactionType').value='expense';element('financeTransactionAccount').value='a';element('financeTransactionAmount').value='310000';element('financeTransactionCategory').value='c1';element('financeTransactionTitle').value='Платёж';ctx.openModal('financeTransaction','original');};
  open();assert.match(injected,/Разделить по категориям/);ctx.financeEditSplitEnable();ctx.financeEditSplitAmount(0,'100000');assert.equal(element('financeEditSplitAmount-1').value,210000);
  ctx.financeEditSplitCategory(1,'c2');ctx.financeEditSplitAdd();ctx.financeEditSplitAmount(1,'150000');ctx.financeEditSplitCategory(1,'c2');ctx.financeEditSplitCategory(2,'__transit__');assert.equal(element('financeEditSplitAmount-2').value,60000);
  fail=true;await ctx.saveFinanceTransaction('original');assert.equal(transactions.length,1);assert.equal(account.balance,690000);assert.equal(commands.length,0);assert.match(alerts.at(-1),/storage failed/);
  fail=false;await Promise.all([ctx.saveFinanceTransaction('original'),ctx.saveFinanceTransaction('original')]);assert.equal(transactions.length,3);assert.equal(account.balance,690000);assert.equal(commands.length,1);assert.equal(saved,1);assert.equal(commands[0].body.parts.length,3);assert.match(commands[0].path,/original\/split$/);
  transactions.splice(0,transactions.length,structuredClone(before));open();ctx.financeEditSplitEnable();ctx.financeEditSplitDisable();await ctx.saveFinanceTransaction('original');assert.equal(fallback,1);
});

test('shared model and editor load statically before authentication and are served by Railway',()=>{
  const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8'),server=readFileSync(new URL('../src/server.js',import.meta.url),'utf8');
  const model=html.indexOf('<script src="./finance-split-model.js'),editor=html.indexOf('<script src="./finance-edit-split-v1.js'),auth=html.indexOf('<script>initOwnerAuth();');
  assert.ok(model>0&&editor>model&&auth>editor);assert.match(server,/'finance-split-model.js'/);assert.match(server,/'finance-edit-split-v1.js'/);
});
