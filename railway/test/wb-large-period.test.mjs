import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../../kaspi-report-v2.js',import.meta.url),'utf8');
const code=source.slice(source.indexOf('async function loadWbPeriod('),source.indexOf('async function loadWbModel('));
test('large WB periods split into disjoint ranges and preserve totals',async()=>{
 const spans=[];
 const context=vm.createContext({
  Date,Number,Math,Promise,MILLIONER_API:'',
  reportQuery:(market,days,range)=>'?from='+range.from+'&to='+range.to,
  apiJson:async url=>{
   const q=new URL(url,'https://example.com').searchParams;
   const start=Date.parse(q.get('from')),end=Date.parse(q.get('to'))+86400000;
   if(end-start>2*86400000)throw Error('Больше 50 000 операций.');
   if(url.includes('products')){spans.push([start,end]);return {products:[]}}
   return {revenue:(end-start)/86400000*100};
  },
  wbExpenseModel:summary=>({revenue:summary.revenue,profit:summary.revenue/2,cost:summary.revenue/2,financeAvailable:true,complete:true})
 });
 vm.runInContext(code,context);
 const start=Date.parse('2026-01-01T00:00:00+05:00');
 const result=await context.loadWbPeriod('WB',start,start+8*86400000);
 assert.equal(result.revenue,800);assert.equal(result.profit,400);assert.equal(result.cost,400);
 spans.sort((a,b)=>a[0]-b[0]);
 assert.equal(spans.length,4);
 for(let i=1;i<spans.length;i++)assert.equal(spans[i-1][1],spans[i][0]);
});
test('unrelated WB errors are propagated without splitting',async()=>{
 let calls=0;
 const context=vm.createContext({Date,Number,Math,Promise,MILLIONER_API:'',reportQuery:()=>'',apiJson:async()=>{calls++;throw Error('Нет связи')}});
 vm.runInContext(code,context);
 await assert.rejects(context.loadWbPeriod('WB',1,864000001),/Нет связи/);
 assert.equal(calls,2);
});
