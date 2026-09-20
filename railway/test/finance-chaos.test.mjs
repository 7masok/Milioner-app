import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseKaspiStatement } from '../src/ai-assistant.js';

const indexPath=fileURLToPath(new URL('../../index.html',import.meta.url));
const ledgerPath=fileURLToPath(new URL('../src/finance-ledger.js',import.meta.url));
const html=await fs.readFile(indexPath,'utf8');
const ledger=await fs.readFile(ledgerPath,'utf8');

function extractFunction(name){
  const markers=[`function ${name}(`,`async function ${name}(`];
  let start=-1;
  for(const marker of markers){const p=html.indexOf(marker);if(p>=0&&(start<0||p<start))start=p}
  assert.ok(start>=0,`missing ${name}`);
  const open=html.indexOf('(',start);
  let parens=0,quote='',escaped=false,close=-1;
  for(let i=open;i<html.length;i++){
    const c=html[i];
    if(quote){
      if(escaped){escaped=false;continue}
      if(c==='\\\\'){escaped=true;continue}
      if(c===quote)quote='';
      continue;
    }
    if(c==="'"||c==='"'||c==='`'){quote=c;continue}
    if(c==='(')parens++;
    else if(c===')'){parens--;if(parens===0){close=i;break}}
  }
  assert.ok(close>open,`unclosed params ${name}`);
  const brace=html.indexOf('{',close);
  let depth=0;quote='';escaped=false;
  for(let i=brace;i<html.length;i++){
    const c=html[i];
    if(quote){
      if(escaped){escaped=false;continue}
      if(c==='\\\\'){escaped=true;continue}
      if(c===quote)quote='';
      continue;
    }
    if(c==="'"||c==='"'||c==='`'){quote=c;continue}
    if(c==='{')depth++;
    else if(c==='}'){depth--;if(depth===0)return html.slice(start,i+1)}
  }
  throw new Error('unclosed '+name);
}

test('all finance mutation entrypoints are local-first',()=>{
  const localFirst=[
    'saveFinanceAdjustment','saveFinanceAccount','financeDeleteAccount',
    'financeExecuteMoveAccountOperations','saveFinanceCategory','financeDeleteCategory',
    'saveFinanceTransaction','saveFinanceTransfer','saveFinanceAdjustmentTransaction',
    'financeDeleteTransaction','financeStatementRememberAccount',
    'financeStatementCreateAccountFromStatement','financeImportStatementDraft'
  ];
  for(const name of localFirst){
    const src=extractFunction(name);
    assert.match(src,/financeRunLocalMutation\(/,`${name} must commit locally first`);
  }
});

test('finance cache read failure is not treated as an authoritative empty database',()=>{
  const read=extractFunction('financeCacheRead');
  assert.match(read,/return null/);
  assert.match(read,/financeCacheReadFailed=true/);
  assert.ok(html.includes("if(cached&&(localReady||financeSnapshotHasData(cached)))financeLocalBefore=cached"));
  assert.ok(html.includes("if(financeCacheReadFailed){try{const data=await fetchFinanceCloud(false)"));
});

test('outbox ACK is applied locally before the command is deleted',()=>{
  const sync=extractFunction('financeSyncOutbox');
  assert.match(sync,/await financeApplyServerAck\(data,cmd\);await financeOutboxDelete\(cmd.id\)/);
  assert.match(sync,/await financeReconcileFromServer\(\)/);
});

test('server reconciliation adds remote-only rows without deleting local-only rows',()=>{
  const names=['normalizeFinanceSnapshot','financeStatementIdentity','financeMergeServerArray','financeMergeServerSnapshot'];
  const src=names.map(extractFunction).join('\n');
  const run=new Function(src+`
    const local={accounts:[{id:'a',name:'A',balance:100,updatedAt:10}],categories:[],transactions:[
      {id:'local-only',type:'expense',accountId:'a',amount:5,updatedAt:10},
      {id:'temp',type:'expense',accountId:'a',amount:10,source:'bank_statement',bankOperationKey:'same',bankStatus:'blocked',updatedAt:10}
    ],imports:{}};
    const remote={accounts:[{id:'a',name:'A',balance:88,updatedAt:20}],categories:[],transactions:[
      {id:'server-row',type:'expense',accountId:'a',amount:12,source:'bank_statement',bankOperationKey:'same',bankStatus:'posted',updatedAt:20},
      {id:'remote-only',type:'income',accountId:'a',amount:3,updatedAt:20}
    ],imports:{}};
    return financeMergeServerSnapshot(local,remote);
  `);
  const merged=run();
  assert.equal(merged.accounts[0].balance,88);
  assert.ok(merged.transactions.some(x=>x.id==='local-only'));
  assert.ok(merged.transactions.some(x=>x.id==='remote-only'));
  assert.ok(merged.transactions.some(x=>x.id==='server-row'&&x.bankStatus==='posted'));
  assert.equal(merged.transactions.some(x=>x.id==='temp'),false);
});

test('blocked BCC statement row promotes to posted and corrects balance locally',()=>{
  const names=[
    'financeTransactionType','financeLocalTouchAccount','financeLocalApplyTransactionEffect',
    'financeLocalApplyTransactionEffectSigned','financeLocalCreateTransaction',
    'financeLocalUpdateTransaction','financeLocalStatementExisting','financeLocalImportBatch'
  ];
  const src=names.map(extractFunction).join('\n');
  const run=new Function(src+`
    let accounts=[{id:'a',balance:1000,balanceDefault:1000,currency:'KZT'}],transactions=[];
    function financeAccounts(){return accounts}
    function financeTransactions(){return transactions}
    financeLocalImportBatch([{id:'blocked',type:'expense',accountId:'a',amount:100,defaultAmount:100,source:'bank_statement',bankStatus:'blocked',bankOperationKey:'op1',affectsBalance:true,createdAt:1}]);
    const afterBlocked=accounts[0].balance;
    const result=financeLocalImportBatch([{id:'posted-new',type:'expense',accountId:'a',amount:120,defaultAmount:120,source:'bank_statement',bankStatus:'posted',bankOperationKey:'op1',affectsBalance:true,createdAt:1}]);
    return {afterBlocked,afterPosted:accounts[0].balance,count:transactions.length,row:transactions[0],result};
  `);
  const x=run();
  assert.equal(x.afterBlocked,900);
  assert.equal(x.afterPosted,880);
  assert.equal(x.count,1);
  assert.equal(x.row.id,'blocked');
  assert.equal(x.row.bankStatus,'posted');
  assert.equal(x.row.amount,120);
  assert.deepEqual(x.result.repaired,['blocked']);
});

test('moved history is detached from future balance mutations',()=>{
  const move=extractFunction('financeExecuteMoveAccountOperations');
  const save=extractFunction('saveFinanceTransaction');
  const transfer=extractFunction('saveFinanceTransfer');
  const adjustment=extractFunction('saveFinanceAdjustmentTransaction');
  assert.match(move,/next\.balanceDetached=true/);
  assert.match(move,/next\.affectsBalance=false/);
  assert.match(save,/old\?\.balanceDetached\?false:true/);
  assert.match(transfer,/old\?\.balanceDetached\?false:true/);
  assert.match(adjustment,/old\?\.balanceDetached\?false:true/);
  assert.match(ledger,/next\.balanceDetached=true/);
  assert.match(ledger,/next\.affectsBalance=false/);
});

test('single transaction retries are idempotent on the server',()=>{
  assert.match(ledger,/if \(sameId\) \{[\s\S]*idempotent:true[\s\S]*skipped:true/);
});

test('server promotes a blocked statement to posted instead of silently skipping it',()=>{
  assert.match(ledger,/promotePosted[\s\S]*bankStatus[\s\S]*blocked[\s\S]*posted/);
  assert.match(ledger,/promote-statement/);
  assert.match(ledger,/applyEffects\(client, before, -1\)/);
});

test('Kaspi operation key is stable across different PDF source hashes',()=>{
  const text=`Kaspi Gold
ВЫПИСКА
за период с 20.09.2026 по 20.09.2026
Номер счета: KZ1234567890123456
Дата Сумма Операция Детали
20.09.2026 12:30 - 1 000,00 ₸ Покупка MAGNUM`;
  const a=parseKaspiStatement(text,'hash-one','one.pdf');
  const b=parseKaspiStatement(text,'hash-two','two.pdf');
  assert.ok(a?.transactions?.length===1);
  assert.ok(b?.transactions?.length===1);
  assert.equal(a.transactions[0].bankOperationKey,b.transactions[0].bankOperationKey);
  assert.notEqual(a.transactions[0].statementFingerprint,b.transactions[0].statementFingerprint);
  assert.equal(a.transactions[0].bankStatus,'posted');
});

test('10000 randomized local ledger mutations match an independent reference model',()=>{
  const names=[
    'financeTransactionType','financeLocalTouchAccount','financeLocalApplyTransactionEffect',
    'financeLocalApplyTransactionEffectSigned','financeLocalCreateTransaction',
    'financeLocalUpdateTransaction','financeLocalDeleteTransaction',
    'financeLocalStatementExisting','financeLocalImportBatch'
  ];
  const src=names.map(extractFunction).join('\n');
  const run=new Function(src+`
    let accounts=[
      {id:'a',balance:100000,balanceDefault:100000,currency:'KZT'},
      {id:'b',balance:80000,balanceDefault:80000,currency:'KZT'},
      {id:'c',balance:50000,balanceDefault:50000,currency:'KZT'}
    ],transactions=[];
    function financeAccounts(){return accounts}
    function financeTransactions(){return transactions}
    const initial={a:100000,b:80000,c:50000};
    function expected(){
      const out={...initial};
      for(const tx of transactions){
        if(tx.affectsBalance===false)continue;
        const type=financeTransactionType(tx),amount=Math.abs(Number(tx.amount)||0);
        if(type==='income'||type==='transit_in')out[tx.accountId]+=amount;
        else if(type==='expense'||type==='transit_out')out[tx.accountId]-=amount;
        else if(type==='adjustment')out[tx.accountId]+=Number(tx.amount)||0;
        else if(type==='transfer'){out[tx.accountId]-=amount;out[tx.toAccountId]+=Math.abs(Number(tx.toAmount))||amount}
      }
      return out;
    }
    function verify(step){
      const e=expected();
      for(const account of accounts){
        if(Math.abs(account.balance-e[account.id])>1e-9)throw new Error('balance mismatch at '+step+' '+account.id);
      }
      const ids=new Set();
      for(const tx of transactions){if(ids.has(tx.id))throw new Error('duplicate id '+tx.id);ids.add(tx.id)}
    }
    let seed=123456789,nextId=1;
    function rnd(){seed=(seed*1664525+1013904223)>>>0;return seed/4294967296}
    const ids=['a','b','c'];
    for(let step=0;step<10000;step++){
      const r=rnd(),from=ids[Math.floor(rnd()*ids.length)];
      if(r<.32||transactions.length===0){
        const kind=Math.floor(rnd()*5),amount=Math.floor(rnd()*10000)+1,id='t'+nextId++;
        if(kind===0)financeLocalCreateTransaction({id,type:'income',accountId:from,amount,defaultAmount:amount,affectsBalance:true});
        else if(kind===1)financeLocalCreateTransaction({id,type:'expense',accountId:from,amount,defaultAmount:amount,affectsBalance:true});
        else if(kind===2){let to=ids[Math.floor(rnd()*ids.length)];if(to===from)to=ids[(ids.indexOf(from)+1)%ids.length];financeLocalCreateTransaction({id,type:'transfer',accountId:from,toAccountId:to,amount,toAmount:amount,defaultAmount:amount,affectsBalance:true})}
        else if(kind===3){const signed=(rnd()<.5?-1:1)*amount;financeLocalCreateTransaction({id,type:'adjustment',accountId:from,amount:signed,defaultAmount:amount,affectsBalance:true})}
        else financeLocalCreateTransaction({id,type:rnd()<.5?'transit_in':'transit_out',accountId:from,amount,defaultAmount:amount,affectsBalance:true,excludedFromAnalytics:true});
      }else if(r<.58){
        const i=Math.floor(rnd()*transactions.length),old=transactions[i],amount=Math.floor(rnd()*10000)+1,next={...old,amount};
        if(old.type==='transfer')next.toAmount=amount;
        if(old.type==='adjustment')next.amount=(rnd()<.5?-1:1)*amount;
        financeLocalUpdateTransaction(old.id,next);
      }else if(r<.73){
        const i=Math.floor(rnd()*transactions.length);financeLocalDeleteTransaction(transactions[i].id);
      }else if(r<.88){
        const amount=Math.floor(rnd()*10000)+1,fp='fp'+Math.floor(rnd()*250),row={id:'s'+nextId++,type:rnd()<.5?'income':'expense',accountId:from,amount,defaultAmount:amount,affectsBalance:true,source:'bank_statement',statementFingerprint:fp,bankStatus:'posted'};
        financeLocalImportBatch([row]);
      }else{
        const amount=Math.floor(rnd()*10000)+1,id='nb'+nextId++;financeLocalCreateTransaction({id,type:'expense',accountId:from,amount,defaultAmount:amount,affectsBalance:false});
      }
      verify(step);
    }
    return {transactions:transactions.length,balances:accounts.map(x=>x.balance)};
  `);
  const result=run();
  assert.equal(result.balances.length,3);
  assert.ok(result.transactions>1000);
});
