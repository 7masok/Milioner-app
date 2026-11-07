import {readFileSync} from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {pool,withDatabaseReadClient} from '../src/db.js';
import {createBusinessReportRuntime} from '../src/business-report-runtime.js';
import {runBusinessReportWorker,businessOzonFeed} from '../src/business-report-worker.js';
import {readBusinessPreparation,queueBusinessReports} from '../src/business-report-jobs.js';
import {sourceRevision,composeBusinessSelection} from '../src/business-dashboard-cache.js';
const DAY=86400000,FROM=Date.parse('2026-07-01T00:00:00+05:00');
const state=()=>({settings:{},products:[{id:'p',name:'Toy',kaspi:'s',wb:'s',wb2:'s',ozon:'s',cost:100}],sales:[],purchases:[],kaspiOrderFeed:[],kaspiAdExpenses:[]});
const completed={id:'a',status:'COMPLETED',creationDate:FROM,completionDate:FROM+3600000,totalPrice:1000,lines:[{entryId:'e',merchantCode:'s',quantity:2,totalPrice:1000}]};
const order={market:'Kaspi',orderId:'a',entryId:'e',creationDate:FROM,status:'COMPLETED',qty:2,totalPrice:1000,productId:'p'};
test('server calculation needs no DOM, browser, timers or network; Kaspi daily ads are not repeated across days',async()=>{
 const s=state();s.kaspiAdExpenses=[{id:'ads',campaignName:'one',fromDate:'2026-07-01',toDate:'2026-07-02',importedAt:1,lines:[{date:'2026-07-01',amount:20,productId:'p'}]}];
 const paths=[],r=createBusinessReportRuntime({state:s,market:'Kaspi',now:FROM+DAY,readApi:async path=>{paths.push(path);return{ok:true,orders:[completed],returns:[]}}});
 const unitProfit=await r.forecast(),days=await r.calculate({from:FROM,to:FROM+2*DAY,orders:[order,{...order,orderId:'cancel',status:'CANCELLED'}],unitProfit});
 assert.equal(days.length,2);assert.equal(days[0].orders.amount,1000);assert.equal(days[0].orders.orderCount,1);assert.equal(days[0].orders.qty,2);assert.equal(days[0].summary.cost,200);
 assert.equal(days[0].summary.ads,20);assert.equal(days[1].summary.ads,0);assert.ok(Math.abs(days[0].summary.profit-510.114)<.0001);assert.ok(Math.abs(days[0].orders.profit-510.114)<.0001);
 assert.ok(paths.every(p=>p.startsWith('/api/kaspi-report-orders?')));
});
test('WB1 and WB2 keep seller-price finances, realized cost and unknown profit unchanged on the server',async()=>{
 for(const market of ['WB','WB2']){
  const summary={retailAmount:1000,forPay:800,acquiring:20,delivery:50,advertising:30,financeAvailable:true,financeRowCount:1},product={productId:'p',qty:2,saleQty:2,netBeforeCost:700,realizedCostKzt:200,realizedCostEstimated:false};
  const r=createBusinessReportRuntime({state:state(),market,now:FROM+DAY,readApi:async path=>path.includes('summary')?summary:{ok:true,products:[product],daily:[{day:'2026-07-01',summary,products:[product]}]}});
  const u=await r.forecast(),days=await r.calculate({from:FROM,to:FROM+DAY,orders:[{...order,market}],unitProfit:u});
  assert.equal(days[0].summary.revenue,1000);assert.equal(days[0].summary.profit,520);assert.equal(days[0].orders.profit,500);assert.equal(days[0].summary.cost,200);
  const unknown=createBusinessReportRuntime({state:state(),market,now:FROM+DAY,readApi:async()=>({ok:true,daily:[{day:'2026-07-01',summary:{},products:[]}]})});
  assert.equal((await unknown.calculate({from:FROM,to:FROM+DAY,orders:[]}))[0].summary.profit,null);
 }
});
test('Ozon uses finance operation date for sales and real posting creation/delivery dates for orders',async()=>{
 const payload={configured:true,accounts:[{account:'oz',postings:{from:'2025-01-01T00:00:00Z',to:'2026-08-01T00:00:00Z',rows:[{posting_number:'n',created_at:new Date(FROM).toISOString(),delivered_date:new Date(FROM+DAY).toISOString(),status:'delivered',products:[{sku:'s',quantity:2,price:500}]}]},finance:{from:'2025-01-01T00:00:00Z',to:'2026-08-01T00:00:00Z',rows:[{operation_date:new Date(FROM+DAY).toISOString(),operation_type_name:'Продажа',amount:1000,accruals_for_sale:1000,items:[{sku:'s'}],posting:{posting_number:'n'},currency_code:'KZT'}]}}]};
 const s=state(),feed=businessOzonFeed(payload,s.products),r=createBusinessReportRuntime({state:s,market:'Ozon',now:FROM+2*DAY,readApi:async()=>payload});
 const days=await r.calculate({from:FROM,to:FROM+2*DAY,orders:feed,ozonFeed:feed});
 assert.equal(days[0].orders.amount,1000);assert.equal(days[1].orders.amount,0);assert.equal(days[0].summary.revenue,0);assert.equal(days[1].summary.revenue,1000);assert.equal(days[1].summary.profit,800);
});
test('prepared custom-store combinations keep known sums and explicitly flag missing stores',()=>{
 const day={market:'Kaspi',storeStarts:'{}',period:'day',bounds:{start:FROM,end:FROM+DAY},buckets:Array.from({length:24},(_,h)=>({start:FROM+h*3600000,end:FROM+(h+1)*3600000,orders:h?0:100,orderQty:h?0:2})),orders:{amount:100,qty:2,profit:20,coveredAmount:100,coveredQty:2,orderCount:1,coverage:1},events:[],summary:{revenue:80,qty:1,profit:10},pending:false,ordersReady:true};
 const out=composeBusinessSelection([{sourceRevision:'a',days:[{day,generatedAt:FROM+3*DAY,fresh:true}]},null],['Kaspi','WB3'],FROM,FROM+DAY,FROM+4*DAY);
 assert.equal(out.serverManaged,true);assert.equal(out.days.length,1);assert.equal(out.days[0].day.storeSelection,'Kaspi,WB3');assert.equal(out.days[0].day.orders.amount,100);assert.equal(out.days[0].day.summary.revenue,80);assert.equal(out.days[0].day.summary.profit,null);assert.deepEqual(out.days[0].day.ordersPartialMarkets,['WB3']);
});
test('database read contexts are isolated between concurrent calculations',async()=>{
 const a={query:async()=>({rows:[{n:'a'}]})},b={query:async()=>({rows:[{n:'b'}]})};
 const result=await Promise.all([withDatabaseReadClient(a,async()=>{await new Promise(r=>setImmediate(r));return pool.query('SELECT 1')}),withDatabaseReadClient(b,()=>pool.query('SELECT 1'))]);
 assert.deepEqual(result.map(r=>r.rows[0].n),['a','b']);
});
async function database(){
 const db=new PGlite();await db.exec(`CREATE TABLE warehouse_state(id int,revision bigint,payload text);INSERT INTO warehouse_state VALUES(1,1,'{}');
 CREATE TABLE marketplace_credentials(provider text,updated_at bigint);CREATE TABLE sync_runs(finished_at bigint,ok int);CREATE TABLE wb_finance_sync_runs(finished_at bigint,finance_ok int);CREATE TABLE wb_ad_costs(updated_at bigint);CREATE TABLE warehouse_sales(updated_at bigint);CREATE TABLE product_links(updated_at bigint);CREATE TABLE ozon_fbo_cache(updated_at bigint);CREATE TABLE wb_sales_live_state(last_success_at bigint);CREATE TABLE wb_order_history(updated_at bigint);CREATE TABLE kaspi_order_history(updated_at bigint);CREATE TABLE kaspi_order_history_state(payload jsonb);
 CREATE TABLE business_dashboard_cache(cache_key text primary key,version text,source_revision text,payload jsonb,generated_at bigint);
 CREATE TABLE business_report_jobs(job_key text primary key,market text,range_from bigint,range_to bigint,priority int default 0,next_at bigint default 0,started_at bigint default 0,completed_at bigint default 0,source_revision text default '',last_error text default '');`);
 await db.query('INSERT INTO business_report_jobs(job_key,market,range_from,range_to) VALUES($1,$2,$3,$4)',['job','Kaspi',FROM,FROM+DAY]);return db;
}
async function knownDay(){return(await createBusinessReportRuntime({state:state(),market:'Kaspi',now:FROM+DAY,readApi:async()=>({ok:true,orders:[completed],returns:[]})}).calculate({from:FROM,to:FROM+DAY,orders:[order]}))[0]}
test('closed-browser worker saves a consistent result despite a concurrent input update and schedules a retry',async()=>{
 const db=await database(),original=pool.query;let released=false,reads=0,changed=false;const sql=[];
 const client={release(){released=true},async query(q,args){sql.push(q);if(q.includes('pg_try_advisory_lock'))return{rows:[{locked:true}]};if(q.includes('pg_advisory_unlock'))return{rows:[]};const result=await db.query(q,args);if(q==='COMMIT'&&!changed){changed=true;await db.query('UPDATE warehouse_state SET revision=2')}return result}};
 pool.query=(...args)=>db.query(...args);
 try{const day=await knownDay(),out=await runBusinessReportWorker({clientPool:{connect:async()=>client},calculate:async(_job,{client})=>{const check=await client.query('SHOW transaction_read_only');assert.equal(check.rows[0].transaction_read_only,'on');reads++;return[day]}});
  assert.equal(out.days,1);assert.equal(reads,1);assert.equal(released,true);
  const saved=(await db.query('SELECT * FROM business_dashboard_cache')).rows;assert.equal(saved.length,1);assert.equal(saved[0].payload.orders.amount,1000);assert.notEqual(saved[0].source_revision,await sourceRevision());
  const prepared=await readBusinessPreparation(pool,'Kaspi',{from:FROM,to:FROM+DAY});assert.equal(prepared.saved,1);assert.equal(prepared.orders,1);assert.equal(prepared.finance,1);
  const job=(await db.query('SELECT * FROM business_report_jobs')).rows[0];assert.equal(job.last_error,'');assert.ok(Number(job.next_at)-Number(job.completed_at)<=15000);
  assert.ok(sql.every(q=>!/^(UPDATE|INSERT INTO|DELETE FROM) (warehouse_state|warehouse_products|warehouse_sales|warehouse_purchases|marketplace_order_lines|reservations)/.test(q)));
 }finally{pool.query=original;await db.close()}
});
test('failed persistence rolls back the whole batch, retains the prior report and leaves a retry on the server',async()=>{
 const db=await database(),original=pool.query;let fail=true;const prior=await knownDay();prior.orders.amount=77;
 await db.query('INSERT INTO business_dashboard_cache VALUES($1,$2,$3,$4,$5)',['base:'+FROM+':Kaspi','calendar-v2','prior',JSON.stringify(prior),1]);
 const client={release(){},async query(q,args){if(q.includes('pg_try_advisory_lock'))return{rows:[{locked:true}]};if(q.includes('pg_advisory_unlock'))return{rows:[]};if(fail&&q.startsWith('UPDATE business_report_jobs SET completed_at')){fail=false;throw Error('fixture write failure')}return db.query(q,args)}};
 pool.query=(...args)=>db.query(...args);
 try{const out=await runBusinessReportWorker({clientPool:{connect:async()=>client},calculate:async()=>[await knownDay()]});assert.match(out.error,/fixture write failure/);const row=(await db.query('SELECT payload FROM business_dashboard_cache')).rows[0];assert.equal(row.payload.orders.amount,77);assert.match((await db.query('SELECT last_error FROM business_report_jobs')).rows[0].last_error,/fixture write failure/)}finally{pool.query=original;await db.close()}
});

test('requested ranges coalesce with the persistent history grid rather than creating overlapping month jobs',async()=>{
 const db=await database(),old=pool.query;pool.query=(...args)=>db.query(...args);
 try{await queueBusinessReports('Kaspi',FROM,FROM+3*DAY);await queueBusinessReports('Kaspi',FROM+DAY,FROM+4*DAY);const rows=(await db.query("SELECT * FROM business_report_jobs WHERE job_key<>'job'")).rows;assert.equal(rows.length,1);assert.ok(Number(rows[0].range_from)<=FROM);assert.equal(Number(rows[0].range_to),FROM+4*DAY)}finally{pool.query=old;await db.close()}
});
test('a missing forecast source does not block another store calculation',async()=>{
 const r=createBusinessReportRuntime({state:state(),market:'Kaspi',forecastMarkets:['Kaspi','WB2'],now:FROM+DAY,readApi:async path=>{if(path.includes('market=WB2'))throw Error('fixture source unavailable');return{ok:true,orders:[completed],returns:[]}}});
 const u=await r.forecast();assert.deepEqual(u.incompleteSources,['WB2']);assert.equal(u.get('p').sources.Kaspi.qty,2);assert.equal((await r.calculate({from:FROM,to:FROM+DAY,orders:[order],unitProfit:u}))[0].summary.revenue,1000);
});

test('the report worker starts for both the main warehouse and the WB3 service',()=>{
 const source=readFileSync(new URL('../src/server.js',import.meta.url),'utf8'),startup=source.slice(source.indexOf("const server = app.listen"));
 assert.ok(startup.indexOf('startBusinessReportProcess();')>=0);assert.ok(startup.indexOf('startBusinessReportProcess();')<startup.indexOf("if(config.storeProfile!=='WB3')"));
});
