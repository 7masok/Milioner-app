import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {PGlite} from '@electric-sql/pglite';
import {withProductHistoryPage} from '../src/product-history-page.js';
process.env.APP_ADMIN_TOKEN='product-history-test-only';
const {historyQuery,createProductHistoryRouter}=await import('../src/product-history.js');
const {createSessionToken}=await import('../src/auth.js');
const {pool}=await import('../src/db.js');
const read=p=>readFileSync(new URL(p,import.meta.url),'utf8');
const migration=read('../migrations/151_product_history.sql');
async function fixture(seed=false){
 const db=new PGlite();
 for(const file of ['126_warehouse_products.sql','122_warehouse_purchases.sql','124_warehouse_reservations.sql','100_warehouse_movements.sql','123_warehouse_sales.sql'])await db.exec(read('../migrations/'+file).split('--')[0]);
 await db.exec("CREATE TABLE warehouse_audit(revision BIGINT PRIMARY KEY,updated_at BIGINT NOT NULL,payload_sha256 TEXT NOT NULL,source TEXT NOT NULL)");
 if(seed)await db.query("INSERT INTO warehouse_products(id,name,stock,payload) VALUES('one','Малина 24',5,$1::jsonb)",[JSON.stringify({id:'one',name:'Малина 24',stock:5,ozon:'111'})]);
 await db.exec(migration);await db.exec(read('../migrations/152_product_history_business_events.sql'));return db;
}
test('real PostgreSQL triggers preserve creations, field changes and deletion of one of two same-name products',async()=>{
 const db=await fixture(true);try{
  let rows=(await db.query('SELECT * FROM product_history')).rows;assert.equal(rows.length,1);assert.equal(rows[0].action,'baseline');
  await db.query("INSERT INTO warehouse_products(id,name,stock,payload) VALUES('two','Малина 24',14,$1::jsonb)",[JSON.stringify({id:'two',name:'Малина 24',stock:14,kaspi:'222'})]);
  await db.query("UPDATE warehouse_products SET stock=4,name='Малина новая',payload=payload||$1::jsonb WHERE id='one'",[JSON.stringify({name:'Малина новая',stock:4,cost:100,ozon:'333'})]);
  await db.exec("DELETE FROM warehouse_products WHERE id='two'");rows=(await db.query('SELECT * FROM product_history ORDER BY id')).rows;
  assert.deepEqual(rows.map(r=>r.action),['baseline','created','updated','deleted']);assert.equal(rows[1].product_id,'two');assert.equal(rows[3].product_name,'Малина 24');assert.equal(rows[3].changes.stock.before,14);assert.equal(rows[2].changes.ozon.before,'111');assert.equal(rows[2].changes.ozon.after,'333');assert.equal(rows[2].changes.cost.beforeExists,false);
  assert.equal((await db.query("SELECT stock FROM warehouse_products WHERE id='one'")).rows[0].stock,4);
  await db.exec(migration);assert.equal((await db.query('SELECT * FROM product_history')).rows.length,4);
 }finally{await db.close()}
});
test('no-op saves and rolled-back transactions leave no false history; audit source is attached to the committed transaction',async()=>{
 const db=await fixture(true);try{
  await db.exec("UPDATE warehouse_products SET updated_at=100,payload=payload||'{\"updatedAt\":100}'::jsonb WHERE id='one'");assert.equal((await db.query('SELECT count(*)::int AS n FROM product_history')).rows[0].n,1);
  await db.exec("BEGIN;UPDATE warehouse_products SET stock=1 WHERE id='one';ROLLBACK;");assert.equal((await db.query('SELECT count(*)::int AS n FROM product_history')).rows[0].n,1);
  await db.exec("BEGIN;UPDATE warehouse_products SET stock=3 WHERE id='one';INSERT INTO warehouse_audit VALUES(9,100,'hash','fbo-automatic');COMMIT;");
  const row=(await db.query('SELECT * FROM product_history ORDER BY id DESC LIMIT 1')).rows[0];assert.equal(row.source,'fbo-automatic');assert.equal(Number(row.revision),9);assert.equal(row.changes.stock.before,5);assert.equal(row.changes.stock.after,3);
 }finally{await db.close()}
});
test('purchases, reservations, sales and movements are captured, including reassignment to another product',async()=>{
 const db=await fixture(true);try{
  await db.exec("INSERT INTO warehouse_purchases(id,product_id,status,qty,payload) VALUES('lot','one','at_warehouse',14,'{}');INSERT INTO warehouse_reservations(id,reservation_key,product_id,qty,active,source,payload) VALUES('hold','h','one',2,true,'Kaspi','{}');INSERT INTO warehouse_sales(id,product_id,qty,channel,payload) VALUES('sale','one',1,'Ozon','{\"channel\":\"Ozon\"}');INSERT INTO warehouse_movements(id,product_id,qty,payload) VALUES('move','one',-1,'{\"type\":\"списание\"}');UPDATE warehouse_purchases SET product_id='another' WHERE id='lot';DELETE FROM warehouse_reservations WHERE id='hold';");
  const rows=(await db.query('SELECT * FROM product_history ORDER BY id')).rows;
  for(const entity of ['purchase','reservation','sale','movement'])assert.ok(rows.some(r=>r.entity===entity&&r.action==='created'));
  const reassigned=rows.filter(r=>r.entity==='purchase'&&r.action==='updated');assert.deepEqual(reassigned.map(r=>r.product_id).sort(),['another','one']);assert.ok(rows.some(r=>r.entity==='reservation'&&r.action==='deleted'));
 }finally{await db.close()}
});
test('sensitive keys are excluded, large images summarized, and search/pagination use escaped parameters',async()=>{
 const db=await fixture();try{
  await db.query("INSERT INTO warehouse_products(id,name,stock,payload) VALUES('p','100% товар',1,$1::jsonb)",[JSON.stringify({photo:'x'.repeat(6000),password:'hidden',stock:1})]);
  const row=(await db.query('SELECT * FROM product_history')).rows[0];assert.equal(row.changes.password,undefined);assert.equal(row.changes.photo.after._historySummary,true);assert.ok(JSON.stringify(row).length<3000);
  const query=historyQuery({q:'100%'});const rows=await db.query(query.text,query.values);assert.equal(rows.rows.length,1);assert.equal(query.values[0],'%100\\%%');assert.equal(query.text.includes('100%'),false);
  const next=historyQuery({productId:'p',entity:'product',action:'created',before:'9007199254740997'});assert.ok(next.values.includes('9007199254740997'));assert.throws(()=>historyQuery({before:'1 OR 1=1'}));assert.throws(()=>historyQuery({entity:'anything'}));
 }finally{await db.close()}
});
test('history API is authenticated, origin-protected, read-only, and paginates deleted products',async()=>{
 const express=(await import('express')).default,queries=[];
 const db={query:async(sql,args)=>{queries.push({sql,args});return sql.includes('product_history_meta')?{rows:[{installed_at:100}]}:{rows:Array.from({length:51},(_,i)=>({id:String(100-i),productId:'deleted',productName:'Малина',changes:{}}))}}};
 const app=express();app.use('/api/product-history',createProductHistoryRouter({db}));app.use((err,req,res,next)=>res.status(err.status||500).json({ok:false,error:err.message}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.on('listening',r));const url='http://127.0.0.1:'+server.address().port+'/api/product-history?productId=deleted',token=createSessionToken().token;
 try{
  assert.equal((await fetch(url,{headers:{Origin:'https://7masok.github.io'}})).status,401);
  assert.equal((await fetch(url,{headers:{Origin:'https://evil.invalid',Authorization:'Bearer '+token}})).status,403);
  const response=await fetch(url,{headers:{Origin:'https://7masok.github.io',Authorization:'Bearer '+token}}),out=await response.json();assert.equal(response.status,200);assert.equal(out.rows.length,50);assert.equal(out.nextCursor,'51');assert.equal(out.installedAt,100);assert.match(response.headers.get('cache-control'),/no-store/);assert.ok(queries.every(q=>q.sql.trim().startsWith('SELECT')));
 }finally{await new Promise(r=>server.close(r))}
});
test('served product toolbar and product sheet expose history before authentication starts',()=>{
 const page=withProductHistoryPage(read('../../index.html'));assert.equal((page.match(/data-product-history=""/g)||[]).length,1);assert.match(page,/data-product-history="\$\{esc\(p.id\)\}"/);assert.ok(page.indexOf('./product-history-v1.js')<page.lastIndexOf('initOwnerAuth();'));
 const ctx={window:{},document:{addEventListener(){}},console};vm.runInNewContext(read('../../product-history-v1.js'),ctx);assert.equal(typeof ctx.window.openProductHistory,'function');
});
test('history UI ignores stale responses, paginates the same filters and escapes stored product values',async()=>{
 const nodes=new Map(),requests=[];const el=id=>nodes.get(id),doc={getElementById:el,addEventListener(){},createElement:()=>({}),head:{append(){}}};
 const ctx={window:{},document:doc,console,Date,URLSearchParams,MILLIONER_API:'',showSheet:()=>{nodes.clear();for(const id of ['phRows','phNotice','phMore','phQuery','phEntity','phAction','phRefresh'])nodes.set(id,{innerHTML:'',value:'',textContent:'',insertAdjacentHTML(_where,html){this.innerHTML+=html}})},apiJson:url=>new Promise(resolve=>requests.push({url,resolve}))};
 vm.runInNewContext(read('../../product-history-v1.js'),ctx);ctx.window.openProductHistory('old');ctx.window.openProductHistory('new');
 const event={id:'9',productId:'new',productName:'<img src=x onerror=bad()>',entity:'product',entityId:'new',action:'updated',happenedAt:100,source:'api',changes:{name:{before:'Старое',after:'Новое',beforeExists:true,afterExists:true}}};
 requests[1].resolve({ok:true,rows:[event],nextCursor:'9',installedAt:100});await new Promise(r=>setImmediate(r));assert.match(el('phRows').innerHTML,/&lt;img/);assert.doesNotMatch(el('phRows').innerHTML,/<img/);assert.equal(el('phMore').hidden,false);
 requests[0].resolve({ok:true,rows:[{...event,productName:'STALE'}],installedAt:100});await new Promise(r=>setImmediate(r));assert.doesNotMatch(el('phRows').innerHTML,/STALE/);
 el('phMore').onclick();assert.match(requests[2].url,/productId=new/);assert.match(requests[2].url,/before=9/);requests[2].resolve({ok:true,rows:[],nextCursor:null,installedAt:100});await new Promise(r=>setImmediate(r));assert.equal(el('phMore').hidden,true);
 el('phAction').value='deleted';el('phAction').onchange();assert.match(requests[3].url,/action=deleted/);assert.doesNotMatch(requests[3].url,/before=/);requests[3].resolve({ok:true,rows:[],nextCursor:null,installedAt:100});await new Promise(r=>setImmediate(r));assert.match(el('phRows').innerHTML,/Записей по этим условиям нет/);
});
test('card history shows only readable card events with no technical dump or operation filters',async()=>{
 const nodes=new Map(),requests=[];let sheet='';const doc={getElementById:id=>nodes.get(id),addEventListener(){},createElement:()=>({}),head:{append(){}}};
 const ctx={window:{},document:doc,Date,URLSearchParams,MILLIONER_API:'',showSheet:html=>{sheet=html;for(const id of ['phRows','phNotice','phMore','phQuery','phAction','phRefresh'])nodes.set(id,{value:'',innerHTML:''})},apiJson:()=>new Promise(resolve=>requests.push(resolve))};
 vm.runInNewContext(read('../../product-history-v1.js'),ctx);ctx.window.openProductHistory('p');
 const change=(before,after)=>({before,after,beforeExists:true,afterExists:true}),event={productId:'opaque-product-id',entityId:'opaque-lot-id',productName:'Венчик голд',entity:'product',action:'updated',happenedAt:1793266765000,revision:25639,source:'api-patch',changes:{name:change('Венчик','Венчик голд'),stock:change(50,0),cost:change(150,125.341)}};
 requests[0]({ok:true,installedAt:100,rows:[event,{...event,productName:'UNWANTED stock only',changes:{stock:change(0,20),cost:change(150,125.341)}},...['reservation','movement','purchase','sale'].map(entity=>({...event,entity,productName:'UNWANTED '+entity})),{...event,action:'baseline',productName:'UNWANTED baseline'}]});
 await new Promise(r=>setImmediate(r));const html=nodes.get('phRows').innerHTML;
 assert.match(html,/Карточка изменена/);assert.match(html,/Венчик голд/);assert.match(html,/Название/);assert.match(html,/<del>Венчик<\/del>/);assert.match(html,/<strong>Венчик голд<\/strong>/);assert.doesNotMatch(html,/Учётный остаток|Себестоимость|125,341/);
 assert.doesNotMatch(html,/Технические|opaque-|ревизия|api-patch|beforeExists|afterExists|UNWANTED|<pre>/);assert.doesNotMatch(sheet,/phEntity|Все записи|Резерв|Движение|Партия/);
});
test('polling metadata creates no events; historic noise and baselines are filtered before pagination',async()=>{
 const db=await fixture(true);try{
  const variant={market:'WB',nmId:'1892746343',chrtId:3297018063,barcode:'2058617146453',size:'0',vendorCode:'Чехол',checkedAt:100,wbAmount:6,stockObservation:{amount:6,at:100,warehouseId:'595101',pending:false}};
  await db.query("UPDATE warehouse_products SET payload=payload||$1::jsonb WHERE id='one'",[JSON.stringify({wbVariant:variant})]);
  const n=Number((await db.query('SELECT count(*) n FROM product_history')).rows[0].n);
  for(let i=0;i<3;i++)await db.query("UPDATE warehouse_products SET payload=payload||$1::jsonb WHERE id='one'",[JSON.stringify({checkedAt:200+i,wbVariant:{...variant,checkedAt:200+i,wbAmount:10+i,stockObservation:{...variant.stockObservation,amount:10+i,at:200+i}}})]);
  assert.equal(Number((await db.query('SELECT count(*) n FROM product_history')).rows[0].n),n);
  await db.query("UPDATE warehouse_products SET stock=9,payload=payload||$1::jsonb WHERE id='one'",[JSON.stringify({wbVariant:{...variant,barcode:'new-barcode',checkedAt:500}})]);
  let query=historyQuery({productId:'one'}),rows=(await db.query(query.text,query.values)).rows;
  assert.equal(rows.length,2);assert.equal(rows[0].changes.stock,undefined);assert.equal(rows[0].changes.wbVariant.after.barcode,'new-barcode');assert.equal(rows[0].changes.wbVariant.after.checkedAt,undefined);assert.equal(rows[0].changes.wbVariant.after.stockObservation,undefined);
  const noise={wbVariant:{before:variant,after:{...variant,checkedAt:999,stockObservation:{...variant.stockObservation,at:999}},beforeExists:true,afterExists:true}};
  for(let i=0;i<60;i++)await db.query("INSERT INTO product_history(product_id,product_name,entity,entity_id,action,changes) VALUES('one','Малина','product','one','updated',$1::jsonb)",[JSON.stringify(noise)]);
  query=historyQuery({productId:'one'});rows=(await db.query(query.text,query.values)).rows;assert.equal(rows.length,2);assert.ok(rows.every(r=>r.action!=='baseline'));assert.equal((await db.query(historyQuery({productId:'one',before:rows[1].id}).text,historyQuery({productId:'one',before:rows[1].id}).values)).rows.length,0);
  await db.exec("BEGIN;UPDATE warehouse_products SET stock=8 WHERE id='one';INSERT INTO warehouse_audit VALUES(33,100,'hash','fbo-automatic');COMMIT;");
  rows=(await db.query(query.text,query.values)).rows;assert.equal(rows.length,2);assert.equal(rows[0].changes.stock,undefined);const raw=(await db.query('SELECT source,changes FROM product_history ORDER BY id DESC LIMIT 1')).rows[0];assert.equal(raw.source,'fbo-automatic');assert.equal(raw.changes.stock.after,8);
 }finally{await db.close()}
});
test('server excludes all non-card entities before page limits, including legacy filters',async()=>{
 const db=await fixture();try{
  await db.exec("INSERT INTO warehouse_products(id,name,stock,payload) VALUES('p','Карточка',3,'{}')");
  for(const entity of ['reservation','movement','purchase','sale'])for(let i=0;i<15;i++)await db.query("INSERT INTO product_history(product_id,product_name,entity,entity_id,action,changes) VALUES('p','Лишнее',$1,'operation','created',$2::jsonb)",[entity,JSON.stringify({qty:{after:5,afterExists:true,beforeExists:false}})]);
  await db.exec("UPDATE warehouse_products SET name='Новое название' WHERE id='p';DELETE FROM warehouse_products WHERE id='p'");
  const q=historyQuery({productId:'p'}),rows=(await db.query(q.text,q.values)).rows;
  assert.deepEqual(rows.map(r=>r.action),['deleted','updated','created']);assert.ok(rows.every(r=>r.entity==='product'));
  for(const entity of ['reservation','movement','purchase','sale'])assert.throws(()=>historyQuery({entity}),/Неизвестный тип/);
 }finally{await db.close()}
});
test('stock and average-cost updates never duplicate movements in the card journal, including old rows and mixed edits',async()=>{
 const db=await fixture();try{
  await db.exec("INSERT INTO warehouse_products(id,name,stock,payload) VALUES('p','Череп чёрный',0,'{\"cost\":150}')");
  const change=(before,after)=>({before,after,beforeExists:true,afterExists:true});
  for(let i=0;i<60;i++)await db.query("INSERT INTO product_history(product_id,product_name,entity,entity_id,action,changes) VALUES('p','Череп чёрный','product','p','updated',$1::jsonb)",[JSON.stringify({stock:change(0,20),cost:change(150,125.341),totalProfit:change(0,99)})]);
  let q=historyQuery({productId:'p'}),rows=(await db.query(q.text,q.values)).rows;assert.equal(rows.length,1);assert.equal(rows[0].action,'created');assert.equal(rows[0].changes.cost,undefined);assert.equal(rows[0].changes.stock,undefined);
  await db.exec("UPDATE warehouse_products SET name='Череп новый',stock=20,payload=payload||'{\"cost\":125.341}' WHERE id='p'");
  rows=(await db.query(q.text,q.values)).rows;assert.equal(rows.length,2);assert.deepEqual(Object.keys(rows[0].changes),['name']);assert.equal(rows[0].changes.name.before,'Череп чёрный');assert.equal(rows[0].changes.name.after,'Череп новый');
  await db.exec("DELETE FROM warehouse_products WHERE id='p'");rows=(await db.query(q.text,q.values)).rows;assert.deepEqual(rows.map(r=>r.action),['deleted','updated','created']);
 }finally{await db.close()}
});
test.after(()=>pool.end());
