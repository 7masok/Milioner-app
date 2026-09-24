import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const indexPath=fileURLToPath(new URL('../../index.html',import.meta.url));
const cloudSyncPath=fileURLToPath(new URL('../../cloud-sync-v3.js',import.meta.url));
const html=await fs.readFile(indexPath,'utf8');
const cloudSync=await fs.readFile(cloudSyncPath,'utf8');

test('finance analytics UI state is initialized before rendering',()=>{
  assert.match(html,/let financeAnalyticsMode='expense',financeAnalyticsPeriod='year',financeAnalyticsAnchor=new Date\(\),financeHistoryPeriodOverride=null,financePeriodSwipePoint=null;/);
});

test('finance render isolates analytics and journal panels',()=>{
  assert.match(html,/financeRenderPart\('breakdown',renderFinanceBreakdown\)/);
  assert.match(html,/financeRenderPart\('transactions',renderFinanceTransactions\)/);
});

test('finance journal empty state is controlled by renderer',()=>{
  assert.match(html,/По выбранным фильтрам операций нет/);
});

test('uncategorized rows remain filterable in history but stay out of analytics',()=>{
  assert.match(html,/value="__uncategorized__">Без категории/);
  const fn=extractFunction('financeAnalyticsEntry');
  assert.ok(fn.includes("if(!effective.categoryId&&!effective.category)return null"));
});

test('deleting a finance account with history preserves operations locally',()=>{
  assert.ok(html.includes("операций останутся в журнале"));
  assert.ok(html.includes("account.archived=true;account.ignoreInBalance=true"));
  assert.ok(html.includes("financeCommand('/api/finance/accounts/'+encodeURIComponent(accountId),{method:'DELETE',acceptStatuses:[404]})"));
});

test('archived finance account remains selectable when editing old history',()=>{
  assert.match(html,/x\.archived\?' · удалённый':'/);
});


test('finance is local-first with a durable IndexedDB outbox',()=>{
  assert.ok(html.includes("FINANCE_OUTBOX_STORE='outbox',FINANCE_CACHE_VERSION=2"));
  assert.ok(html.includes('async function financeLocalPersist(commands=[]'));
  assert.ok(html.includes('async function financeSyncOutbox()'));
  assert.ok(html.includes("financeCommandSequence=0"));
  assert.ok(html.includes("applyFinanceSnapshot(financeLocalBefore);try{await bootstrapWarehouseFromServer()"));
  assert.ok(html.includes("const ordersPromise=Promise.resolve(loadSharedOrderCache({silent:true}))"));
  assert.ok(html.includes("const financePromise=Promise.resolve(bootstrapFinanceFromServer(financeLocalBefore))"));
});


test('fresh login opens Home Today while browser reload preserves the current period',()=>{
  const start=html.indexOf('function startAppRuntime(){');
  assert.ok(start>=0);
  const fn=html.slice(start,start+7000);
  assert.ok(fn.includes("const startupView='home',freshLogin=sessionStorage.getItem(APP_FRESH_LOGIN_KEY)==='1'"));
  assert.ok(fn.includes("if(freshLogin){orderPeriodMode='today'"));
  assert.equal(fn.includes('localStorage.getItem(ACTIVE_VIEW_KEY)'),false);
  assert.match(cloudSync,/orderPeriodMode=savedOrderPeriodUi\.mode/);
  assert.doesNotMatch(cloudSync,/Every fresh app start opens/);
});

test('startup does not duplicate the initial orders request',()=>{
  const bootStart=cloudSync.indexOf('bootstrapWarehouseFromServer=async function(){');
  const bootEnd=cloudSync.indexOf('startWarehouseServerWatcher=function',bootStart);
  const boot=cloudSync.slice(bootStart,bootEnd);
  assert.equal(boot.includes('loadSharedOrderCache?.({silent:true})'),false);
  const start=html.indexOf('function startAppRuntime(){');
  const intervalAt=html.indexOf('setInterval(()=>loadSharedOrderCache({silent:true})',start);
  const immediate=html.slice(start,intervalAt>start?intervalAt:start+5000);
  assert.equal((immediate.match(/loadSharedOrderCache\(\{silent:true\}\)/g)||[]).length,1);
  assert.ok(immediate.indexOf('const ordersPromise=')<immediate.indexOf('await ordersPromise'));
  assert.ok(immediate.indexOf('const financePromise=')<immediate.indexOf('await ordersPromise'));
});
test('normal finance flow no longer uses snapshot PATCH',()=>{
  assert.equal(html.includes("/api/finance-state',{method:'PATCH'"),false);
  assert.ok(html.includes("financeRunLocalMutation(()=>old?financeLocalUpdateTransaction"));
  assert.ok(html.includes("financeRunLocalMutation(()=>financeLocalImportBatch(transactions)"));
});

test('finance background watcher only drains the outbox',()=>{
  assert.ok(html.includes("setInterval(()=>financeSyncOutbox(),15000)"));
  assert.equal(html.includes("setInterval(()=>pullFinanceFromServer(),30000)"),false);
});

function extractFunction(name){
  const markers=[`function ${name}(`,`async function ${name}(`];
  let start=-1;
  for(const marker of markers){const p=html.indexOf(marker);if(p>=0&&(start<0||p<start))start=p}
  assert.ok(start>=0,`missing ${name}`);
  const candidates=[html.indexOf('\nfunction ',start+10),html.indexOf('\nasync function ',start+10)].filter(x=>x>start);
  const end=candidates.length?Math.min(...candidates):html.length;
  return html.slice(start,end);
}

test('local finance balance effects are reversible',()=>{
  const names=['financeTransactionType','financeLocalTouchAccount','financeLocalApplyTransactionEffect','financeLocalApplyTransactionEffectSigned','financeLocalCreateTransaction','financeLocalUpdateTransaction','financeLocalDeleteTransaction'];
  const src=names.map(extractFunction).join('\n');
  const run=new Function(`
    let accounts=[{id:'a',balance:100000,balanceDefault:100000,currency:'KZT'},{id:'b',balance:10000,balanceDefault:10000,currency:'KZT'}],transactions=[];
    function financeAccounts(){return accounts}
    function financeTransactions(){return transactions}
    ${src}
    const created=financeLocalCreateTransaction({id:'t1',type:'transfer',accountId:'a',toAccountId:'b',amount:45000,toAmount:45000,currency:'KZT',toCurrency:'KZT',defaultAmount:45000,affectsBalance:true,createdAt:1});
    const afterCreate=accounts.map(x=>x.balance);
    financeLocalUpdateTransaction('t1',{...created,amount:40000,toAmount:40000,defaultAmount:40000});
    const afterEdit=accounts.map(x=>x.balance);
    financeLocalDeleteTransaction('t1');
    const afterDelete=accounts.map(x=>x.balance);
    financeLocalCreateTransaction({id:'e1',type:'expense',accountId:'a',amount:5000,defaultAmount:5000,currency:'KZT',affectsBalance:true,createdAt:2});
    const afterExpense=accounts.map(x=>x.balance);
    financeLocalDeleteTransaction('e1');
    const afterExpenseDelete=accounts.map(x=>x.balance);
    return {afterCreate,afterEdit,afterDelete,afterExpense,afterExpenseDelete};
  `);
  assert.deepEqual(run(),{
    afterCreate:[55000,55000],
    afterEdit:[60000,50000],
    afterDelete:[100000,10000],
    afterExpense:[95000,10000],
    afterExpenseDelete:[100000,10000]
  });
});

test('initialized empty local finance database remains authoritative',()=>{
  assert.ok(html.includes("FINANCE_LOCAL_READY_KEY='milioner-finance-local-ready-v1'"));
  assert.ok(html.includes("localStorage.getItem(FINANCE_LOCAL_READY_KEY)==='1'"));
  assert.ok(html.includes("localStorage.setItem(FINANCE_LOCAL_READY_KEY,'1')"));
});

test('bank statement import commits locally before server sync',()=>{
  const start=html.indexOf('async function financeImportStatementDraft(){');
  assert.ok(start>=0);
  const end=html.indexOf('\nasync function financeProcessStatementFile',start);
  const fn=html.slice(start,end>start?end:start+30000);
  assert.ok(fn.includes('financeRunLocalMutation(()=>financeLocalImportBatch(transactions)'));
  assert.ok(fn.includes("financeCommand('/api/finance/transactions/batch'"));
  assert.equal(fn.includes('await financeLedgerMutate'),false);
});

test('automatic finance background flow never reloads server snapshot over local data',()=>{
  const watcherStart=html.indexOf('function startFinanceServerWatcher(){');
  const watcherEnd=html.indexOf('\nfunction ',watcherStart+10);
  const watcher=html.slice(watcherStart,watcherEnd>watcherStart?watcherEnd:watcherStart+3000);
  assert.ok(watcher.includes('financeSyncOutbox()'));
  assert.equal(watcher.includes('fetchFinanceCloud(false)'),false);
  assert.equal(watcher.includes('financeReloadFromServer'),false);
});


test('statement merge identity is scoped to the finance account',()=>{
  const src=extractFunction('financeStatementIdentity');
  const make=new Function(src+'; return financeStatementIdentity;')();
  assert.notEqual(
    make({bankOperationKey:'same-op',statementAccountId:'account-a'}),
    make({bankOperationKey:'same-op',statementAccountId:'account-b'})
  );
});

test('statement import reveals its own period and account in the journal',()=>{
  const reveal=extractFunction('financeRevealStatementRows');
  assert.ok(reveal.includes("financeHistoryPeriodOverride={start:from.getTime(),end:to.getTime(),label:'Период выписки'}"));
  assert.ok(reveal.includes("panel.open=true"));
  assert.ok(reveal.includes("account.value=[...account.options].some"));
  const start=html.indexOf('async function financeImportStatementDraft(){');
  const end=html.indexOf('\\nasync function financeProcessStatementFile',start);
  const fn=html.slice(start,end>start?end:start+30000);
  assert.ok(fn.includes('financeRevealStatementRows(accountId,transactions)'));
  assert.ok(fn.includes('баланс повторно не менялся'));
});


test('finance journal defaults to current month',()=>{
  assert.match(html,/id="financePeriodFilter"[^>]*><option value="day">Сегодня<\/option><option value="month" selected>Этот месяц<\/option>/);
});


test('server ACK canonicalizes skipped statement duplicates immediately',()=>{
  const fn=extractFunction('financeApplyServerAck');
  assert.ok(fn.includes('upsertTransactions(data.skippedTransactions)'));
  assert.ok(fn.includes('financeStatementIdentity(list[i])===identity'));
  assert.ok(fn.includes('list.splice(i,1)'));
});

test('statement import reports exact local balance change',()=>{
  const start=html.indexOf('async function financeImportStatementDraft(){');
  const end=html.indexOf('\nasync function financeProcessStatementFile',start);
  const fn=html.slice(start,end>start?end:start+35000);
  assert.ok(fn.includes('balanceBeforeImport=Number(account.balance)||0'));
  assert.ok(fn.includes('balanceAfterImport=Number(financeAccounts().find'));
  assert.ok(fn.includes("+' · баланс '+financeMoney(balanceBeforeImport"));
});


test('statement import stores bank requisites on selected account',()=>{
  const accountNumber=extractFunction('financeStatementAccountNumber');
  const cardNumber=extractFunction('financeStatementCardNumber');
  const remember=extractFunction('financeStatementRememberAccount');
  assert.ok(accountNumber.includes("statement?.accountNumber||statement?.iban"));
  assert.ok(cardNumber.includes("statement?.cardNumber"));
  assert.ok(remember.includes("a.iban=iban"));
  assert.ok(remember.includes("a.cardNumber=card"));
  assert.ok(remember.includes("bankStatementCardNumber"));
  assert.ok(remember.includes("bind:Boolean(bind)"));
});

test('finance account cards expose imported IBAN and card details',()=>{
  assert.ok(html.includes('function financeAccountRequisites(a)'));
  assert.ok(html.includes("parts.push((/^KZ/i.test(number)?'IBAN ':'Счёт ')+number)"));
  assert.ok(html.includes("parts.push('Карта '+card)"));
  assert.ok(html.includes("financeAccountRequisites(x)"));
});

test('statement import verifies final account balance against statement closing balance',()=>{
  const start=html.indexOf('async function financeImportStatementDraft(){');
  const end=html.indexOf('\nasync function financeProcessStatementFile',start);
  const fn=html.slice(start,end>start?end:start+40000);
  assert.ok(fn.includes('statementBalance=Number(draft.statement?.currentBalance)'));
  assert.ok(fn.includes('Math.abs(statementDiff)<=.01'));
  assert.ok(fn.includes('Остаток совпадает с выпиской'));
  assert.ok(fn.includes('Остаток НЕ совпадает с выпиской'));
  assert.ok(fn.includes('Итоговый остаток в выписке не распознан'));
});


test('statement account binding keeps IBAN account and card keys',()=>{
  const keysFn=extractFunction('financeStatementBindingKeys');
  const boundFn=extractFunction('financeStatementBoundAccountId');
  const remember=extractFunction('financeStatementRememberAccount');
  assert.ok(keysFn.includes("statement?.iban"));
  assert.ok(keysFn.includes("statement?.accountNumber"));
  assert.ok(keysFn.includes("financeStatementCardNumber(statement)"));
  assert.ok(boundFn.includes("wanted=new Set(keys)"));
  assert.ok(remember.includes("bankStatementKeys=[...new Set([...keys,...bindingKeys])]"));
  assert.ok(remember.includes("keys:bindingKeys"));
});

test('all finance accounts can store editable IBAN and card identifiers',()=>{
  assert.ok(html.includes('id="financeAccountIban"'));
  assert.ok(html.includes('id="financeAccountCard"'));
  const save=extractFunction('saveFinanceAccount');
  assert.ok(save.includes("account.iban=iban"));
  assert.ok(save.includes("account.cardNumber=cardNumber"));
  assert.ok(save.includes("bankStatementAccountNumber=iban"));
  assert.ok(save.includes("bankStatementCardNumber=cardNumber"));
});


test('finance journal uses category or account as the primary label',()=>{
  const fn=extractFunction('renderFinanceTransactions');
  assert.ok(fn.includes("displayTitle=x?.refundOfId?(category||account||rawTitle||'Возврат')"));
  assert.ok(fn.includes("type==='transfer'?(account+' → '+to)"));
  assert.ok(fn.includes("type==='adjustment'?(account||rawTitle||'Корректировка')"));
  assert.ok(fn.includes("category?(category):(account||rawTitle||'Операция')"));
  assert.ok(fn.includes("rawTitle&&rawTitle!==displayTitle?rawTitle:''"));
  assert.ok(fn.includes("esc(displayTitle)"));
});

test('new visible finance categories stay on the main analytics list at zero',()=>{
  const fn=extractFunction('renderFinanceBreakdown');
  assert.ok(fn.includes("visibleCategories=financeVisibleCategories().filter(c=>c.kind==='both'||c.kind===financeAnalyticsMode)"));
  assert.ok(fn.includes("groups.set(id,{id,filterId:id,name,amount:0,includeInTotal:c.includeInTotal!==false})"));
  assert.ok(fn.includes("filter(x=>x.amount>0||visibleIds.has(String(x.id)))"));
  assert.ok(fn.includes("r.amount>0?r.pct.toFixed"));
});


test('editing a finance category can change kind even when a legacy duplicate name exists',()=>{
  const fn=extractFunction('saveFinanceCategory');
  assert.ok(fn.includes("nameUnchanged=Boolean(current)"));
  assert.ok(fn.includes("const duplicate=(!categoryId||!nameUnchanged)?categories.find"));
  assert.ok(fn.includes("current.kind=kind"));
});


test('legacy category text resolves into the single active category with the same name',()=>{
  const resolve=extractFunction('financeResolveEffectiveCategory');
  const byName=extractFunction('financeResolveCategoryByName');
  assert.ok(byName.includes("matches.length===1?matches[0]:null"));
  assert.ok(resolve.includes("financeResolveCategoryByName(name)"));
  assert.ok(resolve.includes("categoryId:String(match.id)"));
});

test('finance categories can be merged by moving operations and deleting the source',()=>{
  const open=extractFunction('financeMoveCategoryOperations');
  const run=extractFunction('financeExecuteMoveCategoryOperations');
  const del=extractFunction('financeDeleteCategory');
  assert.ok(open.includes('Объединить категории'));
  assert.ok(run.includes("categoryId:String(target.id)"));
  assert.ok(run.includes("category:String(target.name)"));
  assert.ok(run.includes("financeCategories().splice(index,1)"));
  assert.ok(run.includes("'/move-operations'"));
  assert.ok(run.includes("deleteSource:true"));
  assert.ok(del.includes("if(used){financeMoveCategoryOperations(categoryId);return}"));
  assert.ok(html.includes('Объединить / перенести операции'));
});
