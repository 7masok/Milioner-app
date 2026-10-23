import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../../kaspi-ads-v2-original.js',import.meta.url),'utf8');
function load(batches){const prefix=source.slice(source.indexOf('  function localDateRange'),source.indexOf('  function kaspiStrictSkuMatches'));const ctx={window:{},state:{kaspiAdExpenses:batches},DAY_MS:86400000,reportPeriod:7,orderDayStart:v=>{const t=Date.parse(v+'T00:00:00+05:00');return Number.isFinite(t)?t:null},kaspiAdsNameKey:v=>String(v).trim().toLowerCase(),kaspiAdsSourceKey:v=>v,kaspiAdsIsoDate:v=>v,kaspiAdsMatchProduct:row=>row.productId?{id:row.productId}:null,reportPeriodStart:()=>Date.parse('2026-10-19T00:00:00+05:00'),reportPeriodEnd:()=>Date.parse('2026-10-26T00:00:00+05:00')};vm.createContext(ctx);vm.runInContext(prefix,ctx);return ctx.window.kaspiAdsBreakdown}
test('Kaspi dated week import immediately serves each individual day without reimport or allocation',()=>{
 const lines=Array.from({length:7},(_,i)=>({date:'2026-10-'+(19+i),amount:i+1,productId:'p'}));const breakdown=load([{id:'daily',campaignName:'campaign',fromDate:'2026-10-19',toDate:'2026-10-25',lines,importedAt:1}]);
 assert.equal(breakdown(7).total,28);for(let i=0;i<7;i++){const day='2026-10-'+(19+i),result=breakdown(0,{from:day,to:day});assert.equal(result.total,i+1);assert.equal(result.byProduct.get('p'),i+1)}assert.equal(breakdown(7).total,28);
});
test('Kaspi legacy weekly total is not invented for a day and is explicitly identified',()=>{
 const breakdown=load([{id:'legacy',campaignName:'campaign',fromDate:'2026-10-19',toDate:'2026-10-25',amount:700,perProduct:[{productId:'p',amount:700}],importedAt:1}]);assert.equal(breakdown(7).total,700);const day=breakdown(0,{from:'2026-10-21',to:'2026-10-21'});assert.equal(day.total,0);assert.equal(day.skippedLegacy,1);assert.equal(day.skippedLegacyAmount,700);
 const report=readFileSync(new URL('../../kaspi-report-v2.js',import.meta.url),'utf8');assert.match(report,/adsDateMissing:Number\(ads.skippedLegacy\)/);assert.match(report,/для выбранного дня её точная сумма неизвестна/i);
});
