import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../../wb3-orders-v1.js',import.meta.url),'utf8');
const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
function setup(){
 const elements=new Map(['kaspiOrderList','koQty','koTotal','koAmount','koMatched','orderCountBadge','koUnmatched','syncNowButton'].map(id=>[id,{textContent:'',innerHTML:'',disabled:false}]));
 const requests=[];
 const rows=[{orderId:'1',entryId:'1',creationDate:Date.now(),fulfillment:'FBS',market:'WB',status:'new',state:'waiting',sku:'A',productName:'Браслет',qty:1,totalPrice:1000,currency:'KZT',priceKnown:true},
 {orderId:'srid:2',entryId:'2',creationDate:Date.now(),fulfillment:'FBO',market:'WB',orderStatus:'buyout',sku:'B',productName:'Крест',qty:1,totalPrice:2000,currency:'KZT',priceKnown:true}];
 const ctx={window:{WB3_ONLY:true},document:{getElementById:id=>elements.get(id),querySelectorAll:()=>[],createElement:()=>({}),head:{append(){}}},
 localStorage:{getItem:()=>null,setItem(){}},state:{settings:{},wbOrderFeed:rows,products:[]},selectedOrderMarket:'WB',selectedWbAccount:'WB',
 orderPeriodMode:'today',orderPage:1,ORDER_PAGE_SIZE:15,homeOrdersSettled:true,unmatchedOrderFilter:false,orderSearchText:'',MILLIONER_API:'https://inferno.test',
 orderPeriodBounds:()=>({start:0,end:Infinity}),orderFeedAfterTimestamp(){},setOrderPeriod(mode){ctx.orderPeriodMode=mode;},renderOrderPeriodControls(){},startAppRuntime(){},
 renderMarketplaceOrders(){},loadSharedOrderCache(){},syncNow(){},saveLocalOnly(){},writeHomeCache(){},renderIntegrationStatus(){},cloudStatus(){},
 render(){ctx.renderMarketplaceOrders();},renderOrderPager(){},filterMarketplaceOrdersByPeriod:x=>x,filterMarketplaceOrdersBySearch:x=>x,normalizeServerFeed:x=>x,
 marketplaceLifecycleStage:()=> 'new',isPendingMarketplaceLine:()=>false,prod:()=>null,esc:x=>String(x??'').replaceAll('<','&lt;'),fmt:x=>String(x)+' ₸',
 apiJson:async url=>{requests.push({url});if(url.includes('market-status'))return {markets:[]};return url.includes('cursor=')?{orders:[rows[1]],nextCursor:null,sync:[]}:{orders:[rows[0]],nextCursor:'second',sync:[]};},
 fetch:async(url,options)=>{requests.push({url,options});return {ok:true,json:async()=>({ok:true})};},Date,Intl,console};
 vm.createContext(ctx);
 vm.runInContext(html.split('\n').find(line=>line.startsWith('function marketplaceOrderKey(')),ctx);
 vm.runInContext(html.split('\n').find(line=>line.startsWith('function groupMarketplaceOrders(')),ctx);
 vm.runInContext(source,ctx);
 return {ctx,elements,requests};
}
test('Inferno shows both models and keeps FBO visible when there are no FBS orders',()=>{
 const {ctx,elements}=setup();ctx.renderMarketplaceOrders();
 assert.match(elements.get('kaspiOrderList').innerHTML,/FBS/);assert.match(elements.get('kaspiOrderList').innerHTML,/FBO/);assert.equal(elements.get('koQty').textContent,'2 шт.');
 ctx.window.infernoOrderModel('FBO');assert.doesNotMatch(elements.get('kaspiOrderList').innerHTML,/FBS/);assert.match(elements.get('kaspiOrderList').innerHTML,/Крест/);assert.equal(elements.get('koAmount').textContent,'2000 ₸');
});
test('refresh sends POST to WB3, consumes every page and replaces old cache',async()=>{
 const {ctx,requests}=setup();await ctx.syncNow();
 assert.equal(requests.find(r=>r.url.endsWith('/api/wb3/sync')).options.method,'POST');
 assert.ok(requests.some(r=>r.url.includes('cursor=second')));assert.equal(ctx.state.wbOrderFeed.length,2);assert.ok(requests.every(r=>!r.url.includes('kaspi-sync')));
});
test('all-time selection is accepted and startup chooses this warehouse',()=>{
 const {ctx}=setup();ctx.startAppRuntime();assert.equal(ctx.selectedOrderMarket,'WB');assert.equal(ctx.orderPeriodMode,'all');assert.equal(ctx.orderPeriodBounds().start,0);
});
