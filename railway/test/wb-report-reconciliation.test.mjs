import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { reconcileWbReportProducts } from '../src/wb-report-reconciliation.js';
import { buildWbOperationAudit } from '../src/wb-operation-audit.js';
import { reportsRouter } from '../src/reports.js';
import { pool } from '../src/db.js';

const START=Date.parse('2026-10-11T00:00:00+05:00'),DAY=86400000;
const rid='eBA.r2f355638374a40bbb17e4409b6cbbbe8.0.0',cost=272.2958803994914;
const links=[{market:'WB',sku:'knife',productId:'knife'}],products=[{id:'knife',name:'Складной ножик Серый',payload:{cost:300}}];
function row(id,operation,shkId,raw={},day=START){return {market:'WB',rrd_id:String(id),rr_date:day,vendor_code:'складной нож с',nm_id:'955111652',qty:operation==='Продажа'?1:0,operation,doc_type:operation==='Продажа'?'Продажа':'',raw_json:{sellerOperName:operation,currency:'KZT',sku:'knife',shkId,srid:rid,...raw}}}
const financeRows=[row(1,'Продажа','58488258887',{quantity:1,retailPriceWithDisc:1687.05,forPay:1101.1,acquiringFee:62.66}),row(2,'Логистика','58488258887',{deliveryService:162.68}),
 row(3,'Логистика','58150723719',{srid:'old-a',deliveryService:163.94}),row(4,'Логистика','58150723719',{srid:'old-a',deliveryService:264}),
 row(5,'Логистика','58469770241',{srid:'old-b',deliveryService:162.68}),row(6,'Логистика','58469770241',{srid:'old-b',deliveryService:261.96})];
const reportRow={productId:'knife',vendorCode:'складной нож с',nmId:'955111652',qty:1,saleQty:1,returnQty:0,retailAmount:1687.05,forPay:1101.1,delivery:1015.26,netBeforeCost:85.84,wbExpenses:1601.21,advertising:0};
const saleCosts=[{market:'WB',productId:'knife',srid:rid,qty:1,cost,stockShortage:0}];
const options={market:'WB',reportRows:[reportRow],financeRows,links,products,purchaseRows:[],saleCosts};

test('one sale does not erase 852.58 expenses on two other stickers; exact saved cost replaces current 300 estimate',()=>{
 const before=JSON.stringify(options),[result]=reconcileWbReportProducts(options);
 assert.equal(result.realizedCostKzt,cost);assert.equal(result.realizedCostEstimated,false);
 assert.ok(Math.abs(result.otherUnitExpenses-852.58)<1e-8);assert.deepEqual(result.otherUnits.map(x=>[x.shkId,x.expense.toFixed(2)]),[['58150723719','427.94'],['58469770241','424.64']]);
 assert.equal((result.netBeforeCost-result.realizedCostKzt).toFixed(2),'-186.46');assert.equal(result.wbExpenses,1601.21);assert.equal(result.netBeforeCost,85.84);assert.equal(JSON.stringify(options),before);
 const lifetime=buildWbOperationAudit({...options,rows:[...financeRows.slice(0,2),row(7,'Возмещение издержек по перевозке','58488258887',{rebillLogisticCost:11.16},START-DAY),row(8,'Возмещение издержек по перевозке','58488258887',{rebillLogisticCost:1.97},START+DAY)],allDates:true});
 const unitProfit=lifetime.operations.reduce((sum,r)=>sum+r.beforeAdsAndCost-(r.costKzt||0),0);
 assert.equal(unitProfit.toFixed(2),'652.99');assert.equal((unitProfit+13.13-result.otherUnitExpenses).toFixed(2),'-186.46');
});
test('missing and foreign cost remain unknown, exact zero is valid, returns restore cost and purchase fallback is marked',()=>{
 const reconcile=extra=>reconcileWbReportProducts({...options,...extra})[0];
 assert.equal(reconcile({saleCosts:[],products:[{id:'knife'}]}).realizedCostKzt,null);
 assert.equal(reconcile({saleCosts:[{...saleCosts[0],cost:0}]}).realizedCostKzt,0);
 const foreign=financeRows.map(r=>({...r,raw_json:{...r.raw_json,currency:'RUB'}}));assert.equal(reconcile({financeRows:foreign}).realizedCostKzt,null);assert.equal(reconcile({financeRows:foreign}).otherUnitExpenses,null);
 const fallback=reconcile({saleCosts:[],purchaseRows:[{productId:'knife',status:'received',qty:1,landedUnitCost:250}]});assert.equal(fallback.realizedCostKzt,250);assert.equal(fallback.realizedCostEstimated,true);
 const returned=row(10,'Возврат','58488258887',{quantity:1,forPay:1101.1});assert.equal(reconcile({financeRows:[returned]}).realizedCostKzt,-cost);
 const adOnly=reconcile({financeRows:[],reportRows:[{...reportRow,qty:0,saleQty:0,retailAmount:0,advertising:100}]});assert.equal(adOnly.realizedCostKzt,0);
 const wrong=reconcile({reportRows:[{...reportRow,productId:'another'}]});assert.equal(wrong.realizedCostKzt,null);
});

async function invoke(oversized=false){
 const handler=reportsRouter.stack.find(x=>x.route?.path==='/wb-finance-products').route.stack[0].handle,old=pool.query,calls=[];let status=200,result;
 pool.query=async(sql,args)=>{calls.push({sql,args});return {rows:sql.startsWith('SELECT f.vendor_code')?[reportRow]:sql.startsWith('SELECT f.*')?(oversized?Array(50001).fill(financeRows[0]):financeRows):sql.includes('FROM warehouse_sales')?saleCosts:sql.includes('FROM warehouse_products')?products:sql.includes('FROM product_links')?links:[]}};
 try{await handler({query:{market:'WB',days:'0',from:String(START),to:String(START+DAY)}},{status(value){status=value;return this},json(value){result=value}},e=>{throw e})}finally{pool.query=old}
 return {status,result,calls};
}
test('finance-products returns authoritative period cost via bounded parameterized cache reads, preserving all period charges',async()=>{
 const out=await invoke();assert.equal(out.status,200);const product=out.result.products[0];assert.equal(product.realizedCostKzt,cost);assert.equal(product.otherUnits.length,2);assert.equal(product.wbExpenses,1601.21);
 assert.ok(out.calls.every(c=>c.sql.startsWith('SELECT ')));assert.deepEqual(out.calls.find(c=>c.sql.startsWith('SELECT f.*')).args,['WB',START,START+DAY]);
 const saved=out.calls.find(c=>c.sql.includes('FROM warehouse_sales'));assert.deepEqual(saved.args,['WB',[rid,'old-a','old-b']]);assert.ok(saved.sql.indexOf("->>'rid'")<saved.sql.indexOf("->>'orderUid'"));
 assert.equal((await invoke(true)).status,422);
});

const source=readFileSync(new URL('../../kaspi-report-v2.js',import.meta.url),'utf8'),line=name=>source.split('\n').find(s=>s.startsWith('function '+name+'('));
function ui(){let sheet='';const c={fmt:n=>String(n)+' ₸',esc:s=>String(s??'').replaceAll('<','&lt;'),storeTitle:()=> 'WB 1',detailPeriodHtml:()=>'',wbFinanceAvailabilityNote:()=>'',wbLiveProductId:(_market,x)=>x.productId,productNameById:()=> 'Складной ножик Серый',showSheet:s=>{sheet=s},wbRealizedFifoCost:()=>{throw Error('current stock must not replace saved period cost')}};vm.runInNewContext(['wbReportProductCost','wbReportAmount','wbCostFromProducts','paintStoreSheet','paintWbSheet'].map(line).join('\n'),c);return {c,get sheet(){return sheet}}}
test('main card and store cost use 272.30, label period loss, and show other-unit charges instead of claiming the single unit lost money',()=>{
 const [product]=reconcileWbReportProducts(options),f=ui(),info=f.c.wbCostFromProducts('WB',0,[product]);assert.equal(info.cost,cost);assert.equal(info.complete,true);
 f.c.paintWbSheet({financeAvailable:true,complete:true,revenue:1687.05,cost,expenses:1601.21,ads:0,adjustment:0,profit:85.84-cost,products:[product]},'WB',0);
 const text=f.sheet.replaceAll('\u00a0',' ');assert.ok(text.includes('272,3 ₸'));assert.ok(text.includes('-186,46 ₸'));assert.ok(text.includes('Прибыль за период'));assert.ok(text.includes('Расходы за период'));assert.ok(text.includes('В т. ч. по другим ШК: 852,58 ₸ · 2 ШК'));assert.ok(!text.includes('300 ₸'));
 const unknown={...product,realizedCostKzt:null};f.c.paintWbSheet({financeAvailable:true,complete:false,products:[unknown]},'WB',0);assert.ok(f.sheet.includes('Себестоимость</span><b>—'));assert.ok(f.sheet.includes('Прибыль за период</div><b>—'));
});
