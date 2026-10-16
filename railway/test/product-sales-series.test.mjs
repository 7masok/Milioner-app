import test from 'node:test';
import assert from 'node:assert/strict';
import {pool} from '../src/db.js';
import {reportsRouter} from '../src/reports.js';
import {combineWbSalesSources} from '../src/product-sales-series.js';
const stamp=Date.parse('2026-10-08T00:00:00+03:00');
function row(market,id,operation='Продажа'){return{market,rrd_id:String(id),rr_date:stamp,sale_date:stamp,nm_id:'71',vendor_code:'same',qty:1,operation,doc_type:'Продажа',raw_json:{sellerOperName:operation,currency:'KZT',saleDt:'2026-10-08T00:00:00',sku:'same',quantity:1,forPay:100,retailPriceWithDisc:150}}}
async function invoke({query={from:stamp-86400000,to:stamp+86400000},overflow=false,ambiguous=false,live=[],liveHistory=[]}={}){const handler=reportsRouter.stack.find(x=>x.route?.path==='/wb-product-sales-series').route.stack[0].handle,old=pool.query,calls=[];let status=200,out;pool.query=async(sql,args)=>{calls.push({sql,args});if(sql.startsWith('SELECT f.*'))return{rows:overflow?Array(50001).fill(row('WB',1)):[row('WB',1),row('WB2',1),row('WB',2,'Логистика'),row('WB',3,'Возврат')]};if(sql.includes('FROM product_links'))return{rows:[{market:'WB',sku:'same',productId:'a'},{market:'WB2',sku:'same',productId:'b'},...(ambiguous?[{market:'WB',sku:'same',productId:'c'}]:[])]};if(sql.includes('FROM warehouse_products'))return{rows:['a','b','c'].map(id=>({id,name:id,payload:{}}))};if(sql.includes('FROM wb_sales_live_rows r JOIN'))return{rows:liveHistory};if(sql.includes('FROM wb_sales_live_rows'))return{rows:live};if(sql.includes('GROUP BY market'))return{rows:[{market:'WB',firstDate:1,lastDate:stamp}]};throw Error(sql)};try{await handler({query},{status(n){status=n;return this},json(x){out=x}},e=>{throw e})}finally{pool.query=old}return{status,out,calls}}
test('WB1/WB2 stay separate for the same SKU and rrd; only sales count on their financial calendar day',async()=>{const {status,out,calls}=await invoke();assert.equal(status,200);assert.deepEqual(out.rows.map(x=>[x.market,x.productId,x.day,x.qty]),[['WB','a','2026-10-08',1],['WB2','b','2026-10-08',1]]);assert.ok(calls.every(x=>x.sql.startsWith('SELECT ')));assert.ok(calls[0].sql.includes('LIMIT 50001'));assert.ok(calls[0].sql.includes("='продажа'"));assert.deepEqual(calls[0].args,[['WB','WB2'],stamp-86400000,stamp+86400000]);});
test('ambiguous links are exposed as uncertainty for affected products instead of inventing zero sales',async()=>{const {out}=await invoke({ambiguous:true});assert.deepEqual(out.rows.map(x=>x.productId),['b']);assert.deepEqual(out.uncertain.map(x=>x.productId).sort(),['a','c']);assert.equal(out.unlinked,1);});
test('invalid bounds and overflow are explicit errors; two 365-day windows plus today are supported',async()=>{for(const query of [{from:0,to:1},{from:3,to:2},{from:'x',to:4},{from:1,to:1+732*86400000}]){const result=await invoke({query});assert.equal(result.status,400);assert.equal(result.calls.length,0)}assert.equal((await invoke({query:{from:1,to:1+731*86400000}})).status,200);assert.equal((await invoke({overflow:true})).status,422);});

const DAY=86400000,at=d=>Date.parse(d+'T00:00:00+05:00');
function liveRow(market,id,date,article='same',isReturn=0){return{market,sale_id:id,sale_date:at(date)+3600000,is_return:isReturn,nm_id:'71',vendor_code:article,barcode:'',srid:'live-order-'+id,raw_json:'{}'}}
test('cached live buyouts supply recent full days once, ignore returns and preserve cabinets',async()=>{
 const {out}=await invoke({query:{from:at('2026-10-02'),to:at('2026-10-17')},live:[liveRow('WB','S1','2026-10-08'),liveRow('WB2','S1','2026-10-08'),liveRow('WB','R1','2026-10-08','same',1)],liveHistory:['WB','WB2'].map(market=>({market,firstDate:at('2026-09-01')+3600000,lastSuccessAt:at('2026-10-16')+3600000}))});
 // Finance contains the same buyout on this day: it must not add a second unit.
 assert.deepEqual(out.rows.map(x=>[x.market,x.productId,x.day,x.qty]),[['WB','a','2026-10-08',1],['WB2','b','2026-10-08',1]]);
 assert.equal(out.history.find(x=>x.market==='WB').lastDate,at('2026-10-16')+3600000);
});
test('finance and live meet on complete calendar days; stale partial live days do not replace finance',()=>{
 const rows=['2026-10-02','2026-10-03','2026-10-04','2026-10-05'].map((d,i)=>({...row('WB',i+1),rr_date:at(d),sale_date:0,raw_json:{sellerOperName:'Продажа',quantity:1}}));
 const live=['2026-10-03','2026-10-04','2026-10-05'].map((d,i)=>liveRow('WB','S'+i,d));
 const out=combineWbSalesSources(rows,live,[{market:'WB',firstDate:at('2026-10-01'),lastDate:at('2026-10-05')}],[{market:'WB',firstDate:at('2026-10-03')+3600000,lastSuccessAt:at('2026-10-05')+7200000}],at('2026-10-16'));
 // First live day and last partially synchronized day both stay on finance.
 assert.deepEqual(out.rows.map(r=>r.rrd_id),['1','2','4','live:S1']);
 assert.equal(out.history[0].ranges.length,2);
});
test('a stale failed live refresh retains only its last successful coverage, and precise barcode ambiguity stays unknown',async()=>{
 const {out}=await invoke({ambiguous:true,live:[liveRow('WB','S1','2026-10-08')],liveHistory:[{market:'WB',firstDate:at('2026-09-01'),lastSuccessAt:at('2026-10-15'),lastError:'429'}]});
 assert.deepEqual(out.uncertain.map(x=>x.productId).sort(),['a','c']);
 const h=out.history.find(x=>x.market==='WB');assert.equal(h.ranges[1].to,at('2026-10-15'));
});

test('Kaspi report exposes the last successful refresh even when the newest run has no finished_at',async()=>{
 const handler=reportsRouter.stack.find(x=>x.route?.path==='/kaspi-report-orders').route.stack[0].handle,old=pool.query;let out;
 pool.query=async sql=>{if(sql.includes('FROM sync_runs WHERE market=')){assert.match(sql,/ok=1 AND finished_at>0/);return{rows:[{lastRefreshAt:null,lastSuccessAt:at('2026-10-16')+3600000,lastError:''}]}}if(sql.includes('MIN(creation_date)'))return{rows:[{coverageFrom:at('2026-07-01')}]};return{rows:[]}};
 try{await handler({query:{days:'7'}},{json(x){out=x}},e=>{throw e})}finally{pool.query=old}
 assert.equal(out.lastRefreshAt,null);assert.equal(out.lastSuccessAt,at('2026-10-16')+3600000);assert.deepEqual(out.warnings,[]);
});
