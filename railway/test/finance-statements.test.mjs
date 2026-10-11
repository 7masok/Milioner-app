import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const core = await fs.readFile(new URL('../../finances/core.js', import.meta.url), 'utf8');
const statements = await fs.readFile(new URL('../../finances/statements.js', import.meta.url), 'utf8');
const excelTemplate = await fs.readFile(new URL('../../finances/excel-template.js', import.meta.url), 'utf8');
const excel = await fs.readFile(new URL('../../finances/excel.js', import.meta.url), 'utf8');
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
  element('financeStatementFormat', [['xlsx','Excel'], ['csv','CSV']], 'csv');
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
  const c = {document:{getElementById:id=>nodes.get(id), addEventListener:(_type,fn)=>listener=fn}, localStorage:{getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v)}, console, Date, Intl, Map, Set, Number, String, Array, Object, JSON, TextEncoder,Uint8Array,DataView,btoa:s=>Buffer.from(s,'binary').toString('base64'),setTimeout() {}};
  c.window=c; c.AndroidFinances={saveStatement:async(text,name,mime)=>downloaded={text,name,mime}};
  c.AndroidFinances.saveExcel=async(base64,name)=>downloaded={bytes:Buffer.from(base64,'base64'),name,mime:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'};
  vm.createContext(c);
  vm.runInContext("const KEY='fixture';const state={settings:{}};const esc=s=>String(s??'').replace(/[&<>\"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#039;'}[m]));const fmt=n=>String(n);function saveLocalOnly(){throw Error('write forbidden')}function queueFinanceCacheWrite(){throw Error('write forbidden')}",c);
  vm.runInContext(core,c);
  c.fixture=rows;
  vm.runInContext("state.settings={personalFinanceAccounts:[{id:'a',name:'Kaspi'},{id:'b',name:'BCC'}],personalFinanceCategories:[{id:'c',name:'Газмяс',kind:'both'}],personalFinanceTransactions:fixture};financeHydrated=true",c);
  vm.runInContext(excelTemplate,c);vm.runInContext(excel,c);vm.runInContext(statements,c);
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
test('CSV preserves selected rows, cents and Cyrillic while neutralizing formulas',async()=>{
  const h=harness();h.c.renderFinanceTransactions();await h.c.financeSaveStatement();const csv=h.download();
  assert.equal(csv.mime,'text/csv');assert.equal(csv.text[0],'\uFEFF');assert.match(csv.text,/Газмяс/);assert.match(csv.text,/"200.25"/);assert.match(csv.text,/"'=HYPERLINK/);assert.doesNotMatch(csv.text,/"900"/);assert.equal(csv.name,'statement-2026-10-01-2026-10-07.csv');
  assert.equal(vm.runInContext('JSON.stringify(state)',h.c),h.original);
});

function unzip(buffer){const files=new Map();let at=0;while(buffer.readUInt32LE(at)===0x04034b50){const size=buffer.readUInt32LE(at+18),n=buffer.readUInt16LE(at+26),extra=buffer.readUInt16LE(at+28);assert.equal(buffer.readUInt16LE(at+8),0);const name=buffer.toString('utf8',at+30,at+30+n),start=at+30+n+extra;files.set(name,buffer.toString('utf8',start,start+size));at=start+size;}return files;}
test('real Excel contains numeric dates/amounts, formulas, wide columns, filters and literal titles; empty metadata columns are absent',async()=>{
  const h=harness();h.nodes.get('financeStatementFormat').value='xlsx';h.c.renderFinanceTransactions();await h.c.financeSaveStatement();
  const out=h.download();assert.equal(out.name,'statement-2026-10-01-2026-10-07.xlsx');assert.equal(out.bytes.subarray(0,4).toString('hex'),'504b0304');
  const files=unzip(out.bytes),sheet=files.get('xl/worksheets/sheet1.xml');
  assert.ok(files.has('[Content_Types].xml'));assert.match(sheet,/<v>200.25<\/v>/);assert.match(sheet,/<v>46302<\/v>/);
  assert.match(sheet,/<t xml:space="preserve">=HYPERLINK/);assert.doesNotMatch(sheet,/<f>HYPERLINK/);assert.match(sheet,/&lt;img/);
  assert.match(sheet,/<f>SUMIFS\(/);assert.match(sheet,/state="frozen"/);assert.match(sheet,/<autoFilter /);assert.match(sheet,/width="48"/);
  assert.doesNotMatch(sheet,/Влияет на баланс|Другой счёт|Сумма зачисления перевода/);assert.equal(vm.runInContext('JSON.stringify(state)',h.c),h.original);
  if(process.env.FINANCE_XLSX_QA_OUTPUT)await fs.writeFile(process.env.FINANCE_XLSX_QA_OUTPUT,out.bytes);
});
test('Excel transfer legs and summary formulas keep KZT and USD separate, including zero expenses',async()=>{
  const h=harness();h.nodes.get('financeStatementFormat').value='xlsx';h.change('financeAccountFilter','all');h.change('financeCategoryFilter','all');h.change('financeTypeFilter','transfer');await h.c.financeSaveStatement();
  const sheet=unzip(h.download().bytes).get('xl/worksheets/sheet1.xml');assert.match(sheet,/<v>1000<\/v>/);assert.match(sheet,/<v>2.1<\/v>/);assert.match(sheet,/Итого KZT/);assert.match(sheet,/Итого USD/);assert.match(sheet,/Другой счёт/);
  assert.equal((sheet.match(/<f>SUMIFS\(/g)||[]).length,4);
});
