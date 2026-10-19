import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const context={};vm.runInNewContext(readFileSync(new URL('../../packaging-model.js',import.meta.url),'utf8'),context);
const M=context.PackagingModel;
function fixture(){return {settings:{packagingV1:{items:[{id:'box',name:'Коробочка',stock:10,unitCost:100},{id:'bag',name:'Пакет',stock:20,unitCost:20}]}},products:[{id:'group',kind:'variant-group',name:'Кольцо',packagingRecipe:[{packagingId:'box',qty:1,scope:'item'},{packagingId:'bag',qty:1,scope:'order'}]},{id:'size',name:'Кольцо 17',variantGroupId:'group',variantLabel:'Размер 17',stock:5,wb:'barcode-17',wbVariant:{size:'17',chrtId:123},cost:1500}]}}
test('sizes inherit several packages; explicit empty recipe disables inheritance; removing override restores it',()=>{
 const s=fixture(),p=s.products[1];assert.equal(M.recipe(s,p).length,2);p.packagingRecipe=[];assert.equal(M.recipe(s,p).length,0);p.packagingRecipe=[{packagingId:'bag',qty:2,scope:'item'}];assert.equal(M.recipe(s,p)[0].qty,2);delete p.packagingRecipe;assert.equal(M.recipe(s,p)[0].packagingId,'box');
});
test('item and order cost are separate and configuring packaging cannot change inventory or financial results',()=>{
 const s=fixture(),before=structuredClone(s),cost=M.costs(s,s.products[1]);assert.equal(cost.item,100);assert.equal(cost.order,20);assert.deepEqual(s,before);
});
test('recipe validation rejects missing packaging, duplicate scope, fractional/negative quantities and unknown scope',()=>{
 const s=fixture();for(const r of [[{packagingId:'missing',qty:1,scope:'item'}],[{packagingId:'box',qty:0,scope:'item'}],[{packagingId:'box',qty:1.5,scope:'item'}],[{packagingId:'box',qty:1,scope:'invalid'}],[{packagingId:'box',qty:1,scope:'item'},{packagingId:'box',qty:1,scope:'item'}]])assert.throws(()=>M.validateRecipe(s,r));
 assert.equal(M.validateRecipe(s,[{packagingId:'box',qty:1,scope:'item'},{packagingId:'box',qty:1,scope:'order'}]).length,2);
});
test('receipt computes weighted average and permanent movement without mutating the input',()=>{
 const s=fixture(),p=s.settings.packagingV1.items[0],before=structuredClone(p),result=M.adjust(p,{type:'receipt',qty:10,unitCost:200,note:'Поставщик'},1000,'m');assert.equal(result.item.stock,20);assert.equal(result.item.unitCost,150);assert.equal(result.movement.qty,10);assert.equal(result.movement.before,10);assert.equal(result.movement.after,20);assert.equal(result.movement.unitCost,200);assert.deepEqual(p,before);
});
test('writeoff cannot overdraw; physical recount records a delta and keeps valuation',()=>{
 const p=fixture().settings.packagingV1.items[0];assert.throws(()=>M.adjust(p,{type:'writeoff',qty:11},1000,'m'));assert.throws(()=>M.adjust(p,{type:'receipt',qty:1,unitCost:NaN},1000,'m'));assert.throws(()=>M.adjust(p,{type:'inventory',qty:1.5},1000,'m'));const r=M.adjust(p,{type:'inventory',qty:0},1000,'m');assert.equal(r.item.stock,0);assert.equal(r.item.unitCost,100);assert.equal(r.movement.qty,-10);assert.equal(M.adjust(p,{type:'writeoff',qty:2},1000,'m').item.stock,8);
});
test('common card updates preserve stock, cost, size identities and marketplace links',()=>{
 const s=fixture(),before=structuredClone(s),updates=M.updateGroup(s,'group',{name:'Кольцо новое',category:'Украшения',photo:'https://example.com/a.jpg',renameChildren:true,shareDetails:true}),child=updates.find(p=>p.id==='size');assert.equal(child.name,'Кольцо новое · Размер 17');assert.equal(child.photo,'https://example.com/a.jpg');assert.equal(child.stock,5);assert.equal(child.cost,1500);assert.equal(child.wb,'barcode-17');assert.deepEqual(child.wbVariant,before.products[1].wbVariant);assert.deepEqual(s,before);
});
test('common editor can leave child titles and details unchanged and never targets unrelated products',()=>{
 const s=fixture();s.products.push({id:'other',name:'Другой'});const updates=M.updateGroup(s,'group',{name:'Группа',photo:'',category:'',renameChildren:false,shareDetails:false});assert.equal(updates.length,2);assert.equal(updates[1].name,'Кольцо 17');assert.throws(()=>M.updateGroup(s,'size',{name:'x'}));
});
test('packaging entry points and assets load statically before authentication on both website hosts',()=>{
 const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8'),server=readFileSync(new URL('../src/server.js',import.meta.url),'utf8');for(const file of ['packaging.css','packaging-model.js','packaging-v1.js']){assert.ok(html.includes('./'+file));assert.ok(server.includes("'"+file+"'"));assert.ok(html.indexOf('./'+file)<html.lastIndexOf('initOwnerAuth();'))}assert.match(html,/onclick="openPackagingCatalog\(\)"/);assert.match(html,/packagingProductBlock\(p\)/);
});
