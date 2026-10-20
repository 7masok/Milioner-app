import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const index=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
const cloud=readFileSync(new URL('../../cloud-sync-v3.js',import.meta.url),'utf8');
const begin=index.indexOf('function rememberReportPeriodUiPreference()');
const remember=index.slice(begin,index.indexOf('let marketplaceReportContext',begin));
const restoreBegin=cloud.indexOf('  const persistedReportPeriod=');
const restore=cloud.slice(restoreBegin,cloud.indexOf('  state.purchases.forEach',restoreBegin));
const old={preset:0,from:'2026-10-11',to:'2026-10-11',updatedAt:10};
function fixture(storageFails=false){
 let saved=null;
 const ctx={state:{settings:{reportPeriodUpdatedAt:10}},REPORT_PERIOD_UI_KEY:'period',reportPeriodUiPreference:{...old},reportPeriodPreset:0,reportPeriod:0,reportCustomFrom:old.from,reportCustomTo:old.to,
  localStorage:{setItem(_key,value){if(storageFails)throw Error('storage disabled');saved=JSON.parse(value)}}};
 vm.createContext(ctx);vm.runInContext(remember,ctx);
 return {ctx,get saved(){return saved},select(preset,at,from=old.from,to=from){Object.assign(ctx,{reportPeriodPreset:preset,reportPeriod:preset,reportCustomFrom:from,reportCustomTo:to});ctx.state.settings.reportPeriodUpdatedAt=at;ctx.rememberReportPeriodUiPreference()},apply(preset=0,at=10,from=old.from,to=from){ctx.state={settings:{reportPeriodPreset:preset,reportPeriodUpdatedAt:at,reportCustomFrom:from,reportCustomTo:to}};vm.runInContext('{'+restore+'}',ctx)}};
}
test('choosing Today updates the live preference and survives repeated older warehouse snapshots',()=>{
 const f=fixture();f.select(1,30);assert.equal(f.ctx.reportPeriodUiPreference.preset,1);assert.equal(f.ctx.reportPeriodUiPreference.updatedAt,30);
 for(let i=0;i<3;i++){f.apply();assert.equal(f.ctx.reportPeriodPreset,1);assert.equal(f.ctx.reportPeriod,1);assert.equal(f.ctx.state.settings.reportPeriodPreset,1);assert.equal(f.ctx.state.settings.reportPeriodUpdatedAt,30);assert.equal(f.saved.updatedAt,30)}
});
test('custom range stays the latest choice across sync and is not silently reset to Today',()=>{
 const f=fixture();f.select(0,40,'2026-10-18','2026-10-20');f.apply();assert.equal(f.ctx.reportPeriodPreset,0);assert.equal(f.ctx.reportCustomFrom,'2026-10-18');assert.equal(f.ctx.reportCustomTo,'2026-10-20');assert.equal(f.ctx.state.settings.reportCustomFrom,'2026-10-18');assert.equal(f.saved.updatedAt,40);
});
test('unavailable localStorage does not prevent the current period from surviving sync',()=>{
 const f=fixture(true);f.select(7,50);f.apply();assert.equal(f.ctx.reportPeriodPreset,7);assert.equal(f.ctx.reportPeriodUiPreference.updatedAt,50);
});
test('a genuinely newer persisted report choice is restored and refreshes the live preference',()=>{
 const f=fixture();f.select(1,30);f.apply(0,60,'2026-10-19','2026-10-20');assert.equal(f.ctx.reportPeriodPreset,0);assert.equal(f.ctx.reportCustomFrom,'2026-10-19');assert.equal(f.ctx.reportCustomTo,'2026-10-20');assert.equal(f.ctx.reportPeriodUiPreference.updatedAt,60);assert.equal(f.saved.from,'2026-10-19');
});
