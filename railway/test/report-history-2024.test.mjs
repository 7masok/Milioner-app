import test from 'node:test';
import assert from 'node:assert/strict';
import {REPORT_HISTORY_FROM,WB_REPORT_HISTORY_FROM,reportHistoryGoal} from '../src/report-history-range.js';
import {initialWbOrderHistory,extendWbOrderHistory,stepWbOrderHistory} from '../src/wb-order-history.js';
const NOW=Date.parse('2026-10-20T22:17:00+05:00'),DAY=86400000;
test('a WB archive completed at January 2025 resumes toward January 2024 without losing confirmed coverage',()=>{
 const old={...initialWbOrderHistory(NOW),goal:REPORT_HISTORY_FROM,coveredFrom:REPORT_HISTORY_FROM,complete:true,rows:10908,nextAllowedAt:NOW+DAY};
 const next=extendWbOrderHistory(old,NOW);
 assert.equal(WB_REPORT_HISTORY_FROM,Date.parse('2023-12-31T19:00:00Z'));
 assert.equal(next.goal,WB_REPORT_HISTORY_FROM);assert.equal(next.coveredFrom,old.coveredFrom);
 assert.equal(next.to,old.coveredFrom);assert.equal(next.from,old.coveredFrom-29*DAY);
 assert.equal(next.rows,10908);assert.equal(next.complete,false);assert.equal(next.nextAllowedAt,NOW+60000);
 assert.equal(old.complete,true);assert.equal(old.goal,REPORT_HISTORY_FROM);
 assert.equal(reportHistoryGoal(NOW),REPORT_HISTORY_FROM);
});
test('WB proves all 2024 archive windows including the Almaty boundary before reporting complete',async()=>{
 let state=extendWbOrderHistory({...initialWbOrderHistory(NOW),goal:REPORT_HISTORY_FROM,coveredFrom:REPORT_HISTORY_FROM,complete:true},NOW);
 const months=new Set();let calls=0;
 while(!state.complete&&calls<100){
  state=(await stepWbOrderHistory(state,{market:'WB',now:NOW+calls*60000,fetchArchive:async q=>{
   calls++;months.add(q.year+'-'+q.month);return {orders:[],next:0};
  }})).state;
 }
 assert.equal(state.complete,true);assert.equal(state.coveredFrom,WB_REPORT_HISTORY_FROM);
 for(let m=1;m<=12;m++)assert.ok(months.has('2024-'+m));
 assert.ok(months.has('2023-12'));assert.ok(calls>12);
});
