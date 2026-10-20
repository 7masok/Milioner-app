import test from 'node:test';
import assert from 'node:assert/strict';
import {REPORT_HISTORY_FROM,WB_REPORT_HISTORY_FROM,reportHistoryGoal} from '../src/report-history-range.js';
import {initialWbOrderHistory,extendWbOrderHistory,stepWbOrderHistory} from '../src/wb-order-history.js';
import {initialKaspiHistory,extendKaspiHistory,stepKaspiHistory,KASPI_HISTORY_STATES} from '../src/kaspi-order-history.js';
import {fetchPostingHistory} from '../src/ozon-fbo.js';
const DAY=86400000,NOW=Date.parse('2026-10-20T13:36:00+05:00'),EDGE=Date.parse('2025-10-19T00:00:00+05:00');
const oldWb=()=>({...initialWbOrderHistory(NOW),goal:EDGE,coveredFrom:EDGE,complete:true,nextAllowedAt:NOW+DAY,rows:10210});
const oldKaspi=()=>({...initialKaspiHistory(NOW),goal:EDGE,coveredFrom:EDGE,complete:true,nextAllowedAt:NOW+DAY,rows:15000});
test('WB targets January 2024 and other order archives target January 2025 by the Almaty calendar without narrowing older requested coverage',()=>{
 assert.equal(REPORT_HISTORY_FROM,Date.parse('2024-12-31T19:00:00Z'));
 assert.equal(initialWbOrderHistory(NOW).goal,WB_REPORT_HISTORY_FROM);assert.equal(initialKaspiHistory(NOW).goal,REPORT_HISTORY_FROM);
 assert.ok(reportHistoryGoal(Date.parse('2024-06-01T00:00:00Z'))<REPORT_HISTORY_FROM);
 for(const [make,extend]of [[oldWb,extendWbOrderHistory],[oldKaspi,extendKaspiHistory]]){const old=make();old.goal=WB_REPORT_HISTORY_FROM-DAY;assert.equal(extend(old,NOW).goal,old.goal)}
});
test('completed WB and Kaspi scans resume only the missing older interval, preserve rows and wait at least an ordinary slot',()=>{
 for(const [make,extend,days,slot,inclusive]of [[oldWb,extendWbOrderHistory,29,60000,false],[oldKaspi,extendKaspiHistory,14,3000,true]]){
  const old=make(),before=JSON.stringify(old),next=extend(old,NOW);
  assert.equal(next.goal,make===oldWb?WB_REPORT_HISTORY_FROM:REPORT_HISTORY_FROM);assert.equal(next.coveredFrom,EDGE);assert.equal(next.to,EDGE-(inclusive?1:0));assert.equal(next.to-next.from,days*DAY-(inclusive?1:0));
  assert.equal(next.rows,old.rows);assert.equal(next.anchor,old.anchor);assert.equal(next.complete,false);assert.equal(next.nextAllowedAt,NOW+slot);assert.equal(JSON.stringify(old),before);
 }
});
test('an earlier target never bypasses provider retry cooldowns or resets an active page',()=>{
 for(const [make,extend]of [[oldWb,extendWbOrderHistory],[oldKaspi,extendKaspiHistory]]){
  const old=make();old.lastError='provider HTTP 429';old.nextAllowedAt=NOW+7200000;const next=extend(old,NOW);assert.equal(next.nextAllowedAt,old.nextAllowedAt);assert.equal(next.lastError,old.lastError);
  const active={...old,complete:false,mode:'refresh',cursor:'1784827125619238001',archiveCursor:'1784827125619238001',archiveIndex:2,stateIndex:3,page:7,pending:[{id:'saved'}]};
  const continued=extend(active,NOW);assert.deepEqual(continued,{...active,goal:make===oldWb?WB_REPORT_HISTORY_FROM:REPORT_HISTORY_FROM});
 }
});
test('WB completes an in-flight daily refresh before continuing below the checked old edge',async()=>{
 const old={...oldWb(),mode:'refresh',phase:'archive',from:NOW-2*DAY,to:NOW,archiveMonths:[{year:2026,month:10}],archiveIndex:0,archiveCursor:0};
 const result=await stepWbOrderHistory(extendWbOrderHistory(old,NOW),{market:'WB',now:NOW,fetchArchive:async()=>({orders:[],next:0})});
 assert.equal(result.state.coveredFrom,EDGE);assert.equal(result.state.anchor,NOW);assert.equal(result.state.to,EDGE);assert.equal(result.state.complete,false);assert.equal(result.state.mode,undefined);assert.equal(result.state.nextAllowedAt,NOW+60000);
});
test('Kaspi completes an in-flight daily refresh before continuing below the checked old edge',async()=>{
 const old={...oldKaspi(),complete:false,mode:'refresh',from:NOW-2*DAY,to:NOW,stateIndex:KASPI_HISTORY_STATES.length-1};
 const result=await stepKaspiHistory(extendKaspiHistory(old,NOW),{now:NOW,fetchPage:async()=>({data:[],meta:{pageCount:0}})});
 assert.equal(result.state.coveredFrom,EDGE);assert.equal(result.state.anchor,NOW);assert.equal(result.state.to,EDGE-1);assert.equal(result.state.complete,false);assert.equal(result.state.mode,undefined);assert.equal(result.state.nextAllowedAt,NOW+3000);
});
test('both collectors prove every missing window before declaring the requested order history complete',async()=>{
 let wb=extendWbOrderHistory(oldWb(),NOW),kaspi=extendKaspiHistory(oldKaspi(),NOW),wbCalls=0,kaspiCalls=0;
 while(!wb.complete&&wbCalls<100){wb=(await stepWbOrderHistory(wb,{market:'WB',now:NOW+wbCalls*60000,fetchArchive:async q=>{wbCalls++;assert.ok(q.year===2025||q.year===2024||q.year===2023&&q.month===12);return{orders:[],next:0}}})).state}
 while(!kaspi.complete&&kaspiCalls<300){kaspi=(await stepKaspiHistory(kaspi,{now:NOW+kaspiCalls*3000,fetchPage:async q=>{kaspiCalls++;assert.ok(q.to-q.from<14*DAY);assert.ok(q.to<EDGE);return{data:[],meta:{pageCount:0}}}})).state}
 assert.equal(wb.coveredFrom,WB_REPORT_HISTORY_FROM);assert.equal(kaspi.coveredFrom,REPORT_HISTORY_FROM);assert.equal(wb.complete,true);assert.equal(kaspi.complete,true);assert.ok(wbCalls>1);assert.ok(kaspiCalls>=KASPI_HISTORY_STATES.length);
});
test('Ozon extends the already complete rolling year by one missing 30-day portion toward January 2025',async()=>{
 const from=new Date(NOW-30*DAY).toISOString(),to=new Date(NOW).toISOString(),edge=new Date(EDGE).toISOString(),calls=[],saved={posting_number:'saved',created_at:new Date(EDGE+DAY).toISOString()};
 const result=await fetchPostingHistory({},from,to,{from:edge,rows:[saved]},async(_,a,b)=>{calls.push([a,b]);return []});
 assert.equal(calls.length,2);assert.deepEqual(calls[1],[new Date(EDGE-30*DAY).toISOString(),edge]);assert.equal(result.targetFrom,new Date(REPORT_HISTORY_FROM).toISOString());assert.equal(result.rows[0],saved);
 const earlier=await fetchPostingHistory({},from,to,{from:edge,targetFrom:new Date(REPORT_HISTORY_FROM-DAY).toISOString(),rows:[saved]},async()=>[]);assert.equal(earlier.targetFrom,new Date(REPORT_HISTORY_FROM-DAY).toISOString());
});
