import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const core = await fs.readFile(new URL('../../finances/core.js', import.meta.url), 'utf8');
const statements = await fs.readFile(new URL('../../finances/statements.js', import.meta.url), 'utf8');
function harness(saved = {}) {
  const nodes = new Map(), store = new Map(Object.entries(saved));
  const element = (id, values = [], value = '') => {
    const node = {id, value, tagName: values.length ? 'SELECT' : 'INPUT', type: id.includes('From') || id.includes('To') ? 'date' : '', options: values.map(([value, textContent]) => ({value, textContent})), disabled: false, textContent: '', innerHTML: '', hidden: false};
    Object.defineProperty(node, 'selectedOptions', {get: () => node.options.filter(o => o.value === node.value)});
    nodes.set(id, node); return node;
  };
  element('financePeriodFilter', [['custom', 'Свой период'], ['all', 'Всё время'], ['month', 'Этот месяц']], 'custom');
  element('financeTypeFilter', ['all','expense','income','transfer','transit','adjustment'].map(v => [v,v]), 'all');
  element('financeAccountFilter', [['all','Все счета'], ['a','Kaspi'], ['b','BCC']], 'a');
  element('financeCategoryFilter', [['all','Все категории'], ['c','Газмяс'], ['__uncategorized__','Без категории']], 'c');
  element('financeStatementFrom', [], '2026-10-01'); element('financeStatementTo', [], '2026-10-07');
  element('financeStatementFormat', [['csv','Таблица'], ['html','Документ']], 'csv');
  for (const id of ['financeCustomPeriod','financeStatementSummary','financeStatementSave','financeStatementStatus','financeTransactions']) element(id);
  const rows = [
    {id:'first',date:'01.10.2026',createdAt:Date.parse('2026-10-11'),type:'expense',amount:100,accountId:'a',categoryId:'c',title:'Первый'},
    {id:'last',date:'07.10.2026',statementTime:'23:59:59',type:'expense',amount:200.25,accountId:'a',categoryId:'c',title:'=HYPERLINK("bad")',note:'<img src=x onerror=bad>'},
    {id:'next',date:'08.10.2026',type:'expense',amount:900,accountId:'a',categoryId:'c'},
    {id:'other',date:'04.10.2026',type:'expense',amount:300,accountId:'b',categoryId:'c'},
    {id:'category',date:'04.10.2026',type:'income',amount:25,accountId:'a'},
    {id:'transfer',date:'05.10.2026',type:'transfer',amount:1000,accountId:'a',toAccountId:'b',currency:'KZT',toAmount:2.1,toCurrency:'USD'},
    {id:'refund',date:'06.10.2026',type:'income',amount:50,accountId:'a',refundOfId:'first'},
    {id:'transit',date:'03.10.2026',type:'transit_in',amount:33.5,accountId:'a'},
    {id:'undated',type:'expense',amount:999,accountId:'a',categoryId:'c'}
  ];
  let listener, downloaded;
  const c = {document:{getElementById:id=>nodes.get(id), addEventListener:(_type,fn)=>listener=fn}, localStorage:{getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v)}, console, Date, Intl, Map, Set, Number, String, Array, Object, JSON, setTimeout() {}};
  c.window=c; c.AndroidFinances={saveStatement:async(text,name,mime)=>downloaded={text,name,mime}};
  vm.createContext(c);
  vm.runInContext("const KEY='fixture';const state={settings:{}};const esc=s=>String(s??'').replace(/[&<>\"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#039;'}[m]));const fmt=n=>String(n);function saveLocalOnly(){throw Error('write forbidden')}function queueFinanceCacheWrite(){throw Error('write forbidden')}",c);
  vm.runInContext(core,c);
  c.fixture=rows;
  vm.runInContext("state.settings={personalFinanceAccounts:[{id:'a',name:'Kaspi'},{id:'b',name:'BCC'}],personalFinanceCategories:[{id:'c',name:'Газмяс',kind:'both'}],personalFinanceTransactions:fixture};financeHydrated=true",c);
  vm.runInContext(statements,c);
  const original=vm.runInContext('JSON.stringify(state)',c);
  return {c,nodes,store,original,download:()=>downloaded,ids:()=>Array.from(c.financeFilteredTransactions(),x=>x.id),change(id,v){nodes.get(id).value=v;listener({target:nodes.get(id)})}};
}

test('custom range includes both calendar boundaries, uses payment date over import date, combines filters and does not write ledger',()=>{
  const h=harness();h.c.renderFinanceTransactions();assert.deepEqual(h.ids(),['last','refund','first']);
  assert.match(h.nodes.get('financeStatementSummary').textContent,/300,25/);
  h.change('financeTypeFilter','expense');assert.deepEqual(h.ids(),['last','refund','first']);
  h.change('financeAccountFilter','b');assert.deepEqual(h.ids(),['other']);
  assert.equal(vm.runInContext('JSON.stringify(state)',h.c),h.original);
});
test('incoming cross-currency transfer uses credited amount and currency; transit has own type filter',async()=>{
  const h=harness();h.change('financeCategoryFilter','all');h.change('financeAccountFilter','b');h.change('financeTypeFilter','transfer');
  assert.deepEqual(h.ids(),['transfer']);assert.match(h.nodes.get('financeStatementSummary').textContent,/Поступления: 2,1 USD/);
  await h.c.financeSaveStatement();assert.match(h.download().text,/"Поступления";"2.1";"USD"/);
  h.change('financeAccountFilter','a');h.change('financeTypeFilter','transit');assert.deepEqual(h.ids(),['transit']);
});
test('invalid/reversed dates block export instead of exporting all history',async()=>{
  const h=harness();h.change('financeStatementFrom','2026-10-08');assert.deepEqual(h.ids(),[]);assert.equal(h.nodes.get('financeStatementSave').disabled,true);
  await h.c.financeSaveStatement();assert.equal(h.download(),undefined);assert.match(h.nodes.get('financeStatementStatus').textContent,/начала/);
  h.change('financeStatementFrom','2026-02-30');assert.deepEqual(h.ids(),[]);
});
test('filters and dates survive reload independently of analytical chart preferences',()=>{
  const h=harness();h.change('financeStatementFrom','2026-10-04');h.change('financeAccountFilter','b');
  const next=harness(Object.fromEntries(h.store));next.c.renderFinanceTransactions();assert.equal(next.nodes.get('financeStatementFrom').value,'2026-10-04');assert.equal(next.nodes.get('financeAccountFilter').value,'b');assert.deepEqual(next.ids(),['other']);
});
test('CSV preserves selected rows, cents and Cyrillic while neutralizing formulas; HTML escapes user content',async()=>{
  const h=harness();h.c.renderFinanceTransactions();await h.c.financeSaveStatement();const csv=h.download();
  assert.equal(csv.mime,'text/csv');assert.equal(csv.text[0],'\uFEFF');assert.match(csv.text,/Газмяс/);assert.match(csv.text,/"200.25"/);assert.match(csv.text,/"'=HYPERLINK/);assert.doesNotMatch(csv.text,/"900"/);assert.equal(csv.name,'statement-2026-10-01-2026-10-07.csv');
  h.nodes.get('financeStatementFormat').value='html';await h.c.financeSaveStatement();const html=h.download();assert.equal(html.mime,'text/html');assert.match(html.text,/&lt;img/);assert.doesNotMatch(html.text,/<img/);assert.equal(vm.runInContext('JSON.stringify(state)',h.c),h.original);
});
