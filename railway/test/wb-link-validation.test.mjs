import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { validateWbLink, applyLinkObservation, staleWbLinkRestored, preserveWbValidation } from '../src/wb-link-validation.js';

const cards=[{vendorCode:'Сто признаний платина',nmId:10,sizes:[{chrtId:20,barcodes:['2049533372954']}]}];
test('old article cannot be rescued by a retained barcode alias',()=>{
  const p={wb:'Я тебя люблю п',wbAliases:['2049533372954'],stock:100};
  const result=validateWbLink(p,'wb',cards);
  assert.equal(result.valid,false);
  applyLinkObservation(p,'wb',result,123);
  assert.equal(p.wb,'');assert.deepEqual(p.wbAliases,[]);assert.equal(p.stock,100);
  assert.equal(p.wbRelinkRequired.oldSku,'Я тебя люблю п');
});
test('same characteristic with changed seller article must be relinked',()=>{
  const p={wb:'2049533372954',wbVariant:{market:'WB',vendorCode:'Я тебя люблю п',chrtId:20}};
  const result=validateWbLink(p,'wb',cards);
  assert.equal(result.valid,false);assert.equal(result.currentSku,'Сто признаний платина');
});
test('unchanged article establishes stable identity, rename invalidates it',()=>{
  const p={wb:cards[0].vendorCode};
  applyLinkObservation(p,'wb',validateWbLink(p,'wb',cards),1);
  assert.equal(p.wbIdentity.chrtId,20);
  assert.equal(validateWbLink(p,'wb',[{...cards[0],vendorCode:'Новый артикул'}]).valid,false);
});
test('invalidation leaves the other shop and historical inventory untouched',()=>{
  const p={wb:'old',wb2:'other',stock:100,wbVariant:{market:'WB2',chrtId:77}};
  applyLinkObservation(p,'wb',{valid:false,oldSku:'old',reason:'seller-article-not-found'},1);
  assert.equal(p.wb2,'other');assert.equal(p.wbVariant.chrtId,77);assert.equal(p.stock,100);
});
test('old browser cannot restore the invalid article; explicit new article is allowed',()=>{
  const previous={products:[{id:'p',wb:'',wbRelinkRequired:{oldSku:'old'}}]};
  assert.ok(staleWbLinkRestored(previous,{products:[{id:'p',wb:'old'}]}));
  assert.equal(staleWbLinkRestored(previous,{products:[{id:'p',wb:'new'}]}),null);
});
test('conflict merge keeps unlinking even if another field was edited locally',()=>{
  const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
  const context={};vm.runInNewContext(html.split('\n').find(l=>l.startsWith('function mergeWbLinkInvalidations(')),context);
  const products=[{id:'p',wb:'old',wbAliases:['barcode'],name:'Edited locally',stock:100}];
  context.mergeWbLinkInvalidations([{id:'p',wb:'',wbRelinkRequired:{oldSku:'old'}}],products);
  assert.equal(products[0].wb,'');assert.equal(products[0].name,'Edited locally');assert.equal(products[0].stock,100);
});
test('an old client cannot erase validation metadata or restore barcode aliases',()=>{
  const previous={products:[{id:'p',wb:'',wbRelinkRequired:{oldSku:'old'},wb2:'other',wb2Identity:{vendorCode:'other',chrtId:9}}]};
  const next={products:[{id:'p',wb:'',wbAliases:['old-barcode'],wb2:'other',stock:100}]};
  preserveWbValidation(previous,next);
  assert.deepEqual(next.products[0].wbAliases,[]);
  assert.equal(next.products[0].wbRelinkRequired.oldSku,'old');
  assert.equal(next.products[0].wb2Identity.chrtId,9);
});
test('catalog failure never reaches the unlink transaction',async()=>{
  const source=readFileSync(new URL('../src/wb-stock-sync.js',import.meta.url),'utf8');
  let mutations=0;
  const ctx={config:{},pool:{query:async()=>({rows:[{payload:JSON.stringify({products:[{id:'p',wb:'old'}]})}]})},credentialFor:async()=> 'test',transaction:async()=>{mutations++;},setTimeout,clearTimeout,AbortController,fetch:async()=>({ok:false,status:429,text:async()=>'{"message":"rate limited"}'})};
  vm.createContext(ctx);vm.runInContext(source.replace(/^import .*;\r?\n/gm,'').replace(/export /g,'')+'\nthis.validate=validateWbStockLinks;',ctx);
  await assert.rejects(()=>ctx.validate('WB'),/429/);assert.equal(mutations,0);
});
test('manual order relinking saves current article and retains historical order alias',()=>{
  const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
  const p={id:'p',wb:'',stock:100,wbRelinkRequired:{oldSku:'old'}};
  let saves=0;
  const ctx={window:{pendingResolvedWbLink:{pid:'p',market:'WB',vendorCode:'Сто признаний платина',nmId:10,chrtId:20,barcode:'2049533372954',multipleSizes:false,link:{sku:'old',feedKey:'1:1'}}},prod:()=>p,marketplaceField:()=> 'wb',isWbMarket:()=>true,state:{wbOrderFeed:[{market:'WB',sku:'old'}]},applyMarketplaceTransitions:()=>{},save:()=>saves++,closeModal:()=>{},render:()=>{}};
  vm.createContext(ctx);
  for(const name of ['applyEditedMarketplaceSku','attachMarketplaceSku','confirmResolvedWbOrderLink'])vm.runInContext(html.split('\n').find(l=>l.startsWith('function '+name+'(')),ctx);
  ctx.confirmResolvedWbOrderLink();
  assert.equal(p.wb,'Сто признаний платина');assert.equal(p.stock,100);assert.equal(saves,1);
  assert.ok(p.wbAliases.includes('old'));assert.equal(p.wbRelinkRequired,undefined);
  assert.equal(ctx.state.wbOrderFeed[0].productId,'p');
  assert.equal(validateWbLink(p,'wb',cards).valid,true);
  assert.equal(staleWbLinkRestored({products:[{id:'p',wbRelinkRequired:{oldSku:'old'}}]},{products:[p]}),null);
});
