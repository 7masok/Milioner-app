import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import sharp from 'sharp';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import {preparePurchasePdf,purchasePhotoUrl,loadPurchasePhotos,createPurchasePdf,purchasePdfRouter} from '../src/purchase-pdf.js';
import {pool} from '../src/db.js';

const products=[{id:'p1',name:'Балерина пачка',wb:'ballet',wbAliases:['old-ballet']},{id:'p2',name:'Кошачья пара',wb:'cats'}];
const cards=[{nmId:'10',vendorCode:'ballet',photo:'https://basket-01.wbbasket.ru/vol1/images/1.webp'},{nmId:'20',vendorCode:'cats',photo:'https://basket-02.wbbasket.ru/vol2/images/1.webp'}];
const input={title:'Закупка № 7',date:'2026-10-19',draft:true,delivery:500,items:[{productId:'p1',qty:15,buyTotal:1500},{productId:'p2',qty:10,buyTotal:2000}]};
test('exact WB1 links choose the correct large source photo and never match by a similar name',()=>{
 const data=preparePurchasePdf(input,products,cards);assert.equal(data.qty,25);assert.equal(data.buy,3500);assert.equal(data.rows[0].photo,cards[0].photo);
 const unknown=preparePurchasePdf({...input,items:[{productId:'p2',qty:1,buyTotal:0}]},products,[cards[0]]);assert.equal(unknown.rows[0].photo,'');
 const linked=preparePurchasePdf(input,[{...products[0],wb:''},products[1]],cards,[{productId:'p1',sku:'10'}]);assert.equal(linked.rows[0].photo,cards[0].photo);
 const ambiguous=preparePurchasePdf(input,products,[...cards,{...cards[0],nmId:'99',photo:cards[1].photo}]);assert.equal(ambiguous.rows[0].photo,'');
});
test('unsafe photo addresses and invalid or incomplete purchase rows are rejected',()=>{
 for(const url of ['http://basket-01.wbbasket.ru/a','https://wbbasket.ru.evil.invalid/a','https://user:secret@basket-01.wbbasket.ru/a','https://127.0.0.1/a','https://basket-01.wbbasket.ru:8000/a'])assert.equal(purchasePhotoUrl(url),'');
 for(const items of [[],[null],[{productId:'missing',qty:1,buyTotal:0}],[{productId:'p1',qty:0,buyTotal:0}],[{productId:'p1',qty:1,buyTotal:null}],[{productId:'p1',qty:1,buyTotal:-1}],Array(201).fill(input.items[0])])assert.throws(()=>preparePurchasePdf({...input,items},products,cards));
});
test('WebP photos are embedded as bounded JPEGs; failures retain placeholders and duplicate photos load once',async()=>{
 const webp=await sharp({create:{width:300,height:400,channels:3,background:'#f0a040'}}).webp().toBuffer();let calls=0;
 const rows=[...preparePurchasePdf(input,products,cards).rows];rows.push({...rows[0]});
 const images=await loadPurchasePhotos(rows,{fetcher:async(url,options)=>{calls++;assert.equal(options.redirect,'error');return url.includes('basket-02')?new Response('',{status:404}):new Response(webp,{headers:{'content-type':'image/webp'}})}});
 assert.equal(calls,2);assert.equal(images.size,1);assert.equal((await sharp(images.get(cards[0].photo)).metadata()).format,'jpeg');
});
test('multipage PDF preserves Cyrillic, exact quantities and totals, with embedded images and page numbering',async()=>{
 const data=preparePurchasePdf({...input,items:Array.from({length:7},(_,i)=>({...input.items[i%2],qty:i+1}))},products,cards);
 const photo=await sharp({create:{width:400,height:550,channels:3,background:'#66aacc'}}).jpeg().toBuffer();
 const pdf=await createPurchasePdf(data,new Map([[cards[0].photo,photo]]));assert.equal(pdf.subarray(0,5).toString(),'%PDF-');
 const parsed=await pdfParse(pdf);assert.ok(parsed.numpages>=2);assert.match(parsed.text,/Балерина пачка/);assert.match(parsed.text,/Кошачья пара/);assert.match(parsed.text,/28 шт\./);assert.match(parsed.text,/Итого/);assert.match(parsed.text,/Нет фото/);assert.match(pdf.toString('latin1'),/\/Subtype \/Image/);
 assert.ok(parsed.text.includes('1 / '+parsed.numpages));
});
test('unsaved edit is snapshotted without saving, and export has no warehouse mutation calls',()=>{
 const source=readFileSync(new URL('../../purchase-pdf-v1.js',import.meta.url),'utf8');
 const values={editPorBatch:{value:'Черновик'},editPorDate:{value:'2026-10-19'},editPorBuyTotal:{value:'500'},editPorDelivery:{value:'100'}};
 const context={window:{},document:{getElementById:id=>values[id]},editPurchaseDraftRows:()=>[{productId:'p1',qty:3},{productId:'p2',qty:2}],purchaseDraftCosts:(rows,buy)=>rows.map(r=>({...r,buyTotal:buy*r.qty/5}))};
 vm.runInNewContext(source.replace(/\}\)\(\);\s*$/,'window.fixture=purchasePdfInput;})();'),context);
 const result=context.window.fixture('edit');assert.equal(result.draft,true);assert.equal(result.title,'Черновик');assert.equal(result.items[0].qty,3);assert.equal(result.items[0].buyTotal,300);
 values.editPorBuyTotal.value='999';assert.equal(result.items[0].buyTotal,300);
 assert.doesNotMatch(source,/\b(?:save|createPurchaseOrder|savePurchaseShipmentEdit|pushWarehouseToServer)\s*\(/);
});
test('PDF route reads only WB1 snapshots and canonical products and returns an actual PDF',async()=>{
 const original=pool.query,queries=[];
 pool.query=async(sql,args)=>{queries.push({sql,args});if(sql.includes('warehouse_state'))return{rows:[{payload:{}}]};if(sql.includes('warehouse_products'))return{rows:products.map(payload=>({payload}))};if(sql.includes('wb_card_group_snapshots')){assert.equal(args[0],'WB');return{rows:[]}}if(sql.includes('product_links')){assert.equal(args[0],'WB');return{rows:[]}}throw Error(sql)};
 try{
  const route=purchasePdfRouter.stack.find(r=>r.route?.path==='/purchases/pdf').route.stack.at(-1).handle;
  let body,headers;await new Promise((resolve,reject)=>route({body:input},{set(h){headers=h;return this},send(b){body=b;resolve()}},reject));
  assert.equal(headers['Content-Type'],'application/pdf');assert.match(headers['Content-Disposition'],/attachment/);assert.equal(body.subarray(0,5).toString(),'%PDF-');
  assert.ok(queries.every(q=>/^SELECT/.test(q.sql)));
 }finally{pool.query=original}
});
