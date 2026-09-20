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

test('inline application scripts still parse after finance changes',()=>{
  const scripts=[...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(x=>x[1]).filter(x=>x.trim());
  assert.ok(scripts.length>0);
  for(const code of scripts)assert.doesNotThrow(()=>new Function(code));
});

test('all finance mutation entrypoints are local-first',()=>{
  const localFirst=[
    'saveFinanceAdjustment','saveFinanceAccount','financeDeleteAccount',
    'financeSetAccountIncludedInTotal','financeExecuteMoveAccountOperations',
    'saveFinanceCategory','financeDeleteCategory','financeSetCategoryIncludedInTotal',
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
  assert.ok(html.includes("if(!financeCacheReadFailed)applyFinanceSnapshot(financeLocalBefore)"));
  assert.ok(html.includes("if(financeCacheReadFailed){try{const data=await fetchFinanceCloud(false)"));
});

test('legacy outbox create commands cannot swallow HTTP 409 anymore',()=>{
  const src=extractFunction('financeNormalizeOutboxCommand');
  const normalize=new Function(src+';return financeNormalizeOutboxCommand')();
  assert.deepEqual(normalize({path:'/api/finance/transactions',method:'POST',acceptStatuses:[409,404]}).acceptStatuses,[404]);
  assert.deepEqual(normalize({path:'/api/finance/accounts',method:'POST',acceptStatuses:[409]}).acceptStatuses,[]);
  assert.deepEqual(normalize({path:'/api/finance/categories',method:'POST',acceptStatuses:[409]}).acceptStatuses,[]);
  assert.deepEqual(normalize({path:'/api/finance/accounts/a/adjust-balance',method:'POST',acceptStatuses:[409]}).acceptStatuses,[409]);
});

test('outbox ACK is applied locally before the command is deleted',()=>{
  const sync=extractFunction('financeSyncOutbox');
  assert.match(sync,/await financeApplyServerAck\(data,cmd\);await financeOutboxDelete\(cmd.id\)/);
  assert.match(sync,/await financeReconcileFromServer\(\)/);
});

test('idle reconciliation checks revision before downloading the full ledger',()=>{
  const src=extractFunction('financeReconcileFromServer');
  assert.match(src,/fetchFinanceCloud\(true\)/);
  assert.match(src,/revision<=financeRemoteRevision/);
  const sync=extractFunction('financeSyncOutbox');
  assert.match(sync,/financeReconcileFromServer\(\{force:true\}\)/);
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

test('server-confirmed reconcile repairs a newer wrong local balance and collapses local statement duplicates',()=>{
  const names=['normalizeFinanceSnapshot','financeStatementIdentity','financeMergeServerArray','financeMergeServerSnapshot'];
  const src=names.map(extractFunction).join('\n');
  const run=new Function(src+`
    const local={accounts:[{id:'a',name:'A',balance:700,updatedAt:999}],categories:[],transactions:[
      {id:'dup1',type:'expense',accountId:'a',amount:100,source:'bank_statement',bankOperationKey:'op',bankStatus:'blocked',updatedAt:800},
      {id:'dup2',type:'expense',accountId:'a',amount:120,source:'bank_statement',bankOperationKey:'op',bankStatus:'posted',updatedAt:700}
    ],imports:{}};
    const remote={accounts:[{id:'a',name:'A',balance:880,updatedAt:500}],categories:[],transactions:[
      {id:'canon',type:'expense',accountId:'a',amount:120,source:'bank_statement',bankOperationKey:'op',bankStatus:'posted',updatedAt:500}
    ],imports:{}};
    return financeMergeServerSnapshot(local,remote,{preferRemote:true});
  `);
  const merged=run();
  assert.equal(merged.accounts[0].balance,880);
  assert.equal(merged.transactions.length,1);
  assert.equal(merged.transactions[0].id,'canon');
  assert.equal(merged.transactions[0].amount,120);
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


test('analytics handles income expense transit transfer refund and exclusions consistently',()=>{
  const names=['financeTransactionType','financeTransactionAmount','financeTransactionDefaultAmount','financeCountsInIncomeExpense','financeEffectiveCategory','financeAnalyticsEntry'];
  const src=names.map(extractFunction).join('\n');
  const run=new Function(src+`
    const all=[{id:'e1',type:'expense',amount:100,defaultAmount:100,categoryId:'food',category:'Еда'}];
    function financeTransactions(){return all}
    return [
      financeAnalyticsEntry(all[0]),
      financeAnalyticsEntry({type:'income',amount:250,defaultAmount:250}),
      financeAnalyticsEntry({type:'transit_out',amount:40,defaultAmount:40,excludedFromAnalytics:true}),
      financeAnalyticsEntry({type:'transfer',amount:50,defaultAmount:50,excludedFromAnalytics:true}),
      financeAnalyticsEntry({type:'income',amount:30,defaultAmount:30,refundOfId:'e1',refundCategoryId:'old',refundCategory:'Старая'}),
      financeAnalyticsEntry({type:'expense',amount:10,defaultAmount:10,excludedFromAnalytics:true})
    ];
  `);
  assert.deepEqual(run(),[
    {mode:'expense',amount:100,categoryId:'food',category:'Еда'},
    {mode:'income',amount:250,categoryId:'',category:''},
    null,
    null,
    {mode:'expense',amount:-30,categoryId:'food',category:'Еда'},
    null
  ]);
});

test('deleting an original transaction also queues deletion of linked refunds',()=>{
  const src=extractFunction('financeDeleteTransaction');
  assert.match(src,/linkedRefunds=financeTransactions\(\)\.filter/);
  assert.match(src,/for\(const refund of linkedRefunds\)/);
  assert.match(src,/deleted\.map\(id=>financeCommand\('\/api\/finance\/transactions\//);
});

test('stable bank keys avoid fuzzy false positives but still protect legacy unkeyed history',()=>{
  const names=['financeTransactionType','financeTransactionAmount','financeTransactionTime','financeStatementDateIsoFromTransaction','financeStatementNormalizeText','financeStatementTokens','financeStatementExactDuplicate','financeStatementLikelyDuplicate'];
  const src=names.map(extractFunction).join('\n');
  const run=new Function(src+`
    const ts=new Date('2026-09-20T12:00:00').getTime();
    let rows=[{id:'old-new-format',type:'expense',amount:100,title:'SHOP',createdAt:ts,bankOperationKey:'different-key'}];
    function financeTransactions(){return rows}
    const incoming={type:'expense',amount:100,title:'SHOP',date:'2026-09-20',bankOperationKey:'new-key'};
    const againstKeyed=financeStatementLikelyDuplicate(incoming);
    rows=[{id:'legacy',type:'expense',amount:100,title:'SHOP',createdAt:ts,source:'bank_statement'}];
    const againstLegacy=financeStatementLikelyDuplicate(incoming);
    return {againstKeyed,againstLegacy};
  `);
  assert.deepEqual(run(),{againstKeyed:false,againstLegacy:true});
});

test('statement duplicate detection is scoped to the selected finance account',()=>{
  const localNames=['financeLocalStatementExisting'];
  const localSrc=localNames.map(extractFunction).join('\n');
  const localRun=new Function(localSrc+`
    let rows=[{id:'b1',type:'expense',accountId:'b',amount:100,bankOperationKey:'same'}];
    function financeTransactions(){return rows}
    return {
      other:financeLocalStatementExisting({type:'expense',accountId:'a',amount:100,bankOperationKey:'same'}),
      same:financeLocalStatementExisting({type:'expense',accountId:'b',amount:100,bankOperationKey:'same'})?.id||''
    };
  `);
  assert.deepEqual(localRun(),{other:null,same:'b1'});
  assert.match(ledger,/statementAccountId[\s\S]*account_id=\$3[\s\S]*to_account_id=\$3/);
  const main=extractFunction('financeStatementMainAccountChanged');
  assert.match(main,/financeStatementExactDuplicate\(row,current\)/);
  assert.match(main,/financeStatementLikelyDuplicate\(row,current\)/);
});

test('statement-created account uses opening balance, not the ending balance twice',()=>{
  const src=extractFunction('financeStatementCreateAccountFromStatement');
  assert.match(src,/statementNet=uniqueRows\.reduce/);
  assert.match(src,/balance=Number\.isFinite\(rawBalance\)\?rawBalance-statementNet:0/);
  assert.match(src,/bankOperationKey\|\|row\?\.statementFingerprint/);
});

test('account and category creates rely on idempotent server ACKs, not swallowed 409s',()=>{
  assert.equal(html.includes("financeCommand('/api/finance/accounts',{method:'POST',body:{account},acceptStatuses:[409]})"),false);
  assert.equal(html.includes("financeCommand('/api/finance/categories',{method:'POST',body:{category},acceptStatuses:[409]})"),false);
  assert.match(ledger,/requestedId[\s\S]*accountPayload\(existing\)[\s\S]*idempotent:true/);
  assert.match(ledger,/requestedId[\s\S]*categoryPayload\(existing\)[\s\S]*idempotent:true/);
});

test('journal filters keep incoming transfers visible on the destination account',()=>{
  const names=['financeTransactionType','financeTransactionTime','financeEffectiveCategory','financeFilteredTransactions'];
  const src=names.map(extractFunction).join('\n');
  const run=new Function(src+`
    const rows=[
      {id:'e1',type:'expense',accountId:'a',categoryId:'food',amount:10,createdAt:100},
      {id:'i1',type:'income',accountId:'b',amount:20,createdAt:200},
      {id:'t1',type:'transfer',accountId:'a',toAccountId:'b',amount:30,createdAt:300},
      {id:'x1',type:'expense',accountId:'b',amount:40,createdAt:400}
    ];
    let financeHistoryPeriodOverride={start:1,end:1000};
    function financeTransactions(){return rows}
    function financePeriodBounds(){return financeHistoryPeriodOverride}
    const values={financePeriodFilter:'all',financeTypeFilter:'all',financeAccountFilter:'b',financeCategoryFilter:'all'};
    const document={getElementById:id=>({value:values[id]||''})};
    return financeFilteredTransactions().map(x=>x.id);
  `);
  assert.deepEqual(run(),['x1','t1','i1']);
});

test('expense/category journal filters include linked refunds',()=>{
  const names=['financeTransactionType','financeTransactionTime','financeEffectiveCategory','financeFilteredTransactions'];
  const src=names.map(extractFunction).join('\n');
  const run=new Function(src+`
    const rows=[
      {id:'e1',type:'expense',accountId:'a',categoryId:'food',category:'Еда',amount:100,createdAt:100},
      {id:'r1',type:'income',accountId:'a',amount:30,createdAt:200,refundOfId:'e1',refundCategoryId:'old',refundCategory:'Старая'}
    ];
    function financeTransactions(){return rows}
    function financePeriodBounds(){return {start:1,end:1000}}
    let financeHistoryPeriodOverride={start:1,end:1000};
    const values={financePeriodFilter:'all',financeTypeFilter:'expense',financeAccountFilter:'all',financeCategoryFilter:'food'};
    const document={getElementById:id=>({value:values[id]||''})};
    return financeFilteredTransactions().map(x=>x.id);
  `);
  assert.deepEqual(run(),['r1','e1']);
});

test('10000 randomized KZT and USD ledger mutations preserve balance and default balance',()=>{
  const names=[
    'financeTransactionType','financeLocalTouchAccount','financeLocalApplyTransactionEffect',
    'financeLocalApplyTransactionEffectSigned','financeLocalCreateTransaction',
    'financeLocalUpdateTransaction','financeLocalDeleteTransaction'
  ];
  const src=names.map(extractFunction).join('\n');
  const run=new Function(src+`
    let accounts=[
      {id:'k1',balance:100000,balanceDefault:100000,currency:'KZT'},
      {id:'k2',balance:50000,balanceDefault:50000,currency:'KZT'},
      {id:'u1',balance:1000,balanceDefault:450000,currency:'USD'},
      {id:'u2',balance:500,balanceDefault:225000,currency:'USD'}
    ],transactions=[];
    function financeAccounts(){return accounts}
    function financeTransactions(){return transactions}
    const base={k1:{b:100000,d:100000},k2:{b:50000,d:50000},u1:{b:1000,d:450000},u2:{b:500,d:225000}};
    function expected(){
      const out=JSON.parse(JSON.stringify(base));
      for(const tx of transactions){
        if(tx.affectsBalance===false)continue;
        const t=financeTransactionType(tx),a=Math.abs(Number(tx.amount)||0),da=Number.isFinite(Number(tx.defaultAmount))?Math.abs(Number(tx.defaultAmount)):null;
        const add=(id,db,dd)=>{out[id].b+=db;if(dd!==null)out[id].d+=dd};
        if(t==='income'||t==='transit_in')add(tx.accountId,a,da);
        else if(t==='expense'||t==='transit_out')add(tx.accountId,-a,da===null?null:-da);
        else if(t==='adjustment'){const signed=Number(tx.amount)||0;add(tx.accountId,signed,da===null?null:da*Math.sign(signed))}
        else if(t==='transfer'){
          const ta=Math.abs(Number(tx.toAmount))||a;
          const td=Number.isFinite(Number(tx.toDefaultAmount))?Math.abs(Number(tx.toDefaultAmount)):(da!==null&&ta===a?da:null);
          add(tx.accountId,-a,da===null?null:-da);add(tx.toAccountId,ta,td);
        }
      }
      return out;
    }
    function verify(step){
      const e=expected();
      for(const a of accounts){
        if(Math.abs(a.balance-e[a.id].b)>1e-8||Math.abs(a.balanceDefault-e[a.id].d)>1e-8)throw new Error('currency balance mismatch '+step+' '+a.id);
      }
    }
    let seed=987654321,next=1;
    function rnd(){seed=(seed*1103515245+12345)>>>0;return seed/4294967296}
    const types=['income','expense','adjustment','transit_in','transit_out'];
    for(let step=0;step<10000;step++){
      const r=rnd();
      if(r<.36||!transactions.length){
        const curr=rnd()<.5?'KZT':'USD',ids=curr==='KZT'?['k1','k2']:['u1','u2'],from=ids[Math.floor(rnd()*2)],amount=Math.floor(rnd()*5000)+1,id='x'+next++;
        if(rnd()<.25){
          const to=ids[1-ids.indexOf(from)],def=curr==='KZT'?amount:amount*450;
          financeLocalCreateTransaction({id,type:'transfer',accountId:from,toAccountId:to,amount,toAmount:amount,defaultAmount:def,toDefaultAmount:def,affectsBalance:true});
        }else{
          const type=types[Math.floor(rnd()*types.length)],signed=type==='adjustment'?(rnd()<.5?-amount:amount):amount,def=curr==='KZT'?Math.abs(signed):Math.abs(signed)*450;
          financeLocalCreateTransaction({id,type,accountId:from,amount:signed,defaultAmount:def,affectsBalance:true});
        }
      }else if(r<.75){
        const i=Math.floor(rnd()*transactions.length),old=transactions[i],curr=accounts.find(a=>a.id===old.accountId).currency,ids=curr==='KZT'?['k1','k2']:['u1','u2'],amount=Math.floor(rnd()*5000)+1,type=rnd()<.2?'transfer':types[Math.floor(rnd()*types.length)],accountId=ids[Math.floor(rnd()*2)],nextTx={...old,type,accountId,amount,defaultAmount:curr==='KZT'?amount:amount*450};
        if(type==='adjustment')nextTx.amount=rnd()<.5?-amount:amount;
        if(type==='transfer'){nextTx.toAccountId=ids[1-ids.indexOf(accountId)];nextTx.toAmount=amount;nextTx.toDefaultAmount=curr==='KZT'?amount:amount*450}
        else{delete nextTx.toAccountId;delete nextTx.toAmount;delete nextTx.toDefaultAmount}
        financeLocalUpdateTransaction(old.id,nextTx);
      }else{
        const i=Math.floor(rnd()*transactions.length);financeLocalDeleteTransaction(transactions[i].id);
      }
      verify(step);
    }
    return accounts.map(x=>({id:x.id,balance:x.balance,balanceDefault:x.balanceDefault}));
  `);
  assert.equal(run().length,4);
});
