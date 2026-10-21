import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const index=readFileSync(new URL('../../index.html',import.meta.url),'utf8'),source=readFileSync(new URL('../../kaspi-report-v2.js',import.meta.url),'utf8');
const dateSetter=index.split('\n').find(x=>x.startsWith('function setReportCustomDate('));
test('changing either custom date redraws the currently open shop sheet with the new saved bounds',()=>{
 for(const market of ['Kaspi','WB','WB2','Ozon']){
  let sheets=0,main=0,saved=0;const ctx={Date,state:{settings:{}},reportCustomFrom:'2026-10-10',reportCustomTo:'2026-10-12',marketplaceReportContext:{market,days:0},reportDateTimestamp:value=>Date.parse(value+'T00:00:00+05:00'),rememberReportPeriodUiPreference(){saved++},renderReportCustomRange(){},renderMarketplaceReportSheet(){sheets++;assert.equal(ctx.reportCustomTo,'2026-10-13');assert.equal(ctx.marketplaceReportContext.days,0)},renderReports(){main++}};vm.createContext(ctx);vm.runInContext(dateSetter,ctx);ctx.setReportCustomDate('to','2026-10-13',true);assert.equal(sheets,1);assert.equal(main,0);assert.equal(saved,1);assert.equal(ctx.state.settings.reportCustomTo,'2026-10-13');
  ctx.setReportCustomDate('from','2026-10-11',true);assert.equal(sheets,2);assert.equal(ctx.state.settings.reportCustomFrom,'2026-10-11');
 }
});
test('late Ozon advertising for old dates cannot repaint a changed open range',()=>{
 const callback=source.split('\n').find(x=>x.startsWith('window.onOzonSummary='));let painted=0;const summary={sales:100},ctx={window:{},Date,reportPeriod:0,reportCustomFrom:'2026-10-10',reportCustomTo:'2026-10-13',reportMarket:'Kaspi',ozonSummaryCache:new Map(),periodCacheKey:(_d,r)=>r.from+':'+r.to,marketplaceReportContext:{market:'Ozon',days:0,range:{from:'2026-10-10',to:'2026-10-13'}},document:{getElementById:id=>id==='modal'?{classList:{contains:()=>true}}:{innerHTML:'Реклама Ozon',scrollTop:7}},paintOzonSheet(){painted++},requestAnimationFrame:fn=>fn()};vm.createContext(ctx);vm.runInContext(callback,ctx);ctx.window.onOzonSummary(0,summary,{from:'2026-10-10',to:'2026-10-12'});assert.equal(painted,0);ctx.window.onOzonSummary(0,summary,{from:'2026-10-10',to:'2026-10-13'});assert.equal(painted,1);
});
