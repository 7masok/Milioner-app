import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../../kaspi-report-v2.js',import.meta.url),'utf8');
const line=name=>source.split('\n').find(x=>x.startsWith('function '+name+'(')||x.startsWith('async function '+name+'('));
const allReport=()=>line('paintCombined')+'\n'+line('loadAllReports');
test('linked WB product without a cost is not classified as complete',()=>{
 const c={wbLiveProductId:()=>1,wbRealizedFifoCost:()=>0};vm.runInNewContext(line('wbCostFromProducts'),c);
 assert.equal(c.wbCostFromProducts('WB',25,[{qty:3}]).complete,false);
});
test('Kaspi estimated fees always make profit approximate',()=>{
 const c={};vm.runInNewContext(line('reportProfitView'),c);
 assert.equal(c.reportProfitView({profit:100,unknownRevenue:0}).estimated,true);
});
test('all-market profit stays unknown when a WB finance report is missing',async()=>{
 const elements=new Map();const document={getElementById:id=>{if(!elements.has(id))elements.set(id,{textContent:'',innerHTML:''});return elements.get(id);}};
 const model={financeAvailable:false,complete:false,profit:null,revenue:0,cost:0,expenses:0,ads:0,adjustment:0};
 const c={document,showLoading:()=>{},loadKaspiOrders:async()=>({}),buildModel:()=>({revenue:10,cost:1,fees:1,ads:0,qty:1}),loadWbModel:async()=>model,renderSeq:1,reportConfidenceNote:()=>{},reportProfitView:()=>({value:8}),fmt:String,esc:String};
 vm.runInNewContext(allReport(),c);await c.loadAllReports(25,1);
 assert.equal(document.getElementById('rProfit').textContent,'—');
 assert.ok(document.getElementById('mpReport').innerHTML.includes('<b>—</b>'));
 assert.ok(document.getElementById('mpReport').innerHTML.includes('>Ozon<'));
});
test('all-market report includes Ozon profit in the totals',async()=>{
 const elements=new Map();const document={getElementById:id=>{if(!elements.has(id))elements.set(id,{textContent:'',innerHTML:''});return elements.get(id);}};
 const wb={financeAvailable:true,complete:true,profit:10,revenue:40,cost:5,expenses:8,ads:2,adjustment:0};
 const c={document,showLoading:()=>{},loadKaspiOrders:async()=>({}),buildModel:()=>({revenue:10,cost:1,fees:1,ads:0,qty:2}),loadWbModel:async()=>wb,summarizeOzonReport:async()=>({sales:100,cost:20,fees:15,ads:5,profit:60,qty:3,empty:false}),renderSeq:1,reportConfidenceNote:()=>{},reportProfitView:()=>({value:8}),fmt:v=>String(v),esc:String};
 vm.runInNewContext(allReport(),c);await c.loadAllReports(7,1);
 assert.equal(document.getElementById('rRevenue').textContent,'≈ 190');
 assert.equal(document.getElementById('rAds').textContent,'9');
 assert.equal(document.getElementById('rProfit').textContent,'≈ 88');
 assert.ok(document.getElementById('mpReport').innerHTML.includes("openStoreDetail('Ozon'"));
});
