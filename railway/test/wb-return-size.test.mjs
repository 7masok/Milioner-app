import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {wbReturnIdentity,wbReturnSize,wbReturnsRouter} from '../src/wb-returns.js';
import {pool} from '../src/db.js';
const raw={order:{nmId:127,chrtId:88,skus:['barcode-eight']},identity:{nmId:'127',chrtId:88,barcode:'barcode-eight',size:''}};
const variant=(size='8',id=88,barcode='barcode-eight',market='WB')=>({id:'size-'+id,wbVariant:{market,nmId:'127',chrtId:id,barcode,size}});
test('a missing order size resolves by exact saved characteristic and barcode rather than the shared ring title',()=>{
 const identity=wbReturnIdentity(JSON.stringify(raw)),p=variant();assert.equal(wbReturnSize('WB',identity,[variant('7',77,'barcode-seven'),p]).size,'8');assert.equal(wbReturnSize('WB',identity,[p]).sizeKnown,true);
 assert.equal(wbReturnSize('WB',identity,[variant('8',88,'barcode-eight','WB2')]).sizeKnown,false);assert.equal(wbReturnSize('WB',{...identity,nmId:'other'},[p]).sizeKnown,false);
 assert.equal(wbReturnSize('WB',{...identity,chrtId:0},[p]).size,'8');assert.equal(wbReturnSize('WB',{...identity,chrtId:0,barcode:''},[p]).sizeKnown,false);
});
test('conflicting, ambiguous and missing variants stay unknown while an explicit original order size stays authoritative',()=>{
 const identity=wbReturnIdentity(raw);for(const candidates of [[],[variant('8'),variant('9',88)],[variant('8'),variant('9',99,'barcode-eight')]])assert.equal(wbReturnSize('WB',identity,candidates).sizeKnown,false);
 assert.equal(wbReturnSize('WB',{...identity,chrtId:0},[variant('8'),variant('8',99)]).sizeKnown,false);
 assert.equal(wbReturnSize('WB',{...identity,size:'17'},[variant('18')]).size,'17');assert.equal(wbReturnSize('WB',{...identity,size:'0'}).size,'Без размера');assert.equal(wbReturnIdentity('null').size,'');assert.equal(wbReturnIdentity('bad').chrtId,0);
});
async function lookup({orderRaw=raw,products=[variant()],extraOrder=false}={}){
 const route=wbReturnsRouter.stack.find(x=>x.route?.path==='/wb-return-lookup').route.stack.at(-1).handle,old=pool.query,fetch=globalThis.fetch,queries=[];let output,status=200;
 pool.query=async(sql,args)=>{queries.push({sql,args});if(sql.includes('FROM marketplace_order_lines o')){const row={market:'WB',orderId:'order',entryId:'entry',qty:1,productId:'generic',productName:'Кольцо',rawJson:JSON.stringify({...orderRaw,private:'must-not-leak'})};return {rowCount:extraOrder?2:1,rows:extraOrder?[row,{...row,market:'WB2'}]:[row]}}if(sql.includes('FROM warehouse_products'))return{rows:products.map(payload=>({payload}))};if(sql.includes('FROM warehouse_sales'))return{rowCount:1,rows:[{}]};throw Error('Unexpected SQL')};
 globalThis.fetch=()=>assert.fail('return lookup must not call marketplace APIs');
 try{await route({query:{market:'all',code:'sticker'}},{status(n){status=n;return this},json(value){output=value}},e=>{throw e})}finally{pool.query=old;globalThis.fetch=fetch}
 return{output,status,queries};
}
test('the real lookup route enriches the display size with bounded read-only SQL and never leaks raw order fields or changes the inventory target',async()=>{
 const r=await lookup();assert.equal(r.status,200);assert.equal(r.output.order.size,'8');assert.equal(r.output.order.sizeKnown,true);assert.equal(r.output.order.variantBarcode,'barcode-eight');assert.equal(r.output.order.productId,'generic');assert.equal(r.output.order.externalKey,'WB:order:entry');assert.equal(r.output.order.rawJson,undefined);assert.doesNotMatch(JSON.stringify(r.output),/must-not-leak/);
 assert.ok(r.queries.every(q=>q.sql.trim().startsWith('SELECT')));assert.match(r.queries.find(q=>q.sql.includes('FROM warehouse_products')).sql,/LIMIT 21/);assert.equal(r.queries.find(q=>q.sql.includes('FROM warehouse_products')).args[0],'WB');
 const unknown=await lookup({products:[]});assert.equal(unknown.output.order.sizeKnown,false);const direct=await lookup({orderRaw:{order:{techSize:'18'}}});assert.equal(direct.output.order.size,'18');assert.ok(direct.queries.every(q=>!q.sql.includes('FROM warehouse_products')));
 const ambiguous=await lookup({extraOrder:true});assert.equal(ambiguous.status,409);assert.ok(ambiguous.queries.every(q=>!q.sql.includes('FROM warehouse_products')));
});
const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
test('QR identification, eligible return, processed receipt and no-debit result all display the confirmed size',async()=>{
 const order={market:'WB',orderId:'order',entryId:'entry',code:'123',productId:'generic',qty:1,status:'complete',state:'canceled_by_client',externalKey:'WB:order:entry',size:'8',sizeKnown:true,variantBarcode:'barcode-eight'},boxes={wbQrIdentifyResult:{innerHTML:''},wbReturnResult:{innerHTML:''}};
 const ctx=vm.createContext({window:{},state:{settings:{},sales:[{externalKey:order.externalKey}]},returnOrderMarket:'WB',wbReturnResolved:null,MILLIONER_API:'https://fixture.invalid',document:{getElementById:id=>boxes[id]||null},fetch:async()=>({ok:true,json:async()=>({ok:true,order})}),loadSharedOrderCache:async()=>{},returnMarketLabel:()=> 'WB1',isWbMarket:()=>true,productNameById:()=> 'Кольцо трансформер',marketplaceLifecycleStage:()=> 'cancelled',esc:s=>String(s).replaceAll('<','&lt;')});
 for(const name of ['wbReturnVariantHtml','identifyWbQr','lookupWbReturn'])vm.runInContext(html.split('\n').find(l=>l.startsWith('function '+name+'(')||l.startsWith('async function '+name+'(')),ctx);
 await ctx.identifyWbQr('sticker');assert.match(boxes.wbQrIdentifyResult.innerHTML,/Размер: 8/);
 await ctx.lookupWbReturn('sticker');assert.match(boxes.wbReturnResult.innerHTML,/Размер: 8/);
 ctx.state.settings.wbReturnReceipts={[order.externalKey]:{at:100,action:'Возврат'}};await ctx.lookupWbReturn('sticker');assert.match(boxes.wbReturnResult.innerHTML,/уже обработан/);assert.match(boxes.wbReturnResult.innerHTML,/Размер: 8/);
 ctx.state.sales=[];await ctx.lookupWbReturn('sticker');assert.match(boxes.wbReturnResult.innerHTML,/не списывал/);assert.match(boxes.wbReturnResult.innerHTML,/Размер: 8/);
 assert.match(ctx.wbReturnVariantHtml({size:'18',sizeKnown:false,variantBarcode:'barcode'}),/Размер не определён/);assert.doesNotMatch(ctx.wbReturnVariantHtml({size:'18',sizeKnown:false}),/Размер: 18/);
});
