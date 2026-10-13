import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {wbFinancePeriodDate,wbFinancePeriodSql} from '../src/wb-finance-period.js';
import {buildWbOperationAudit} from '../src/wb-operation-audit.js';
const START=Date.parse('2026-10-11T00:00:00+05:00'),DAY=86400000;
const event=(operation,sale,rr=START)=>({market:'WB',rrd_id:operation+sale,operation,doc_type:'Продажа',rr_date:rr,sale_date:Date.parse(sale),qty:1,raw_json:{saleDt:sale,sellerOperName:operation,currency:'KZT',retailPriceWithDisc:1850,retailAmount:1480,forPay:operation==='Логистика'?0:1390}});
test('WB calendar uses event day in Moscow for sales/returns/delivery, keeping Almaty date-selector encoding',()=>{
 const before=event('Продажа','2026-10-10T20:59:59Z'),after=event('Продажа','2026-10-10T21:00:00Z');
 assert.ok(wbFinancePeriodDate(before)<START);assert.equal(wbFinancePeriodDate(after),START);
 const delayed=event('Логистика','2026-10-11T12:00:00Z',START+DAY);
 const old=event('Логистика','2026-10-10T12:00:00Z',START);
 const data=buildWbOperationAudit({market:'WB',rows:[before,after,delayed,old],since:START,until:START+DAY});
 assert.equal(data.rowCount,2);assert.equal(data.operations.find(x=>x.kind==='sale').sellerRevenue,1850);
 assert.equal(data.operations.find(x=>x.kind==='logistics').date,START+DAY);
 const full=buildWbOperationAudit({market:'WB',rows:[before,after,delayed,old],since:START,until:START+DAY,allDates:true});assert.equal(full.rowCount,4);
});
test('storage, penalties and advertising deductions stay on posting day; invalid/missing event dates use report day',()=>{
 for(const operation of ['Хранение','Штраф','Удержание'])assert.equal(wbFinancePeriodDate(event(operation,'2026-10-05T12:00:00Z')),START);
 const unknown=event('Логистика','0001-01-01T00:00:00Z');unknown.sale_date=Date.now();assert.equal(wbFinancePeriodDate(unknown),START);
 const sql=wbFinancePeriodSql('f');assert.ok(sql.includes('f.sale_date-7200000'));assert.ok(sql.includes('ELSE f.rr_date END'));assert.ok(sql.includes("NULLIF(f.raw_json::jsonb->>'sale_dt','')"));
});
test('seller revenue includes seller discount but excludes WB discount; returns reverse once and logistics is not another sale',()=>{
 const sale=event('Продажа','2026-10-11T12:00:00Z'),returned=event('Возврат','2026-10-11T13:00:00Z'),delivery=event('Логистика','2026-10-11T13:00:00Z');
 const data=buildWbOperationAudit({market:'WB',rows:[sale,returned,delivery],since:START,until:START+DAY});
 assert.equal(data.totals[0].sellerRevenue,0);assert.equal(data.totals[0].saleQty,1);assert.equal(data.totals[0].returnQty,1);assert.equal(data.totals[0].forPay,0);
 const free=event('Продажа','2026-10-11T14:00:00Z');free.raw_json.retailPriceWithDisc=0;
 assert.equal(buildWbOperationAudit({market:'WB',rows:[free],since:START,until:START+DAY}).totals[0].sellerRevenue,0);
});
test('WB1 screenshot financial model separates acquiring already in payout and ad spend from later billing',()=>{
 const source=readFileSync(new URL('../../kaspi-report-v2.js',import.meta.url),'utf8');
 const fn=source.split('\n').find(x=>x.startsWith('function wbExpenseModel('));
 const c={wbCostFromProducts:()=>({cost:6579,complete:true})};vm.runInNewContext(fn,c);
 const summary={financeAvailable:true,retailAmount:58215.94,forPay:40547.69,acquiring:2113.15,delivery:12665.49,rebill:1041,storage:35.21,penalty:290.81,advertising:916,promotionDeduction:8559};
 const m=c.wbExpenseModel(summary,[],'WB',0);assert.ok(Math.abs(m.commission-15555.1)<1e-8);assert.ok(Math.abs(m.commission+m.acquiring-17668.25)<1e-8);assert.ok(Math.abs(m.expenses-31700.76)<1e-8);assert.ok(Math.abs(m.profit-19020.18)<1e-8);assert.equal(m.promotionDeduction,8559);assert.equal(m.ads,916);
 const returned=c.wbExpenseModel({financeAvailable:true,retailAmount:-1000,forPay:-700,acquiring:-20},[],'WB',1);assert.equal(returned.commission,-280);assert.equal(returned.expenses,-300);
});
