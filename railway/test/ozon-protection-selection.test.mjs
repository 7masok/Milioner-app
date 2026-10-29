import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../../ozon-price-protection-v1.js',import.meta.url),'utf8');
const row=(sku,accountId='shop')=>({market:'Ozon',accountId,sku,remoteId:sku==='a'?'123':'456',name:'Товар '+sku,price:1000,currency:'KZT'});
function fixture(initial){
 const elements=new Map(),el=id=>{if(!elements.has(id))elements.set(id,{innerHTML:'',textContent:'',checked:false,indeterminate:false,disabled:false});return elements.get(id)},requests=[],sheets=[],alerts=[],responses=[],saved=[];
 const window={ozonProtectionRows:()=>initial,ozonProtectionSaved:(items)=>saved.push(items)},context={window,document:{getElementById:el,body:{contains:()=>true}},Date,AbortSignal,console,MILLIONER_API:'',showSheet:html=>sheets.push(html),closeModal(){},alert:message=>alerts.push(message),fetch:async(url,opts)=>{requests.push(JSON.parse(opts.body));const response=responses.shift()||{ok:true};return{ok:response.ok,json:async()=>response}}};
 vm.runInNewContext(source,context);window.renderOzonProtectionTools('Ozon',initial.map(row=>({row})));return{window,el,requests,sheets,alerts,responses,saved,submit:()=>el('ozonGuardBulkConfirm').onclick()};
}
test('bulk offers editable prices, select all/none, live count, and sends only selected frozen identities',async()=>{
 const f=fixture([row('a'),row('b')]);f.window.openOzonProtectionBulk();assert.match(f.sheets.at(-1),/Выбрать все/);assert.match(f.sheets.at(-1),/ozonGuardBulkPrice-0/);assert.equal(f.el('ozonGuardSelectAll').checked,true);
 f.window.ozonGuardSelectAll(false);assert.equal(f.el('ozonGuardBulkConfirm').disabled,true);assert.equal(f.el('ozonGuardCheck-0').checked,false);
 f.window.ozonGuardSelect(1,true);assert.equal(f.el('ozonGuardSelectAll').indeterminate,true);assert.equal(f.el('ozonGuardSelectedCount').textContent,'Выбрано 1 из 2');f.window.ozonGuardSetPrice(1,'2045.50');
 // A filter/shop refresh while the sheet is open must not replace its captured products.
 f.window.renderOzonProtectionTools('Ozon',[{row:row('new','other-shop')}]);await f.submit();assert.equal(f.requests.length,1);assert.deepEqual(f.requests[0],{confirm:true,enabled:true,accountId:'shop',items:[{sku:'b',remoteId:'456',price:2045.5,currency:'KZT'}]});
});
test('selected invalid prices block writes, unselected invalid prices do not, reselect all keeps edited prices',async()=>{
 const f=fixture([row('a'),row('b')]);f.window.openOzonProtectionBulk();f.window.ozonGuardSetPrice(0,'');await f.submit();assert.equal(f.requests.length,0);assert.match(f.alerts.at(-1),/Проверьте/);
 f.window.ozonGuardSelect(0,false);f.window.ozonGuardSetPrice(1,'990');await f.submit();assert.equal(f.requests[0].items.length,1);assert.equal(f.requests[0].items[0].sku,'b');assert.equal(f.requests[0].items[0].price,990);
 const all=fixture([row('a'),row('b')]);all.window.openOzonProtectionBulk();all.window.ozonGuardSetPrice(0,'2200');all.window.ozonGuardSelectAll(false);all.window.ozonGuardSelectAll(true);await all.submit();assert.equal(all.requests[0].items.length,2);assert.equal(all.requests[0].items[0].price,2200);
});
test('partial account success retains failed selections and edits, retry does not repeat confirmed products',async()=>{
 const f=fixture([row('a','one'),row('b','two')]);f.window.openOzonProtectionBulk();f.window.ozonGuardSetPrice(1,'1234');f.responses.push({ok:true},{ok:false,error:'temporary'});await f.submit();assert.equal(f.requests.length,2);assert.equal(f.el('ozonGuardSelectedCount').textContent,'Выбрано 1 из 2');assert.match(f.sheets.at(-1),/value="1234"/);
 await f.submit();assert.equal(f.requests.length,3);assert.equal(f.requests[2].accountId,'two');assert.equal(f.requests[2].items[0].price,1234);
});
