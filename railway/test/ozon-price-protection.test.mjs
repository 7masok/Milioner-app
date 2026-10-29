import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {money,newJob,step,safeExit,priceFindings} from '../src/ozon-protection/engine.js';
import {withOzonProtectionPage} from '../src/ozon-protection/page.js';
process.env.APP_ADMIN_TOKEN='ozon-protection-test';process.env.WAREHOUSE_WRITES_ENABLED='true';
const {saveProtection,runOzonProtectionAccount,createOzonRequester,retryAt}=await import('../src/ozon-protection/service.js');
const {createOzonProtectionRouter}=await import('../src/ozon-protection/router.js');
const {createSessionToken}=await import('../src/auth.js');
const {pool}=await import('../src/db.js');
const p={account:'shop',offer_id:'offer',product_id:'123',enabled:true,protected_price:1000,currency:'RUB'};
const m=(value,currency_code='RUB')=>({value:String(value),currency_code});
const prices=()=>({items:[{offer_id:'offer',product_id:123,price:{price:'1000',min_price:'1000',marketing_seller_price:'1000',currency_code:'RUB'}}]});
const taskJob=task=>({tasks:[task],issues:{},cycleAt:Date.parse('2026-10-29T00:00:00Z')});
const err=(message,status)=>Object.assign(Error(message),{status});

test('fixed approved price disables price strategies and seller discounts without changing neighbouring offers',async()=>{
 let call;const job=taskJob({kind:'pin',offers:['offer']});const out=await step(job,[p],async(path,body)=>{call={path,body};return{result:[{offer_id:'offer',updated:true,errors:[]}]}});
 assert.equal(call.path,'/v1/product/import/prices');assert.deepEqual(call.body.prices,[{offer_id:'offer',price:'1000',old_price:'0',min_price:'1000',currency_code:'RUB',auto_action_enabled:'DISABLED',price_strategy_enabled:'DISABLED',min_price_for_auto_actions_enabled:true}]);assert.equal(out.done,true);assert.equal(job.tasks[0].kind,'pin');assert.deepEqual(out.job.issues,{});
});
test('partial HTTP-200 price import remains a visible issue rather than an applied protection',async()=>{
 const out=await step(taskJob({kind:'pin',offers:['offer']}),[p],async()=>({result:[{offer_id:'offer',updated:false,errors:[{code:'INVALID_PRICE'}]}]}));assert.match(out.job.issues.offer.join(),/INVALID_PRICE/);
});
test('new exit uses fixed Money price above known threshold, never raises or compounds an approved price',async()=>{
 assert.equal(safeExit(p,{max_action_price:m(1000)}),null);assert.equal(safeExit(p,{max_action_price:m(1200)}),null);assert.equal(safeExit(p,{max_action_price:m(900,'KZT')}),null);assert.equal(safeExit(p,{max_action_price:{value:'900'}}),null);
 let job=taskJob({kind:'delete-active',action:'50',product:'123',row:{max_action_price:m(900)}});let out=await step(job,[p],async()=>{throw err('Unsupported action',400)});assert.equal(out.job.tasks[0].kind,'exit-price');assert.deepEqual(out.job.tasks[0].change,{product_id:123,action_price:m('1000.00')});
 let sent;out=await step(out.job,[p],async(path,body)=>{sent={path,body};return{deactivated_product_ids:[123],active_product_ids:[]}});assert.equal(sent.path,'/v1/actions/products/update');assert.equal(sent.body.products[0].action_price.value,'1000.00');assert.deepEqual(out.job.issues,{});
 const blocked=await step(taskJob({kind:'delete-active',action:'50',product:'123',row:{max_action_price:m(1200)}}),[p],async()=>{throw err('Unsupported',400)});assert.equal(blocked.job.tasks.length,0);assert.match(blocked.job.issues.offer.join(),/выше 1200/);
});
test('promo code exclusion uses v2 confirmation and unsupported HTTP-200 results take only a safe fallback',async()=>{
 const job=taskJob({kind:'delete-active',action:'50',product:'123',row:{max_action_price:m(900)}});let path;
 const out=await step(job,[p],async(url,body)=>{path=url;assert.deepEqual(body,{action_id:50,product_ids:[123]});return{product_ids:[123]}});assert.equal(path,'/v2/actions/products/deactivate');assert.deepEqual(out.job.issues,{});
 const notConfirmed=await step(job,[p],async()=>({product_ids:[]}));assert.equal(notConfirmed.job.tasks[0].kind,'exit-price');
});
test('future waves retain exact dates and product IDs, read offset pages before shrinking removals',async()=>{
 const date='2026-11-01T09:25:00Z',job=taskJob({kind:'future',action:'50',date,offset:0,verify:false});
 const out=await step(job,[p],async(path,body)=>{assert.equal(path,'/v2/actions/auto-add/products/list');assert.equal(body.auto_add_date,date);return{products:Array.from({length:100},(_,i)=>({id:i===0?123:500+i}))}});
 assert.equal(out.job.tasks[0].kind,'future');assert.equal(out.job.tasks[0].offset,100);assert.equal(out.job.tasks[1].kind,'delete-future');
 const deleted=await step(taskJob(out.job.tasks[1]),[p],async(path,body)=>{assert.equal(path,'/v2/actions/auto-add/products/delete');assert.equal(body.auto_add_date,date);assert.deepEqual(body.product_ids,[123]);return{product_ids:[123]}});assert.deepEqual(deleted.job.issues,{});
});
test('active pagination uses last_id and absent wave metadata cannot produce a clean status',async()=>{
 const out=await step(taskJob({kind:'active',action:'50',last_id:'',verify:true}),[p],async()=>({products:Array.from({length:100},(_,i)=>({id:i+123}))}));assert.equal(out.job.tasks[0].last_id,'222');assert.match(out.job.issues.offer.join(),/участие/);
 const waves=await step(taskJob({kind:'actions',verify:false}),[p],async()=>({result:[{id:50}]}));assert.match(waves.job.issues.offer.join(),/даты/);
 await assert.rejects(step(taskJob({kind:'active',action:'50',last_id:'222'}),[p],async()=>({products:Array(100).fill({id:222})})),/повторил/);
});
test('a complete cycle requires re-reading current actions, future waves and final seller price',async()=>{
 const active=new Set(['123']),future=new Set(['123']),calls=[];let job=newJob([p]);job.cycleAt=Date.parse('2026-10-29T00:00:00Z');
 const request=async(path,body,method)=>{calls.push(path);if(path.endsWith('import/prices'))return{result:[{offer_id:'offer',updated:true}]};if(path==='/v1/actions'){assert.equal(method,'GET');return{result:[{id:50,auto_add_dates:['2026-11-01T10:00:00Z']}]}}if(path==='/v2/actions/products')return{products:[...active].map(id=>({id,max_action_price:m(900)}))};if(path.endsWith('auto-add/products/list'))return{products:[...future].map(id=>({id}))};if(path.endsWith('products/deactivate')){active.clear();return{product_ids:[123]}}if(path.endsWith('auto-add/products/delete')){future.clear();return{product_ids:[123]}}if(path.endsWith('info/prices'))return prices();throw Error('Unexpected '+path)};
 for(let n=0;n<20;n++){const out=await step(job,[p],request);job=out.job;if(out.done)break}
 assert.equal(job.tasks.length,0);assert.deepEqual(job.issues,{});assert.equal(calls.filter(x=>x==='/v1/actions').length,2);assert.equal(calls.filter(x=>x==='/v2/actions/products').length,2);assert.equal(calls.at(-1),'/v5/product/info/prices');
});
test('remaining seller promotion, unknown prices and currency mismatches never become success; Ozon subsidy is separate',()=>{
 const subsidized=prices();subsidized.items[0].price.marketing_price='700';assert.equal(priceFindings(subsidized,[p])[0].error,'');subsidized.items[0].price.marketing_seller_price='800';assert.match(priceFindings(subsidized,[p])[0].error,/скидку/);assert.match(priceFindings({items:[]},[p])[0].error,/не получена/);
 const unknown=prices();delete unknown.items[0].price.marketing_seller_price;assert.match(priceFindings(unknown,[p])[0].error,/не подтвердил/);const wrong=prices();wrong.items[0].price.currency_code='KZT';assert.match(priceFindings(wrong,[p])[0].error,/Валюта/);assert.equal(money(m('10','KZT'),'RUB'),null);
});
function database(){
 const db={prefs:[],sync:null,calls:[],locked:true,query:async(sql,args)=>{
  db.calls.push({sql,args});if(sql.includes('pg_try_advisory_lock'))return{rows:[{locked:db.locked}]};if(sql.includes('FROM ozon_protection_catalog'))return{rows:[{offer_id:'offer',product_id:'123',currency:'RUB',updated_at:Date.now()}]};if(sql.includes('SELECT * FROM ozon_price_protection'))return{rows:db.prefs};if(sql.includes('SELECT * FROM ozon_protection_sync'))return{rows:db.sync?[db.sync]:[]};return{rows:[]};
 },release(){}};db.connect=async()=>db;return db;
}
test('server validates exact identity and currency, persists preference and resets work atomically, without Ozon writes',async()=>{
 const db=database();await saveProtection('shop',[{sku:'offer',remoteId:'123',price:1000,currency:'RUB'}],true,{db});assert.ok(db.calls.some(q=>q.sql==='BEGIN'));assert.ok(db.calls.some(q=>q.sql==='COMMIT'));assert.ok(db.calls.some(q=>q.sql.includes('ON CONFLICT(account,offer_id)')));assert.ok(db.calls.some(q=>q.sql.includes("job='{}'")));
 for(const change of [{currency:'KZT'},{remoteId:'999'},{sku:'other'}])await assert.rejects(saveProtection('shop',[{sku:'offer',remoteId:'123',price:1000,currency:'RUB',...change}],true,{db}),/не найден/);
 await assert.rejects(saveProtection('shop',[null],true,{db}),/Проверьте/);db.locked=false;await assert.rejects(saveProtection('shop',[{sku:'offer',remoteId:'123',price:1000,currency:'RUB'}],true,{db}),/сейчас/);
});
test('worker persists remaining queue and retry time after restart, respects disabled preference and long 429 retry',async()=>{
 const db=database();db.prefs=[p];let writes=0;await runOzonProtectionAccount('shop',{db,request:async()=>{writes++;throw Object.assign(err('Rate limited',429),{retryAt:Date.now()+7200000})}});assert.equal(writes,1);const stored=db.calls.find(q=>q.sql.includes('INSERT INTO ozon_protection_sync'));assert.ok(stored.args[1]>Date.now()+7100000);assert.equal(JSON.parse(stored.args[2]).tasks[0].kind,'identity');
 db.sync={next_at:Date.now()+7200000,job:JSON.parse(stored.args[2])};await runOzonProtectionAccount('shop',{db,request:async()=>{writes++}});assert.equal(writes,1);db.sync=null;db.prefs=[];await runOzonProtectionAccount('shop',{db,request:async()=>{writes++}});assert.equal(writes,1);
});
test('requester uses safe headers and GET, redacts credentials, respects Retry-After',async()=>{
 const credentials={apiKey:'SECRET',clientId:'CLIENT'};let options;const send=createOzonRequester(credentials,async(url,opts)=>{options=opts;return new Response(JSON.stringify({result:[]}),{status:200})});await send('/v1/actions',null,'GET');assert.equal(options.method,'GET');assert.equal(options.body,undefined);
 const fail=createOzonRequester(credentials,async()=>new Response(JSON.stringify({message:'SECRET CLIENT denied'}),{status:403,headers:{'Retry-After':'7200'}}));await assert.rejects(fail('/v1/actions',null,'GET'),e=>!e.message.includes('SECRET')&&!e.message.includes('CLIENT')&&e.retryAt>Date.now()+7100000);assert.equal(retryAt(new Response('{}',{headers:{'Retry-After':'7200'}}),1000),7201000);
});
test('owner, trusted origin and explicit confirmation guard local preference writes',async()=>{
 const express=(await import('express')).default;let saves=0;const app=express();app.use(express.json());app.use('/api',createOzonProtectionRouter({db:{query:async()=>({rows:[{id:'shop'}]})},save:async()=>{saves++;return{ok:true}}}));app.use((e,req,res,next)=>res.status(e.status||500).json({error:e.message}));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.on('listening',r));const url='http://127.0.0.1:'+server.address().port+'/api/ozon-price-protection',token=createSessionToken().token;
 const send=(body,auth=token,Origin='https://7masok.github.io')=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Origin,...(auth?{Authorization:'Bearer '+auth}:{})},body:JSON.stringify(body)});
 try{assert.equal((await send({},'')).status,401);assert.equal((await send({},token,'https://evil.invalid')).status,403);assert.equal((await send({})).status,400);assert.equal((await send({confirm:true,accountId:'shop',items:[],enabled:true})).status,200);assert.equal(saves,1)}finally{await new Promise(r=>server.close(r))}
});
test('UI only writes after explicit action and companion loads before auth with cache versioning',()=>{
 const source=readFileSync(new URL('../../ozon-price-protection-v1.js',import.meta.url),'utf8');let requests=0;const window={},context={window,document:{},Date,console,fetch:()=>{requests++;throw Error('unexpected')}};vm.runInNewContext(source,context);assert.equal(requests,0);assert.match(window.ozonProtectionEditor({price:1000,currency:'RUB',ozonProtection:{enabled:true,price:1000,status:'error',message:'Denied <tag>'}},0),/Denied &lt;tag&gt;/);
 const page=withOzonProtectionPage('<script src="./prices-v1.js?v=old"></script><script>initOwnerAuth();</script>');assert.match(page,/prices-v1.js\?v=20261029-ozon-protection/);assert.ok(page.indexOf('ozon-price-protection-v1.js')<page.indexOf('initOwnerAuth();'));
});
test('reused offer or changed currency is blocked before any remote price or promotion mutation',async()=>{
 let calls=[];let job=newJob([p]);const send=async(path)=>{calls.push(path);if(path.includes('info/prices'))return{items:[{offer_id:'offer',product_id:999,price:{currency_code:'RUB'}}]};if(path==='/v1/actions')return{result:[]};throw Error('Unexpected mutation '+path)};
 for(let n=0;n<10;n++){const out=await step(job,[p],send);job=out.job;if(out.done)break}assert.ok(job.blocked.includes('offer'));assert.match(job.issues.offer.join(),/изменились/);assert.ok(calls.every(path=>path.includes('info/prices')||path==='/v1/actions'));
});
test('ordinary price edit cannot race or overwrite an enabled fixed protection',async()=>{
 const {pricesRouter}=await import('../src/prices.js');const handler=pricesRouter.stack.find(x=>x.route?.path==='/market-prices/update').route.stack.at(-1).handle,originalConnect=pool.connect,originalFetch=globalThis.fetch,db=database();db.prefs=[p];pool.connect=async()=>db;let external=0,status=200,out;globalThis.fetch=async()=>{external++;throw Error('not allowed')};
 try{await handler({body:{confirm:true,market:'Ozon',accountId:'shop',sku:'offer',price:700}},{status(n){status=n;return this},json(x){out=x}},e=>{throw e});assert.equal(status,409);assert.match(out.error,/защита/);assert.equal(external,0)}finally{pool.connect=originalConnect;globalThis.fetch=originalFetch}
});
test.after(()=>pool.end());
