import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const compat=readFileSync(new URL('../../kaspi-status-compat-v1.js',import.meta.url),'utf8'),report=readFileSync(new URL('../../kaspi-report-v2.js',import.meta.url),'utf8');
const range={from:'2026-10-11',to:'2026-10-11'};
function fixture(){
 const product={id:'p',name:'Тестовый товар',ozon:'100',cost:600},finance=(name,amount,items=[],extra={})=>({operation_date:'2026-10-11T12:00:00+05:00',operation_type_name:name,amount,items,currency:'KZT',...extra});
 const payload={accounts:[{account:'a',finance:{rows:[finance('Продажа',10000,[{sku:'100'}],{accruals_for_sale:10000}),finance('Реклама',-2000)]}}]},ctx={window:{},state:{products:[product],purchases:[],ozonOrderFeed:[]},prod:()=>product,Date,Map,Set,Intl,console,MILLIONER_API:'https://fixture.invalid',apiJson:async()=>payload,setTimeout(){}};
 vm.createContext(ctx);vm.runInContext('let ozonProfitData=null,ozonProfitLoadedAt=0;'+compat.slice(compat.indexOf('  const ozonNum='),compat.indexOf('  window.loadOzonProductOrderSeries='))+'\n'+compat.slice(compat.indexOf('  window.summarizeOzonReport='),compat.indexOf('  function ozonYieldUi'))+'\nwindow.summaryFrom=ozonSummaryFrom;',ctx);
 return{ctx,payload};
}
test('financial summary resolves while the advertising response is deliberately stalled',async()=>{
 const f=fixture();let adCalls=0,finishAds;f.ctx.apiJson=async url=>url.includes('ozon-ads')?(adCalls++,new Promise(resolve=>finishAds=resolve)):f.payload;
 const result=await f.ctx.window.summarizeOzonReport(0,range);assert.equal(adCalls,1);assert.equal(result.sales,10000);assert.equal(result.ads,2000);assert.equal(result.adsPending,true);assert.equal(result.products[0].adsKnown,false);assert.equal(result.products[0].ads,0);
 finishAds({configured:true,from:range.from,to:range.to,rows:[{sku:'100',spent:300}],totalSpent:300});await new Promise(resolve=>setImmediate(resolve));const ready=await f.ctx.window.summarizeOzonReport(0,range);assert.equal(ready.products[0].ads,300);assert.equal(ready.products[0].adsKnown,true);assert.equal(ready.ads,2000);assert.equal(ready.unallocatedAds,1700);assert.equal(adCalls,1);
});
test('last confirmed SKU amounts remain visible when a refresh returns a quota error',()=>{
 const f=fixture(),summary=f.ctx.window.summaryFrom(f.payload,0,{configured:true,stale:true,error:'Ozon 429',rows:[{sku:'100',spent:1234}],totalSpent:1234,updatedAt:1000},range);assert.equal(summary.products[0].adsKnown,true);assert.equal(summary.products[0].ads,1234);assert.equal(summary.ads,2000);assert.equal(summary.adsStale,true);assert.equal(summary.adsError,'Ozon 429');
});
test('unknown SKU advertising is labeled separately from known finance advertising and product profit',()=>{
 let view;const ctx={paintStoreSheet:(_market,_days,v)=>view=v,fmt:String,esc:String,Date};const start=report.indexOf('function paintOzonSheet('),end=report.indexOf('\nfunction ',start+10);vm.runInNewContext(report.slice(start,end),ctx);
 ctx.paintOzonSheet({sales:100,ads:20,cost:10,profit:70,adsError:'limited',products:[{name:'unknown',sales:100,cost:10,profit:90,ads:0,adsKnown:false},{name:'known',ads:7,adsKnown:true}]},0);assert.equal(view.products[0].ads,'нет разбивки');assert.equal(view.products[0].profitLabel,'До рекламы');assert.equal(view.products[1].ads,'7');assert.equal(view.lines.find(r=>r.label==='Реклама Ozon').text,'20');
});
test('simultaneous report requests reuse the shared FBO snapshot without downloading it again',async()=>{
 const f=fixture();let calls=0;f.ctx.window.ozonFboSnapshot=()=>({payload:f.payload,loadedAt:Date.now()});f.ctx.apiJson=async url=>{if(url.includes('ozon-fbo'))calls++;return{configured:false,rows:[]}};const [a,b]=await Promise.all([f.ctx.window.summarizeOzonReport(0,range),f.ctx.window.summarizeOzonReport(0,range)]);assert.equal(a.sales,b.sales);assert.equal(calls,0);
});
