import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {stockLedgerViolation} from '../src/warehouse-ledger.js';
const modelSource=readFileSync(new URL('../../product-size-mode-model-v1.js',import.meta.url),'utf8');
const uiSource=readFileSync(new URL('../../product-size-mode-v1.js',import.meta.url),'utf8');
const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
const server=readFileSync(new URL('../src/server.js',import.meta.url),'utf8');
const context={};vm.createContext(context);vm.runInContext(modelSource,context);const M=context.ProductSizeModeModel;
const card={nmId:'123',vendorCode:'Новое кольцо',title:'Кольцо',sizes:[{size:'17',chrtId:71,barcode:'b17',barcodes:['b17','alt17'],amount:44},{size:'18',chrtId:72,barcode:'b18',barcodes:['b18'],amount:32}]};
const source={id:'old',name:'Кольцо голубой камень',kind:'simple',stock:5,cost:310,photo:'photo',category:'Кольца',kaspi:'keep-kaspi',wb:'',wb2:'keep-wb2',ozon:'keep-ozon',packagingRecipe:[{packagingId:'pack',qty:1}],wbRelinkRequired:{oldSku:'Кольцо голубой камень'}};
let serial=0;const makeId=()=> 'new-'+(++serial);
const clone=x=>JSON.parse(JSON.stringify(x));
test('legacy source stays in new group with original stock/history/FIFO/reservations; WB amounts never import stock',()=>{
 const products=[clone(source)],before=JSON.stringify(products),plan=M.plan(products,'old','WB',card,'legacy',makeId),old=plan.products.find(p=>p.id==='old'),group=plan.products.find(p=>p.id===plan.groupId);
 assert.equal(JSON.stringify(products),before);assert.equal(old.stock,5);assert.equal(old.cost,310);assert.equal(old.kaspi,'keep-kaspi');assert.equal(old.wb2,'keep-wb2');assert.equal(old.ozon,'keep-ozon');assert.deepEqual(clone(old.packagingRecipe),source.packagingRecipe);assert.equal(old.variantLabel,'Без размера · прежний учёт');assert.equal(old.wb,'');assert.equal(old.variantLegacyLink.market,'WB');assert.equal(group.stock,0);assert.equal(group.wb,'');assert.deepEqual(clone(plan.rows.map(r=>r.stock)),[0,0]);assert.equal(plan.created,2);
 const state={products,movements:[{id:'movement',type:'приход',productId:'old',qty:5}],purchases:[{id:'batch',productId:'old',remainingQty:5}],sales:[{id:'sale',productId:'old'}],reservations:[{productId:'old',qty:1,active:true}]},next={...state,products:plan.products};assert.equal(stockLedgerViolation(state,next),null);for(const key of ['movements','purchases','sales','reservations'])assert.equal(next[key],state[key]);
});
test('owner may explicitly assign old card to a size without changing its product ID or count',()=>{const p=M.plan([source],'old','WB',card,'72',makeId),old=p.products.find(x=>x.id==='old');assert.equal(old.stock,5);assert.equal(old.wb,'b18');assert.equal(old.wbVariant.size,'18');assert.equal(old.wbRelinkRequired,undefined);assert.equal(p.legacy,false);assert.equal(p.created,1);assert.equal(old.id,'old')});
test('exact existing child reuses stock and identity, repeated group setup creates no duplicates',()=>{
 const existing={id:'existing',name:'Размер 17',stock:9,wb:'alt17',wbAliases:[],wbVariant:{market:'WB',nmId:'123',chrtId:71,barcode:'alt17',size:'17'}};
 const p=M.plan([source,existing],'old','WB',card,'legacy',makeId);assert.equal(p.rows[0].id,'existing');assert.equal(p.rows[0].stock,9);assert.equal(p.created,1);
 const again=M.plan(p.products,p.groupId,'WB',card,'auto',makeId);assert.equal(again.products.length,p.products.length);assert.equal(again.created,0);assert.equal(again.groupId,p.groupId);assert.equal(again.products.find(x=>x.id==='existing').stock,9);
});
test('duplicates, conflicting characteristics, other groups and other cabinets fail before mutation',()=>{
 const a={id:'a',name:'a',stock:1,wb:'b17'},b={...a,id:'b'};
 for(const products of [[source,a,b],[source,{...a,variantGroupId:'foreign'}],[source,{...a,wbVariant:{market:'WB',nmId:'different',chrtId:71}}]])assert.throws(()=>M.plan(products,'old','WB',card,'legacy',makeId));
 assert.throws(()=>M.plan([{...source,wbVariant:{market:'WB2',nmId:'123',chrtId:71}}],'old','WB',card,'legacy',makeId),/другого WB/);
 assert.throws(()=>M.plan([source],'old','WB',{...card,sizes:[card.sizes[0],card.sizes[0]]},'legacy',makeId),/неоднозначные/);
 const exact={...source,wb:'b17',wbVariant:{market:'WB',nmId:'123',chrtId:71}};assert.throws(()=>M.plan([exact],'old','WB',card,'72',makeId),/уже подтверждён/);
 assert.throws(()=>M.plan([source,a],'old','WB',card,'71',makeId),/свой товар/);
});
test('WB2 sizes use only WB2 barcode namespace and preserve WB1 generic link',()=>{const p=M.plan([{...source,wb:'keep-wb1',wb2:''},{id:'wb1',wb:'b17',stock:8}],'old','WB2',card,'72',makeId),old=p.products.find(x=>x.id==='old');assert.equal(old.wb,'keep-wb1');assert.equal(old.wb2,'b18');assert.equal(old.wbVariant.market,'WB2');assert.equal(p.rows[0].created,true)});
function uiFixture({backupOk=true,pushOk=true,ready=true}={}){
 const boxes={productSizeQuery:{value:'Кольцо'},productSizeCards:{innerHTML:''},productSizeStatus:{textContent:''},productSizeApply:{disabled:false,isConnected:true}};let sheet='',posts=0,saves=0,pushes=0,opened=null;
 const ctx={ProductSizeModeModel:M,window:{},state:{products:[clone(source)]},prod:id=>ctx.state.products.find(p=>p.id===id),isBundleProduct:p=>p.kind==='bundle',requireWarehouseEditReady:()=>ready,esc:s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('\"','&quot;').replaceAll("'",'&#039;'),showSheet:s=>{sheet=s},document:{getElementById:id=>boxes[id]||null},MILLIONER_API:'https://fixture.invalid',AbortController,setTimeout,clearTimeout,id:makeId,warehouseSaveInFlight:false,warehouseLocalDirty:false,warehouseSaveTimer:null,save:()=>{saves++;return true},pushWarehouseToServer:async()=>{pushes++;return pushOk},render(){},openProduct:id=>opened=id,fetch:async(url,options)=>{if(options?.method==='POST'){posts++;return {ok:backupOk,json:async()=>({ok:backupOk,backup:{id:1}})}}return {ok:true,json:async()=>({ok:true,cards:[card]})}}};vm.createContext(ctx);vm.runInContext(uiSource,ctx);
 return {ctx,boxes,get sheet(){return sheet},get posts(){return posts},get saves(){return saves},get pushes(){return pushes},get opened(){return opened},async preview(){ctx.window.openProductSizeMode('old');await ctx.window.searchProductSizes();ctx.window.previewProductSizeCard(0)}};
}
test('search and preview are read-only; applying creates backup then confirms one save despite double click',async()=>{const f=uiFixture(),before=JSON.stringify(f.ctx.state);await f.preview();assert.match(f.sheet,/Проверить размеры/);assert.match(f.sheet,/Без размера/);assert.equal(f.saves,0);assert.equal(f.posts,0);assert.equal(JSON.stringify(f.ctx.state),before);await Promise.all([f.ctx.window.applyProductSizeMode(),f.ctx.window.applyProductSizeMode()]);assert.equal(f.posts,1);assert.equal(f.saves,1);assert.equal(f.pushes,1);assert.ok(f.opened);assert.equal(f.ctx.state.products.find(p=>p.id==='old').stock,5)});
test('failed backup, stale preview and read-only startup cannot apply a size conversion',async()=>{
 const backup=uiFixture({backupOk:false});await backup.preview();await backup.ctx.window.applyProductSizeMode();assert.equal(backup.saves,0);assert.equal(backup.ctx.state.products.length,1);assert.match(backup.boxes.productSizeStatus.textContent,/резервную копию/);
 const stale=uiFixture();await stale.preview();stale.ctx.state.products[0].stock=4;await stale.ctx.window.applyProductSizeMode();assert.equal(stale.posts,0);assert.equal(stale.saves,0);assert.match(stale.boxes.productSizeStatus.textContent,/изменились/);
 const ro=uiFixture({ready:false});ro.ctx.window.openProductSizeMode('old');assert.equal(ro.sheet,'');assert.equal(ro.posts,0);
});
test('server rejection cannot be reported as successful conversion',async()=>{const f=uiFixture({pushOk:false});await f.preview();await f.ctx.window.applyProductSizeMode();assert.equal(f.opened,null);assert.match(f.boxes.productSizeStatus.textContent,/не подтверждено/)});
test('size mode assets are served before login and generic group button replaces hardcoded ring refresh',()=>{for(const asset of ['product-size-mode-model-v1.js','product-size-mode-v1.js']){assert.match(server,new RegExp("'"+asset.replaceAll('.','\\.')+"'"));assert.ok(html.indexOf('./'+asset)<html.lastIndexOf('initOwnerAuth();'))}assert.match(html,/Включить размеры/);assert.match(readFileSync(new URL('../../wb-variants-v1.js',import.meta.url),'utf8'),/Настроить размеры WB/)});
