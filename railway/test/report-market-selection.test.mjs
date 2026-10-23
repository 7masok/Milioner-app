import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const read=name=>readFileSync(new URL('../../'+name,import.meta.url),'utf8');
const report=read('kaspi-report-v2.js'),dashboard=read('business-dashboard-v1.js'),cloud=read('cloud-sync-v3.js'),index=read('index.html');
function fixture({storageFails=false}={}){
 const saved=new Map([['milioner_report_market_v1','WB']]),elements=new Map(),timers=[],requests=[];
 const tabs=['all','Kaspi','WB','WB2','Ozon'].map(m=>({dataset:{reportMarket:m},classList:{toggle(_name,on){this.active=on}}}));
 const el=id=>{if(!elements.has(id))elements.set(id,{dataset:{},textContent:'',innerHTML:'',classList:{contains:()=>true,toggle(){}},setAttribute(){},addEventListener(){},querySelector:()=>null,querySelectorAll:()=>[]});return elements.get(id)};
 for(const id of ['reports','businessDashboard','businessStoreOpening','businessChart','businessPeriodTitle','businessPeriodSub','businessDayNav','businessDayDate','businessDayPrevious','businessDayNext','businessValueMetric','businessValueLabel','businessValue','businessValueMeta','businessYesterdayLabel','businessYesterdayValue','businessYesterdayMeta','businessYesterdayCompare','businessCacheStatus','businessLoadProgress'])el(id);
 const starts={WB:'2022-01-01',Ozon:'2026-01-01',Kaspi:'2025-03-01',WB2:'2024-01-01'};
 const ctx={Date,Intl,console,state:{settings:{reportMarket:'WB',reportStoreStarts:starts}},MILLIONER_API:'https://fixture.invalid',
  document:{readyState:'loading',getElementById:id=>elements.get(id)||null,querySelectorAll:selector=>selector==='[data-report-market]'?tabs:[],addEventListener(){}},
  localStorage:{getItem:k=>{if(storageFails)throw Error('storage disabled');return saved.get(k)},setItem:(k,v)=>{if(storageFails)throw Error('storage disabled');saved.set(k,v)}},
  setTimeout:(fn,ms)=>{timers.push({fn,ms});return timers.length},clearTimeout(){},closeModal(){},
  fetch:url=>{requests.push(String(url));return new Promise(()=>{})},
  normalizeWarehouseSnapshot:value=>value,reportPeriodUiPreference:{},rememberReportPeriodUiPreference(){},
  SERVER_MANAGED_CACHE_KEYS:[],FINANCE_STORAGE_KEYS:[],reportPeriodPreset:30,reportPeriod:30};
 ctx.window=ctx;vm.createContext(ctx);
 vm.runInContext(index.split('\n').find(line=>line.startsWith('const WAREHOUSE_VOLATILE_SETTINGS=')),ctx);
 vm.runInContext(report.slice(report.indexOf('const REPORT_MARKET_UI_KEY='),report.indexOf('const money=')),ctx);
 vm.runInContext(report.split('\n').find(line=>line.startsWith('function setReportChrome(')),ctx);
 vm.runInContext(report.split('\n').find(line=>line.startsWith('window.setReportMarket=')),ctx);
 // The installed report wrappers delegate through the same global function,
 // as classic scripts do in the browser. Only legacy financial I/O is stubbed.
 ctx.renderReports=()=>ctx.setReportChrome();
 vm.runInContext(dashboard.replace(/\}\)\(\);\s*$/,'window.api={businessSyncMarket,businessPaint,businessPaintCompleted,businessModelKey,businessProgressInfo};})();'),ctx);
 vm.runInContext(cloud.slice(cloud.indexOf('function serverSnapshot('),cloud.indexOf('function snapshotText(')),ctx);
 vm.runInContext(cloud.slice(cloud.indexOf('applyWarehouseSnapshot=function('),cloud.indexOf('// Safe instant start:')),ctx);
 return{ctx,el,tabs,timers,requests,saved,starts,active:()=>tabs.find(t=>t.classList.active)?.dataset.reportMarket};
}
test('Ozon selection survives repeated stale WB warehouse snapshots and repaint of the whole report',()=>{
 const f=fixture();f.ctx.setReportMarket('Ozon');
 for(let i=0;i<3;i++){
  f.ctx.applyWarehouseSnapshot({settings:{reportMarket:'WB',reportStoreStarts:f.starts}});
  f.ctx.renderReports();
  assert.equal(f.ctx.state.settings.reportMarket,'Ozon');assert.equal(f.ctx.getReportMarket(),'Ozon');assert.equal(f.active(),'Ozon');
  assert.match(f.el('businessPeriodSub').textContent,/^Ozon ·/);assert.match(f.el('businessStoreOpening').innerHTML,/Начало работы Ozon/);assert.match(f.el('businessStoreOpening').innerHTML,/2026-01-01/);assert.doesNotMatch(f.el('businessStoreOpening').innerHTML,/2022-01-01/);
 }
 assert.equal(f.saved.get('milioner_report_market_v1'),'Ozon');
 assert.equal(f.ctx.serverSnapshot(f.ctx.state).settings.reportMarket,undefined);
 assert.ok(f.requests.some(url=>url.includes('market=Ozon')));
});
test('all store switches clear the old chart and update the opening before any timer or response',()=>{
 const f=fixture();for(const market of ['WB','Ozon','Kaspi','WB2','all','Ozon']){
  f.el('businessChart').innerHTML='old WB bars';f.el('businessValue').textContent='10 700 713 ₸';f.ctx.setReportMarket(market);
  assert.equal(f.active(),market);assert.equal(f.ctx.state.settings.reportMarket,market);
  assert.equal(f.el('businessChart').innerHTML,'');assert.notEqual(f.el('businessValue').textContent,'10 700 713 ₸');
  assert.equal(f.el('businessStoreOpening').hidden,market==='all');
  const label=market==='WB'?'WB 1':market==='WB2'?'WB 2':market==='all'?'Kaspi + WB1 + WB2 + Ozon':market;
  assert.ok(f.el('businessPeriodSub').textContent.startsWith(label+' ·'));
 }
 // No queued timer or external request has been resolved in this test.
});
test('the live tab remains authoritative even if a legacy writer replaces settings or storage is blocked',()=>{
 const f=fixture({storageFails:true});f.ctx.setReportMarket('Ozon');f.ctx.state.settings={reportMarket:'WB',reportStoreStarts:f.starts};f.ctx.renderReports();
 assert.equal(f.active(),'Ozon');assert.equal(f.ctx.state.settings.reportMarket,'Ozon');assert.match(f.el('businessPeriodSub').textContent,/^Ozon ·/);
 const chart=f.el('businessChart').innerHTML,value=f.el('businessValue').textContent;
 f.ctx.api.businessPaintCompleted(f.ctx.api.businessModelKey(),{market:'WB',bounds:{start:0}});
 assert.equal(f.el('businessChart').innerHTML,chart);assert.equal(f.el('businessValue').textContent,value);
});
