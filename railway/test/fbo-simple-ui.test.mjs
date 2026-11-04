import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {useAutomaticSupplies,supplyCadence} from '../src/wb3-supply-sync.js';
const source=readFileSync(new URL('../../wb3-supplies-v1.js',import.meta.url),'utf8');
function fixture(rows=[]){
 const nodes={fboStoreSwitch:{querySelectorAll:()=>[]},fboRoot:{hidden:false},wb3SupplyPanel:{hidden:true,innerHTML:''}},requests=[];let ozon=0;
 const c={state:{movements:rows},console,AbortController,setTimeout,clearTimeout,setInterval(){},localStorage:{getItem:()=>null,setItem(){}},document:{getElementById:id=>nodes[id]},MILLIONER_API:'https://warehouse.test',renderMovement(){return c.state.movements},renderRecent(){return c.state.movements},movementBalanceHtml:()=> 'balance',renderFboDashboard(){ozon++},fetch:async(url)=>{requests.push(url);assert.ok(url.startsWith(c.MILLIONER_API));return {ok:true,json:async()=>({ok:true,supplies:[],excluded:[]})}}};c.window=c;vm.runInNewContext(source,c);return {c,nodes,requests,get ozon(){return ozon}};
}
test('WB3 uses the authenticated absolute API origin and a separate store pane',async()=>{
 const f=fixture();f.c.selectFboStore('WB3');await f.c.renderFboDashboard();assert.equal(f.requests[0],'https://warehouse.test/api/unified/wb3/supplies');assert.equal(f.ozon,0);assert.equal(f.nodes.fboRoot.hidden,true);assert.equal(f.nodes.wb3SupplyPanel.hidden,false);
 f.c.selectFboStore('Ozon');assert.equal(f.ozon,1);assert.equal(f.nodes.fboRoot.hidden,false);assert.equal(f.nodes.wb3SupplyPanel.hidden,true);
});
test('movement view combines only the exact technical pair, leaving the audit rows untouched',()=>{
 const rows=[{id:'fbo-in-123',type:'приход',productId:'p',date:1,qty:5},{id:'fbo-out-123',type:'FBO Ozon',productId:'p',date:1,qty:-7},{id:'real-in',type:'приход',productId:'p',date:2,qty:10}],copy=structuredClone(rows),f=fixture(rows);
 const shown=f.c.renderMovement();assert.equal(shown.length,2);assert.equal(shown[0].qty,-7);assert.equal(shown[0].displayFboWarehouse,5);assert.equal(shown[0].displayFboSale,2);assert.deepEqual(rows,copy);assert.equal(f.c.state.movements,rows);assert.match(f.c.movementBalanceHtml(shown[0]),/Со склада: 5/);
 const mismatch=structuredClone(rows);mismatch[0].date=2;assert.equal(f.c.fboMovementRows(mismatch).length,3);
});
test('automatic mode repairs the previous baseline exclusion for today, retaining earlier history',()=>{
 const now=Date.parse('2026-11-04T18:00:00Z');const s=useAutomaticSupplies({listAt:now,enabled:true,excluded:['preorder:1','preorder:2'],supplies:[{preorderID:1,statusID:6,factDate:'2026-11-04T16:00:00Z'},{preorderID:2,statusID:5,factDate:'2026-08-01T00:00:00Z'}]},now);
 assert.deepEqual(s.excluded,['preorder:2']);assert.equal(s.automaticVersion,2);assert.equal(useAutomaticSupplies(s,now),s);
});
test('supply cadence uses official token type, with a conservative fallback',()=>{
 const token=acc=>'header.'+Buffer.from(JSON.stringify({acc,t:false})).toString('base64url')+'.signature';
 assert.equal(supplyCadence(token(3)),2500);assert.equal(supplyCadence(token(4)),2500);assert.equal(supplyCadence(token(1)),1800000);assert.equal(supplyCadence('invalid'),1800000);
});
