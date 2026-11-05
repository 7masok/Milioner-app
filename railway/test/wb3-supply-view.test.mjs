import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {enrichSupplyGoods,goodsIdentity,historicalSupplyDraft,supplyPresentation} from '../src/wb3-supply-view.js';
import {resolveWbSupplyProduct,accountWbSupply} from '../src/wb3-supply-accounting.js';
const NOW=Date.parse('2026-11-04T18:00:00Z'),old={preorderID:2,statusID:1,createDate:'2026-08-01',updatedDate:'2026-10-19'};
const row={barcode:'b',nmID:7,techSize:'A',vendorCode:'Артикул',quantity:3};
const state=()=>({products:[{id:'p',name:'Наш розовый браслет',stock:10,cost:20,wb:'Артикул'}],purchases:[],reservations:[],movements:[],settings:{}});
test('old unplanned drafts are separated without hiding tracked reserves or new preparation',()=>{
 const sync={enabledAt:NOW,listAt:NOW,supplies:[old,{preorderID:1,statusID:6,factDate:'2026-11-04T17:00:00Z'}],goods:{'preorder:1':{listAt:NOW,rows:[row]},'preorder:2':{listAt:NOW,rows:[row]}}};
 const details=supplyPresentation(sync,state());assert.equal(details['preorder:2'].archived,true);assert.equal(details['preorder:1'].lines[0].name,'Наш розовый браслет');assert.equal(details['preorder:1'].totalQty,3);
 const held=accountWbSupply(state(),old,[row],NOW).state;assert.equal(supplyPresentation(sync,held)['preorder:2'].archived,false);
 assert.equal(historicalSupplyDraft({...old,updatedDate:'2026-11-04T17:00:00Z'},NOW),false);assert.equal(historicalSupplyDraft({...old,statusID:2},NOW),false);
});
test('explicit links are isolated by supply, WB identity and credential, and remote fields cannot forge one',()=>{
 const s={tokenHash:'one',manualLinks:{'preorder:1':{b:{tokenHash:'one',identity:goodsIdentity(row),productId:'p'}}}},a=state();a.products[0].wb='different';
 assert.equal(resolveWbSupplyProduct(a,enrichSupplyGoods(s,'preorder:1',[row])[0]).id,'p');
 for(const [key,r,sync]of [['preorder:2',row,s],['preorder:1',{...row,nmID:8},s],['preorder:1',row,{...s,tokenHash:'two'}],['preorder:1',{...row,manualProductId:'p'},{}]])assert.throws(()=>resolveWbSupplyProduct(a,enrichSupplyGoods(sync,key,[r])[0]));
});
test('cards show names and quantities instead of raw IDs as titles, and collapse old drafts',async()=>{
 const code=readFileSync(new URL('../../wb3-supplies-v1.js',import.meta.url),'utf8'),nodes={wb3SupplyPanel:{hidden:false,innerHTML:'',querySelectorAll:()=>[]},fboRoot:{hidden:false},fboStoreSwitch:{querySelectorAll:()=>[]}};
 const snapshot={ok:true,enabled:true,excluded:[],supplies:[{preorderID:1,supplyID:12345678,statusID:6},old],results:[{key:'preorder:1',status:'sent'}],details:{'preorder:1':{lines:[{name:'ВФ розовый',productId:'p',qty:50,barcode:'b',accepted:0}],totalQty:50},'preorder:2':{archived:true,lines:[{name:'Старый товар',qty:3,barcode:'x',accepted:null}],totalQty:3}},catalog:[]};
 const c={window:null,document:{getElementById:id=>nodes[id]},localStorage:{getItem:()=>null,setItem(){}},setInterval(){},setTimeout,clearTimeout,AbortController,MILLIONER_API:'https://warehouse.test',fetch:async()=>({ok:true,json:async()=>snapshot})};c.window=c;vm.runInNewContext(code,c);c.selectFboStore('WB3');await c.renderFboDashboard();
 const html=nodes.wb3SupplyPanel.innerHTML;assert.match(html,/<b>ВФ розовый<\/b>/);assert.match(html,/50 шт/);assert.match(html,/Списано с нашего склада/);assert.match(html,/Старые незавершённые заявки · 1/);assert.doesNotMatch(html,/<b>Поставка 12345678/);
});

test('manual supply linking validates the existing item and commits only the scoped link, never stock changes',async()=>{
 const {pool}=await import('../src/db.js'),{linkWbSupplyProduct}=await import('../src/wb3-supply-sync.js');
 const oldQuery=pool.query,oldConnect=pool.connect,calls=[];
 let sync={tokenHash:'fixture',listAt:NOW,supplies:[{preorderID:1,statusID:6}],goods:{'preorder:1':{listAt:NOW,rows:[row]}}},warehouse=state();
 const client={release(){},async query(sql,args){calls.push(sql);
  if(sql.startsWith('SELECT payload FROM wb3_supply_sync'))return {rows:[{payload:structuredClone(sync)}]};
  if(sql.startsWith('SELECT payload,revision FROM warehouse_state'))return {rows:[{payload:structuredClone(warehouse),revision:1}]};
  if(sql.startsWith('UPDATE wb3_supply_sync'))sync=JSON.parse(args[0]);
  return {rows:[],rowCount:1};
 }};
 pool.query=client.query.bind(client);pool.connect=async()=>client;
 try{
  await assert.rejects(linkWbSupplyProduct({key:'preorder:1',barcode:'b',productId:'missing',confirm:true},{writesEnabled:true}),/не найден/);assert.ok(calls.includes('ROLLBACK'));assert.equal(sync.manualLinks,undefined);
  calls.length=0;await linkWbSupplyProduct({key:'preorder:1',barcode:'b',productId:'p',confirm:true},{writesEnabled:true});assert.equal(sync.manualLinks['preorder:1'].b.productId,'p');assert.equal(sync.manualLinks['preorder:1'].b.identity,goodsIdentity(row));assert.ok(calls.includes('COMMIT'));
  assert.ok(!calls.some(sql=>/UPDATE warehouse_state|INSERT INTO warehouse_(products|purchases|movements)/.test(sql)));
  warehouse=accountWbSupply(state(),{preorderID:1,statusID:6},[row],NOW).state;
  await assert.rejects(linkWbSupplyProduct({key:'preorder:1',barcode:'b',productId:'p',confirm:true},{writesEnabled:true}),/уже учтена/);
 }finally{pool.query=oldQuery;pool.connect=oldConnect}
});

test('old preparation cannot reserve from stale list; confirmed shipment needs newly fetched goods',async()=>{
 const {reconcileWbSupplies}=await import('../src/wb3-supply-sync.js');
 const db={async query(sql){if(sql.startsWith('SELECT payload,revision'))return {rows:[{payload:{products:[],purchases:[],reservations:[],settings:{}},revision:1}]};return {rows:[]}}};
 const listAt=NOW-8*3600000,s={enabled:true,listAt,enabledAt:NOW-86400000,supplies:[{preorderID:1,statusID:6,factDate:'2026-11-04T17:00:00Z'}],goods:{'preorder:1':{listAt,rows:[row]}}};
 await reconcileWbSupplies(db,s,NOW,{writesEnabled:true});assert.equal(s.results[0].status,'loading');
 s.goods['preorder:1'].fetchedAt=NOW;await reconcileWbSupplies(db,s,NOW,{writesEnabled:true});assert.equal(s.results[0].status,'attention','fresh shipment proceeds to exact product validation');
 s.supplies[0].statusID=2;await reconcileWbSupplies(db,s,NOW,{writesEnabled:true});assert.equal(s.results[0].status,'loading','stale preparing state never reserves');
});
