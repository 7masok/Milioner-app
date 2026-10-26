import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../../kaspi-report-v2.js',import.meta.url),'utf8');
const line=name=>source.split('\n').find(x=>x.startsWith('function '+name+'('));
function fixture(){let saved=null,sheet='',fetches=0;const root={rows:[],querySelectorAll(){return this.rows},appendChild(row){this.rows=this.rows.filter(x=>x!==row);this.rows.push(row)}};const ctx={localStorage:{getItem:()=>saved,setItem:(_k,v)=>saved=v},document:{querySelector:s=>s==='[data-report-profit-products]'?root:null,querySelectorAll:()=>[]},esc:String,money:n=>String(n)+' ₸',storeTitle:()=> 'Kaspi',detailPeriodHtml:()=>'',showSheet:s=>{sheet=s},fetch:()=>fetches++};vm.createContext(ctx);vm.runInContext(['storeProfitSortSpec','storeProfitSortControls','compareStoreProfitRows','sortStoreProfitRows','setStoreProfitSort','paintStoreSheet'].map(line).join('\n'),ctx);return {ctx,root,get sheet(){return sheet},get saved(){return saved},get fetches(){return fetches}}}
const row=(id,total,unit)=>({dataset:{profitRow:id,totalProfit:total,unitProfit:unit,productName:id},open:true,orders:{loaded:true},querySelector:()=>null});
test('total and unit profit sort signed numeric amounts in both directions, unknown stays last',()=>{
 const f=fixture(),a=row('a','1000','10'),b=row('b','200','100'),loss=row('loss','-30','-3'),unknown=row('unknown','','');f.root.rows=[a,b,loss,unknown];
 f.ctx.sortStoreProfitRows();assert.deepEqual(f.root.rows.map(x=>x.dataset.profitRow),['a','b','loss','unknown']);
 f.ctx.setStoreProfitSort('unit');assert.deepEqual(f.root.rows.map(x=>x.dataset.profitRow),['b','a','loss','unknown']);
 f.ctx.setStoreProfitSort('direction');assert.deepEqual(f.root.rows.map(x=>x.dataset.profitRow),['loss','a','b','unknown']);
 assert.equal(JSON.parse(f.saved).direction,'asc');assert.equal(f.fetches,0);assert.ok(f.root.rows.includes(a));assert.equal(a.open,true);assert.equal(a.orders.loaded,true);
 assert.match(f.ctx.storeProfitSortControls(),/↑/);assert.match(f.ctx.storeProfitSortControls(),/От меньшей прибыли к большей/);
});
test('Kaspi sheet exposes numeric values and unit profits without parsing formatted money or mutating report',()=>{
 const f=fixture(),view={products:[{productKey:'a',name:'A',qty:8,profitValue:2645.6,profit:'≈ 2 645,6 ₸',sales:'7 920 ₸',cost:'2 300 ₸',fees:'1 690 ₸',ads:'1 283 ₸',breakdown:[]},{productKey:'b',name:'Unknown',qty:1,profitValue:null,profit:'—',breakdown:[]},{productKey:'c',name:'Returns only',qty:0,profitValue:-40,profit:'-40 ₸',breakdown:[]}]},before=JSON.stringify(view);
 f.ctx.paintStoreSheet('Kaspi',30,view);
 assert.match(f.sheet,/Общая прибыль/);assert.match(f.sheet,/За штуку/);assert.match(f.sheet,/data-total-profit="2645.6" data-unit-profit="330.7"/);assert.match(f.sheet,/Прибыль \/ шт.: ≈ 330.7 ₸/);assert.match(f.sheet,/data-total-profit="" data-unit-profit=""/);assert.match(f.sheet,/data-total-profit="-40" data-unit-profit=""/);assert.equal(JSON.stringify(view),before);
});
test('other store sheets retain their current controls',()=>{const f=fixture();f.ctx.paintStoreSheet('WB',1,{products:[{name:'WB',qty:1,profitValue:2,profit:'2'}]});assert.doesNotMatch(f.sheet,/data-store-profit-sort/)});

test('sort still switches when local preference storage is unavailable',()=>{const f=fixture();f.ctx.localStorage.setItem=()=>{throw Error('quota')};f.root.rows=[row('a','1000','10'),row('b','200','100')];f.ctx.setStoreProfitSort('unit');assert.deepEqual(f.root.rows.map(x=>x.dataset.profitRow),['b','a'])});
