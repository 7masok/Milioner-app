import test from 'node:test';
import {withFboPage} from '../src/fbo-page.js';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../../ozon-supplies-v1.js',import.meta.url),'utf8');
const supply=(id='s',state='IN_TRANSIT',qty=50)=>({supply_id:id,bundle_id:'b'+id,state,items:[{sku:'sku'+id,quantity:qty,name:'Товар'}]});
const order=(id='o',status='IN_TRANSIT',supplies=[supply()])=>({order_id:id,order_number:'Заявка '+id,state:status,supplies});
function fixture(rows=[],settings={}){
 const state={products:[],settings},responses={accounts:[{account:'a',label:'Ozon',supplies:{rows}}]},sheets=[];
 const window={},ctx={window,state,Date,console,Map,Set,esc:s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;'),MILLIONER_API:'https://fixture.invalid',apiJson:async url=>url.includes('/ozon-supply-order')?{label:'Ozon',order:rows.find(x=>x.order_id===new URL(url).searchParams.get('orderId'))}:responses,showSheet:html=>sheets.push(html),setInterval(){},MutationObserver:class{observe(){}},document:{readyState:'loading',getElementById:()=>null,addEventListener(){}},confirm:()=>assert.fail('view must not confirm a stock write'),save:()=>assert.fail('view must not save'),render:()=>assert.fail('view must not render warehouse'),log:()=>assert.fail('view must not log stock'),fifoConsume:()=>assert.fail('view must not consume FIFO')};
 vm.createContext(ctx);vm.runInContext(source.replace(/\}\)\(\);\s*$/,'window.testApi={supplyListSection,accountingSummary,accountingHtml,transferKey};})();'),ctx);
 return{window,state,sheets,responses,api:window.testApi,html:()=>sheets.at(-1)};
}
function marker(f,o,s,qty=50,account='a'){
 const key=f.api.transferKey(account,o.order_id,s.supply_id,s.bundle_id,s.items[0].sku);
 f.state.settings.ozonFboTransfers||={};f.state.settings.ozonFboTransfers[key]={account,orderId:o.order_id,qty,productId:'p'};return key;
}
test('only dispatched/acceptance orders are active; preparation is hidden and terminal states archived',()=>{
 const f=fixture();
 for(const status of ['IN_TRANSIT','ACCEPTED_AT_SUPPLY_WAREHOUSE','ACCEPTANCE_AT_STORAGE_WAREHOUSE','REPORTS_CONFIRMATION_AWAITING','REPORT_REJECTED'])assert.equal(f.api.supplyListSection(order('o',status,[])),'active');
 for(const status of ['READY_TO_SUPPLY','DATA_FILLING','TIMESLOT_BOOKING','SUPPLY_VARIANTS_ARRANGING','unknown'])assert.equal(f.api.supplyListSection(order('o',status,[])),null);
 for(const status of ['COMPLETED','CANCELLED','REJECTED_AT_SUPPLY_WAREHOUSE','OVERDUE'])assert.equal(f.api.supplyListSection(order('o',status,[])),'history');
});
test('mixed destinations remain active until all delivered; parent terminal state is authoritative',()=>{
 const f=fixture();assert.equal(f.api.supplyListSection(order('o','IN_TRANSIT',[supply('1','COMPLETED'),supply('2','IN_TRANSIT')])),'active');
 assert.equal(f.api.supplyListSection(order('o','IN_TRANSIT',[supply('1','COMPLETED'),supply('2','CANCELLED')])),'history');
 assert.equal(f.api.supplyListSection(order('o','COMPLETED',[supply('1','IN_TRANSIT')])),'history');
});
test('list shows accounting without opening, separates history and does not mutate warehouse state',async()=>{
 const active=order('active'),done=order('delivered','COMPLETED'),cancel=order('cancelled','CANCELLED'),draft=order('draft','READY_TO_SUPPLY',[]),f=fixture([active,done,cancel,draft]);
 marker(f,active,active.supplies[0]);const before=JSON.stringify(f.state);
 await f.window.openOzonFboSupplies();let html=f.html();assert.match(html,/Заявка active/);assert.match(html,/<b>Учтено<\/b>/);assert.match(html,/50 из 50/);
 for(const name of ['delivered','cancelled','draft'])assert.doesNotMatch(html,new RegExp('Заявка '+name));
 f.window.setOzonFboSupplyListView('history');html=f.html();assert.match(html,/Заявка delivered/);assert.match(html,/Доставлено/);assert.match(html,/Заявка cancelled/);assert.match(html,/Не учтено/);assert.doesNotMatch(html,/Заявка active/);
 assert.equal(JSON.stringify(f.state),before);
});
test('accounting matches cabinet, order, destination and SKU and checks actual quantities',()=>{
 const o=order('o','IN_TRANSIT',[supply('1'),supply('2')]),f=fixture([o]);
 assert.equal(f.api.accountingSummary('a',o).status,'none');
 marker(f,o,o.supplies[0],50,'other');assert.equal(f.api.accountingSummary('a',o).status,'none');
 marker(f,o,o.supplies[0]);assert.equal(f.api.accountingSummary('a',o).status,'partial');assert.equal(f.api.accountingSummary('a',o).recordedQty,50);
 const key=marker(f,o,o.supplies[1],40);assert.equal(f.api.accountingSummary('a',o).status,'partial');
 f.state.settings.ozonFboTransfers[key].qty=50;assert.equal(f.api.accountingSummary('a',o).status,'complete');
 f.state.settings.ozonFboTransfers[key].qty=60;assert.equal(f.api.accountingSummary('a',o).status,'partial');
 assert.equal(f.api.accountingSummary('a',order('different')).status,'none');
});
test('partial/missing composition never claims a fully accounted shipment',()=>{
 const o=order(),f=fixture([o]);marker(f,o,o.supplies[0]);
 o.supplies[0].bundle_pending=true;assert.equal(f.api.accountingSummary('a',o).status,'unknown');assert.match(f.api.accountingHtml('a',o),/Учтено 50 шт./);assert.match(f.api.accountingHtml('a',o),/состав уточняется/);
 assert.doesNotMatch(f.api.accountingHtml('a',o),/<b>Учтено<\/b>/);
 o.supplies[0].items=[];assert.equal(f.api.accountingSummary('a',o).status,'unknown');
 const empty=fixture([o]);assert.equal(empty.api.accountingSummary('a',o).status,'none');assert.deepEqual(empty.state.settings,{});
});
test('details retain history view, show remaining quantity, and hide bulk action when already accounted',async()=>{
 const o=order('done','COMPLETED',[supply('1'),supply('2')]),f=fixture([o]);marker(f,o,o.supplies[0]);
 await f.window.openOzonFboSupplies();f.window.setOzonFboSupplyListView('history');
 await f.window.openOzonFboSupplyOrder('a','done');assert.match(f.html(),/Частично учтено/);assert.match(f.html(),/Учесть оставшееся · 50 шт./);assert.match(f.html(),/Учтено 50 из 50 шт./);
 marker(f,o,o.supplies[1]);await f.window.openOzonFboSupplyOrder('a','done');assert.doesNotMatch(f.html(),/onclick="accountWholeOzonFboOrder/);
 f.window.showOzonFboSupplyList();assert.match(f.html(),/aria-pressed="true" onclick="setOzonFboSupplyListView\('history'\)/);assert.match(f.html(),/<b>Учтено<\/b>/);
});

test('served purchases have no FBO button and accounting remains available from the FBO view',()=>{
 const html=withFboPage(readFileSync(new URL('../../index.html',import.meta.url),'utf8'));
 assert.doesNotMatch(html,/id="ozonFboSuppliesBtn"/);assert.match(html,/<section id="fbo"/);assert.equal(typeof fixture().window.openOzonFboSupplies,'function');
});

test('FBO entry scopes account through history and direct order return; legacy entry resets scope',async()=>{
 const a=order('first'),b=order('other'),f=fixture([a,order('old','COMPLETED')]);
 f.responses.accounts.push({account:'b',label:'Другой магазин',supplies:{rows:[b,order('otherOld','COMPLETED')]}});
 await f.window.openOzonFboSupplies('a');assert.match(f.html(),/Заявка first/);assert.doesNotMatch(f.html(),/Заявка other/);
 f.window.setOzonFboSupplyListView('history');assert.match(f.html(),/Заявка old/);assert.doesNotMatch(f.html(),/otherOld/);
 await f.window.openOzonFboSupplyOrder('a','first',true);f.window.showOzonFboSupplyList();assert.match(f.html(),/Заявка first/);assert.doesNotMatch(f.html(),/Заявка other/);
 await f.window.openOzonFboSupplies();assert.match(f.html(),/Заявка other/);
});
