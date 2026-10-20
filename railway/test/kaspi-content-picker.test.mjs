import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../../kaspi-order-content-v1.js',import.meta.url),'utf8'),html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
function fixture(){
 const products=[{id:'a',name:'Исходный',kaspi:'111'},{id:'b',name:'Малина 6',kaspi:'222',ozonAliases:['SKU-ALIAS']},{id:'bundle',name:'Набор малины',bundle:true}];
 const elements=new Map(),calls=[];let screen='';
 for(let i=0;i<2;i++)for(const [key,value]of Object.entries({Product:'a',Qty:String(i+1),Choice:'Исходный',Picker:'',Search:'',Results:''}))elements.set('kaspiContent'+key+i,{value,textContent:value,innerHTML:'',open:true});
 elements.set('kaspiContentReason',{value:'Замена цвета'});elements.set('kaspiContentSave',{});
 const ctx={state:{products},MILLIONER_API:'https://fixture.invalid',warehouseLocalDirty:false,warehouseSaveInFlight:false,requireWarehouseEditReady:()=>true,isBundleProduct:p=>p.bundle===true,normalizeName:s=>String(s||'').toLowerCase().trim(),esc:s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),document:{getElementById:id=>elements.get(id)},showSheet:s=>screen=s,alert:s=>{throw Error(s)},closeModal(){},pullWarehouseFromServer:async()=>{},loadSharedOrderCache:async()=>{},render(){},fetch:async(url,opts)=>{calls.push({url,opts});return{ok:true,json:async()=>opts.method==='POST'?{ok:true}:{orderId:'order',code:'123',revision:5,signature:'fixture',items:[0,1].map(i=>({entryId:'entry'+i,productId:'a',qty:i+1,orderedQty:i+1,orderedName:'Исходный',version:1,history:[]}))}}}};
 ctx.window=ctx;vm.createContext(ctx);vm.runInContext(html.split('\n').find(l=>l.startsWith('function productSearchHaystack('))+'\n'+source,ctx);
 return{ctx,elements,calls,get screen(){return screen}};
}
test('the replacement chooser contains its search and results together without a native select',async()=>{
 const f=fixture();await f.ctx.openKaspiOrderContents('order');assert.match(f.screen,/<details id="kaspiContentPicker0"/);assert.match(f.screen,/aria-label="Поиск товара для замены"/);assert.doesNotMatch(f.screen,/<select/);assert.match(f.screen,/max-height:240px/);
 f.ctx.filterKaspiContentProducts(0,'SKU-ALIAS');assert.match(f.elements.get('kaspiContentResults0').innerHTML,/Малина 6/);assert.doesNotMatch(f.elements.get('kaspiContentResults0').innerHTML,/Исходный|Набор/);
 f.ctx.filterKaspiContentProducts(0,'ничего такого');assert.match(f.elements.get('kaspiContentResults0').innerHTML,/Товар не найден/);assert.equal(f.elements.get('kaspiContentProduct0').value,'a');assert.equal(f.calls.length,1);
});
test('selecting a search result changes only its draft row; the existing save posts that selection and original quantities',async()=>{
 const f=fixture();await f.ctx.openKaspiOrderContents('order');f.ctx.selectKaspiContentProduct(0,'b');assert.equal(f.elements.get('kaspiContentProduct0').value,'b');assert.equal(f.elements.get('kaspiContentChoice0').textContent,'Малина 6');assert.equal(f.elements.get('kaspiContentPicker0').open,false);assert.equal(f.elements.get('kaspiContentProduct1').value,'a');assert.equal(f.elements.get('kaspiContentQty0').value,'1');assert.equal(f.calls.length,1);
 f.ctx.selectKaspiContentProduct(0,'bundle');assert.equal(f.elements.get('kaspiContentProduct0').value,'b');
 await f.ctx.saveKaspiOrderContents();const body=JSON.parse(f.calls[1].opts.body);assert.deepEqual(body.items.map(x=>[x.entryId,x.productId,x.qty]),[['entry0','b',1],['entry1','a',2]]);assert.equal(body.revision,5);assert.equal(body.signature,'fixture');assert.equal(body.reason,'Замена цвета');
});
