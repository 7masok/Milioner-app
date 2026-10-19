import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../../ozon-fbo-v1.js',import.meta.url),'utf8');
function fixture(fetch){
 const status={textContent:''},dot={},timers=new Map();let timerId=0;
 const window={},noop=()=>{},ctx={window,fetch,AbortSignal,Date,Map,Set,Intl,console,state:{settings:{},products:[]},MILLIONER_API:'https://fixture.invalid',renderMarketplaceOrders:noop,applyMarketplaceTransitions:noop,productCard:noop,renderProducts:noop,attachMarketplaceSku:noop,setInterval:noop,setTimeout:(fn,delay)=>{timers.set(++timerId,{fn,delay});return timerId},clearTimeout:id=>timers.delete(id),document:{getElementById:id=>id==='dotOzonTop'?dot:id==='ozonTopStatus'?status:null,querySelector:()=>({})}};
 vm.createContext(ctx);vm.runInContext(source.replace(/\}\)\(\);\s*$/,'window.probe={load,historyRequests};})();'),ctx);
 return{window,status,dot,timers,state:ctx.state};
}
const payload=from=>({ok:true,configured:true,syncing:false,accounts:[{account:'fixture',postings:{from,to:'2026-10-20T00:00:00Z',rows:[]},stocks:{rows:[]}}]});
const response=value=>({ok:true,json:async()=>value});
test('parallel Ozon refreshes join one bounded request; refreshing a known snapshot is not a new connection',async()=>{
 let resolve,calls=0;
 const f=fixture(async(_url,options)=>{calls++;assert.ok(options.signal);return new Promise(done=>{resolve=done})});
 const a=f.window.ozonFboRefreshStatus(),b=f.window.ozonFboRefreshStatus();
 assert.equal(calls,1);assert.match(f.status.textContent,/подключение/);
 resolve(response(payload('2026-05-18T00:00:00Z')));await Promise.all([a,b]);assert.equal(f.status.textContent,'работает');
 const refresh=f.window.probe.load(true);assert.equal(f.status.textContent,'обновление…');
 resolve(response(payload('2026-04-01T00:00:00Z')));await refresh;assert.equal(f.status.textContent,'работает');
});
test('failed first Ozon refresh exits connection state and displays an error',async()=>{
 const f=fixture(async()=>{throw Error('timeout')});await f.window.ozonFboRefreshStatus();assert.equal(f.status.textContent,'ошибка');
});
test('a selected older range is requested once, then cached snapshots are polled until coverage arrives',async()=>{
 let from='2026-05-18T00:00:00Z',posts=0;
 const f=fixture(async(url,options)=>{
  if(url.endsWith('/ozon-order-history')){posts++;assert.equal(JSON.parse(options.body).from,Date.parse('2026-04-01T00:00:00Z'));return response({ok:true,pending:true})}
  return response(payload(from));
 });
 await f.window.ozonFboRefreshStatus();const bounds={start:Date.parse('2026-04-01T00:00:00Z'),end:Date.parse('2026-06-01T00:00:00Z')};
 assert.equal(await f.window.ozonFboRequestOrderHistory(bounds),true);await f.window.ozonFboRequestOrderHistory(bounds);assert.equal(posts,1);
 assert.equal(f.window.probe.historyRequests.size,1);
 from='2026-03-01T00:00:00Z';await f.window.probe.load(true);
 assert.equal(f.window.ozonFboOrderHistoryCovers(bounds),true);assert.equal(f.window.probe.historyRequests.size,0);
});
test('an expanded archive merges order lines in place and removes absent derived rows',async()=>{
 const rows=Array.from({length:4000},(_,i)=>({posting_number:'posting-'+i,created_at:'2026-04-01T00:00:00Z',status:'delivered',products:[{sku:'sku-'+i,quantity:1,price:10}]}));
 const value=payload('2026-03-01T00:00:00Z');value.accounts[0].postings.rows=rows;
 const f=fixture(async()=>response(value)),feed=[],existing={entryId:'posting-0_sku-0_0',custom:'keep',status:'awaiting_deliver'};
 feed.push(existing,{entryId:'absent'});f.state.ozonOrderFeed=feed;
 await f.window.ozonFboRefreshStatus();
 assert.equal(f.state.ozonOrderFeed,feed);assert.equal(feed.length,4000);assert.equal(feed[0],existing);
 assert.equal(existing.status,'delivered');assert.equal(existing.custom,'keep');assert.equal(feed.at(-1).entryId,'posting-3999_sku-3999_0');
});
