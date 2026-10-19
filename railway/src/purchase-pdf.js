import express from 'express';
import PDFDocument from 'pdfkit';
import sharp from 'sharp';
import {createRequire} from 'node:module';
import {pool} from './db.js';
import {asyncRoute,requireTrustedOrigin} from './http.js';
import {hydrateWarehouseProducts} from './warehouse-products.js';
import {wbCardGroupSnapshot} from './wb-card-groups.js';

const require=createRequire(import.meta.url);
const FONT=require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf');
const BOLD=require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf');
const MAX_IMAGE=5*1024*1024;
const text=v=>String(v??'').trim();
const invalid=message=>Object.assign(new Error(message),{status:400});
function money(value){return Number(value).toLocaleString('ru-RU',{maximumFractionDigits:2})+' ₸'}
export function purchasePhotoUrl(value){
 try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&(!u.port||u.port==='443')&&/^(?:[a-z0-9-]+\.)*(?:wbbasket\.ru|wbstatic\.net|wildberries\.ru|wb\.ru)$/i.test(u.hostname)?u.href:''}catch{return ''}
}
export function preparePurchasePdf(input,products,cards,links=[]){
 if(!Array.isArray(input?.items)||!input.items.length||input.items.length>200)throw invalid('В PDF должно быть от 1 до 200 позиций');
 const byId=new Map(products.map(p=>[String(p.id),p]));
 const rows=input.items.map(item=>{
  if(!item||typeof item!=='object'||Array.isArray(item))throw invalid('Проверьте позиции закупки');
  const product=byId.get(text(item.productId)),qty=Number(item.qty),buyTotal=Number(item.buyTotal);
  if(!product)throw invalid('Товар закупки не найден. Обновите склад перед выгрузкой.');
  if(!Number.isSafeInteger(qty)||qty<1||qty>1000000||item.buyTotal===null||item.buyTotal===undefined||!Number.isFinite(buyTotal)||buyTotal<0||buyTotal>1e12)throw invalid('Проверьте количество и сумму каждой позиции');
  const keys=[product.wb,...(Array.isArray(product.wbAliases)?product.wbAliases:[]),...links.filter(l=>String(l.productId)===String(product.id)).map(l=>l.sku)].map(text).filter(Boolean);
  let card=null;
  for(const key of [...new Set(keys)]){const found=cards.filter(c=>text(c.vendorCode)===key||text(c.nmId)===key);if(found.length===1){card=found[0];break;}}
  return {productId:String(product.id),name:text(product.name).slice(0,300)||'Товар',sku:text(card?.vendorCode||product.wb),qty,buyTotal,photo:purchasePhotoUrl(card?.photo)};
 });
 const delivery=Number(input.delivery??0);if(!Number.isFinite(delivery)||delivery<0||delivery>1e12)throw invalid('Проверьте сумму доставки');
 const date=text(input.date);if(date&&(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date+'T00:00:00Z'))))throw invalid('Проверьте дату закупки');
 return {title:text(input.title).slice(0,120)||'Закупка',date,draft:input.draft===true,rows,delivery,buy:rows.reduce((n,r)=>n+r.buyTotal,0),qty:rows.reduce((n,r)=>n+r.qty,0)};
}
export async function loadPurchasePhotos(rows,{fetcher=fetch,signal=AbortSignal.timeout(55000)}={}){
 const urls=[...new Set(rows.map(r=>purchasePhotoUrl(r.photo)).filter(Boolean))],images=new Map();let index=0;
 const load=async()=>{while(index<urls.length){const url=urls[index++];if(signal.aborted)break;
  try{
   const response=await fetcher(url,{redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(15000)]),headers:{Accept:'image/*'}});
   if(!response.ok||Number(response.headers.get('content-length'))>MAX_IMAGE)continue;
   const chunks=[];let size=0;
   for await(const chunk of response.body){size+=chunk.length;if(size>MAX_IMAGE)throw Error('image too large');chunks.push(chunk);}
   const image=await sharp(Buffer.concat(chunks),{limitInputPixels:16000000}).rotate().resize({width:600,height:900,fit:'inside',withoutEnlargement:true}).jpeg({quality:85}).toBuffer();
   images.set(url,image);
  }catch{/* A missing photo must not lose the purchase or substitute another item. */}
 }};
 await Promise.all(Array.from({length:Math.min(4,urls.length)},load));return images;
}
export function createPurchasePdf(data,images=new Map()){
 return new Promise((resolve,reject)=>{
  const doc=new PDFDocument({size:'A4',margin:36,bufferPages:true,info:{Title:data.title,Author:'Склад'}}),chunks=[];
  let bytes=0;doc.on('data',chunk=>{bytes+=chunk.length;if(bytes>30*1024*1024)doc.destroy(Error('PDF слишком большой'));else chunks.push(chunk)});
  doc.on('error',reject);doc.on('end',()=>resolve(Buffer.concat(chunks)));
  try{
   doc.registerFont('regular',FONT).registerFont('bold',BOLD);const left=36,width=doc.page.width-72,bottom=doc.page.height-66;
   let y=0;
   const header=first=>{
    doc.font('bold').fontSize(first?21:14).fillColor('#151515');
    const heading=first?data.title:'Закупка · '+data.title;
    const height=doc.heightOfString(heading,{width});doc.text(heading,left,32,{width});y=32+height+8;
    doc.font('regular').fontSize(9).fillColor('#666666');
    const date=data.date?data.date.split('-').reverse().join('.'):'Дата не указана';
    doc.text(date+'  ·  '+data.rows.length+' поз.  ·  '+data.qty.toLocaleString('ru-RU')+' шт.'+(data.draft?'  ·  Черновик':''),left,y,{width});
    y+=25;
   };
   header(true);
   for(let i=0;i<data.rows.length;i++){
    const row=data.rows[i],textX=left+144,textWidth=width-160;
    doc.font('bold').fontSize(13);const nameHeight=doc.heightOfString(row.name,{width:textWidth});
    const sku='WB1: '+(row.sku||'артикул не привязан');doc.font('regular').fontSize(9);const skuHeight=doc.heightOfString(sku,{width:textWidth});
    const height=Math.max(168,nameHeight+skuHeight+110),summarySpace=i===data.rows.length-1?92:0;
    if(y+height+summarySpace>bottom){doc.addPage();header(false);}
    doc.roundedRect(left,y,width,height-8,9).fill('#f3f5f7');
    doc.roundedRect(left+8,y+8,120,height-24,5).fill('#ffffff');
    const image=images.get(row.photo);
    if(image)doc.image(image,left+10,y+10,{fit:[116,height-28],align:'center',valign:'center'});
    else doc.font('regular').fontSize(10).fillColor('#777777').text('Нет фото',left+10,y+height/2-7,{width:116,align:'center'});
    let ty=y+13;doc.font('regular').fontSize(8).fillColor('#777777').text(String(i+1).padStart(2,'0'),textX,ty);ty+=16;
    doc.font('bold').fontSize(13).fillColor('#151515').text(row.name,textX,ty,{width:textWidth});ty+=nameHeight+9;
    doc.font('regular').fontSize(9).fillColor('#666666').text(sku,textX,ty,{width:textWidth});ty+=skuHeight+11;
    doc.font('bold').fontSize(20).fillColor('#151515').text(row.qty.toLocaleString('ru-RU')+' шт.',textX,ty,{width:textWidth});ty+=28;
    doc.font('regular').fontSize(10).text('Сумма: '+money(row.buyTotal),textX,ty,{width:textWidth});
    y+=height;
   }
   if(y+92>bottom){doc.addPage();header(false);}
   doc.font('regular').fontSize(11).fillColor('#333333').text('Товары: '+money(data.buy),left,y+10).text('Доставка: '+money(data.delivery),left,y+28);
   doc.font('bold').fontSize(15).fillColor('#151515').text('Итого: '+money(data.buy+data.delivery),left,y+49);
   const range=doc.bufferedPageRange();for(let p=0;p<range.count;p++){
    doc.switchToPage(p);doc.page.margins.bottom=0;doc.font('regular').fontSize(8).fillColor('#777777').text('Склад · Закупка',left,doc.page.height-43,{lineBreak:false});
    doc.text((p+1)+' / '+range.count,doc.page.width-94,doc.page.height-43,{width:58,align:'right',lineBreak:false});
   }
   doc.end();
  }catch(error){doc.destroy(error);reject(error)}
 });
}
export const purchasePdfRouter=express.Router();
purchasePdfRouter.post('/purchases/pdf',requireTrustedOrigin,asyncRoute(async(req,res)=>{
 const input=req.body||{};
 if(!Array.isArray(input.items)||input.items.length>200)throw invalid('Проверьте состав закупки');
 const ids=[...new Set(input.items.map(i=>text(i?.productId)).filter(Boolean))];
 const [warehouse,snapshot,links]=await Promise.all([
  pool.query('SELECT payload FROM warehouse_state WHERE id=1'),wbCardGroupSnapshot('WB'),
  pool.query('SELECT product_id AS "productId",sku FROM product_links WHERE market=$1 AND product_id=ANY($2::text[])',['WB',ids])]);
 const raw=warehouse.rows[0]?.payload,base=typeof raw==='string'?JSON.parse(raw):raw||{},state=await hydrateWarehouseProducts(pool,base);
 const data=preparePurchasePdf(input,state.products||[],snapshot.cards,links.rows),images=await loadPurchasePhotos(data.rows),pdf=await createPurchasePdf(data,images);
 const filename='purchase-'+(data.date||new Date().toISOString().slice(0,10))+'.pdf';
 res.set({'Content-Type':'application/pdf','Content-Disposition':'attachment; filename="'+filename+'"','Cache-Control':'no-store'}).send(pdf);
}));
