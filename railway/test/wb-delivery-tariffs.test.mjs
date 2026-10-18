import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {wbTariffNumber,normalizeWbDeliveryTariffs,wbTariffRetryAt,syncWbDeliveryTariffs,loadWbDeliveryTariffs} from '../src/wb-delivery-tariffs.js';
import {wbCardGroupCard} from '../src/wb-card-groups.js';
const now=Date.parse('2026-10-18T13:00:00Z'),HOUR=3600000;
const raw={warehouseName:'Алматы',geoName:'Казахстан',boxDeliveryBase:'78,2',boxDeliveryLiter:'23,8',boxDeliveryCoefExpr:'170',boxDeliveryMarketplaceBase:'46',boxDeliveryMarketplaceLiter:'14',boxDeliveryMarketplaceCoefExpr:'100'};
const response={response:{data:{warehouseList:[raw]}}};
const warehouses=normalizeWbDeliveryTariffs(response),id=warehouses[0].id;
const row={market:'WB',remoteId:'10',name:'Товар',price:200,discount:0,currency:'RUB'};
const data={warehouses,fetchedAt:now,cardsFetchedAt:now,date:'2026-10-18',cards:[{nmId:'10',dimensions:{length:20,width:10,height:9,weightBrutto:.2}}],fx:{rate:6,observedAt:now,day:'2026-10-18'}};
const setting={scheme:'fbs',warehouse:id};
const ui=readFileSync(new URL('../../prices-v1.js',import.meta.url),'utf8');
const snippet=ui.slice(ui.indexOf('// Tariff estimates'),ui.indexOf('const priceProfitCache='));
function browser(extra={}){
 const ctx={window:{},priceUi:{market:'WB',deliveryRank:'share',deliverySettings:{WB:setting}},pEsc:s=>String(s??'').replaceAll('<','&lt;'),pMoney:(n,c)=>n+' '+c,Date:class extends Date{static now(){return now}},...extra};
 runInNewContext(snippet,ctx);return ctx;
}
test('WB tariff parser preserves unknowns and separates FBS/FBW; catalog dimensions survive repeated normalization',()=>{
 assert.equal(wbTariffNumber('1 234,5'),1234.5);for(const value of [null,undefined,'','—','-1','foo'])assert.equal(wbTariffNumber(value),null);
 assert.equal(warehouses[0].fbs.base,46);assert.equal(warehouses[0].fbw.base,78.2);assert.equal(warehouses[0].fbw.coefficient,170);
 assert.throws(()=>normalizeWbDeliveryTariffs({response:{data:{warehouseList:[{}]}}}));
 const card=wbCardGroupCard({nmID:10,dimensions:{length:20,width:10,height:5,weightBrutto:.2}});
 assert.deepEqual(wbCardGroupCard(card).dimensions,card.dimensions);
 assert.equal(wbCardGroupCard({nmID:10}).dimensions,null);
});
test('one delivery uses fractional litres and already-adjusted API rates exactly once',()=>{
 const ctx=browser({row:{...row},data,setting,now});
 const fbs=runInNewContext('priceDeliveryEstimate(row,data,setting,now)',ctx);
 assert.equal(fbs.volume,1.8);assert.equal(fbs.rub,57.2);assert.equal(fbs.kzt,343.20000000000005);assert.equal(fbs.share,28.6);
 const fbw=runInNewContext('priceDeliveryEstimate(row,data,{...setting,scheme:"fbw"},now)',ctx);
 assert.ok(Math.abs(fbw.rub-97.24)<1e-8);assert.equal(fbw.scheme,'FBW');
 ctx.row.confirmedPrice=100;ctx.row.confirmedDiscount=20;
 assert.ok(Math.abs(runInNewContext('priceDeliveryEstimate(row,data,setting,now).share',ctx)-71.5)<1e-8);
});
test('small-parcel boundaries use WB bands, including exactly one litre; changed schedules are unknown',()=>{
 const ctx=browser({row,data,setting,now});
 for(const [height,expected] of [[.999,23],[1,23],[1.005,26],[2,26],[3,29],[4,30],[5,32]]){
  ctx.sample={...data,cards:[{nmId:'10',dimensions:{length:20,width:10,height}}]};
  assert.equal(runInNewContext('priceDeliveryEstimate(row,sample,setting,now).rub',ctx),expected);
 }
 ctx.sample={...data,cards:[{nmId:'10',dimensions:{length:10,width:10,height:5}}],warehouses:[{...warehouses[0],fbs:{base:80,liter:20,coefficient:170}}]};
 assert.equal(runInNewContext('priceDeliveryEstimate(row,sample,setting,now).available',ctx),false);
 ctx.sample={...data,cards:[{nmId:'10',dimensions:{length:10,width:10,height:5}}]};
 assert.equal(runInNewContext('priceDeliveryEstimate(row,sample,setting,now+30*86400000).available',ctx),false);
});
test('missing dimensions/warehouse/tariff, stale data and heavy cargo never become zero delivery',()=>{
 const ctx=browser({row,data,setting,now});
 const samples=[{...data,cards:[]},{...data,fetchedAt:now-27*HOUR},{...data,cardsFetchedAt:now-25*HOUR},{...data,warehouses:[]},
  {...data,warehouses:[{...warehouses[0],fbs:{base:null,liter:14}}]},
  {...data,cards:[{nmId:'10',dimensions:{length:20,width:10,height:5,weightBrutto:25}}]},
  {...data,cards:[{nmId:'10',dimensions:{length:121,width:10,height:5}}]}];
 for(const sample of samples){ctx.sample=sample;const result=runInNewContext('priceDeliveryEstimate(row,sample,setting,now)',ctx);assert.equal(result.available,false);assert.equal(result.rub,undefined);}
 assert.equal(runInNewContext('priceDeliveryEstimate(row,data,{warehouse:""},now).available',ctx),false);
 ctx.sample={...data,fx:null};const result=runInNewContext('priceDeliveryEstimate(row,sample,setting,now)',ctx);assert.equal(result.available,true);assert.equal(result.kzt,null);assert.equal(result.share,28.6);
 ctx.row={...row,currency:'KZT'};assert.equal(runInNewContext('priceDeliveryEstimate(row,sample,setting,now).share',ctx),null);
 ctx.row={...row,priceMax:300};assert.equal(runInNewContext('priceDeliveryEstimate(row,data,setting,now).share',ctx),null);
});
test('one-click ranking puts large delivery shares first, supports absolute price and keeps unknowns last',()=>{
 const rows=[{row:{...row,name:'Дорогой',remoteId:'10',price:1000},index:0},{row:{...row,name:'Дешёвый',remoteId:'11',price:50},index:1},{row:{...row,name:'Нет габаритов',remoteId:'12'},index:2}];
 const sample={...data,cards:[...data.cards,{nmId:'11',dimensions:{length:10,width:10,height:2}}]};
 const ctx=browser({rows,sample});runInNewContext('priceDeliveryCache.set("WB",{data:sample});',ctx);
 assert.deepEqual(Array.from(runInNewContext('[...rows].sort(priceDeliveryCompare).map(x=>x.row.remoteId)',ctx)),['11','10','12']);
 ctx.priceUi.deliveryRank='amount';assert.deepEqual(Array.from(runInNewContext('[...rows].sort(priceDeliveryCompare).map(x=>x.row.remoteId)',ctx)),['10','11','12']);
 const html=runInNewContext('priceDeliveryHtml(rows[1].row)',ctx);assert.match(html,/high/);assert.match(html,/46% цены/);assert.match(html,/2026-10-18/);assert.match(html,/23 ₽/);
 assert.match(runInNewContext('priceDeliveryHtml(rows[2].row)',ctx),/не заполнены габариты/);
});
function database(){
 const state={next_allowed_at:0,payload:{},fetched_at:0,last_error:''},calls=[];const db={release(){},async query(sql,args=[]){calls.push({sql,args});
  if(sql.includes('pg_try_advisory'))return{rows:[{locked:true}]};if(sql.startsWith('SELECT *'))return{rows:[state]};
  if(sql.includes('SET next_allowed_at=$2'))state.next_allowed_at=args[1];
  if(sql.includes('SET payload=')){state.payload=JSON.parse(args[1]);state.fetched_at=args[2];state.next_allowed_at=args[3];state.last_error='';}
  if(sql.includes('SET last_error=')){state.last_error=args[1];state.next_allowed_at=Math.max(state.next_allowed_at,args[2]);}
  return{rows:[]};}};return{state,calls,connect:async()=>db};
}
test('background sync persists one-hour cooldown across identical shop credentials and respects 429 without clearing last good cache',async()=>{
 const client=database();let count=0;
 const fetcher=async(url,options)=>{count++;assert.match(url,/date=2026-10-18$/);assert.equal(options.headers.Authorization,'fixture');return{ok:true,headers:new Headers(),json:async()=>response};};
 await syncWbDeliveryTariffs('WB',{client,token:'fixture',fetcher,now});assert.equal(count,1);assert.equal(client.state.fetched_at,now);
 await syncWbDeliveryTariffs('WB2',{client,token:'fixture',fetcher,now:now+60000});assert.equal(count,1);
 const prior=JSON.stringify(client.state.payload);const later=now+HOUR+6000;
 await syncWbDeliveryTariffs('WB',{client,token:'fixture',now:later,fetcher:async()=>({ok:false,status:429,headers:new Headers({'retry-after':'7200'})})});
 assert.equal(client.state.next_allowed_at,later+2*HOUR);assert.equal(JSON.stringify(client.state.payload),prior);assert.match(client.state.last_error,/429/);
 assert.ok(client.calls.some(c=>c.sql.includes('pg_try_advisory_xact_lock')));
 assert.ok(client.calls.filter(c=>c.args[0]).every(c=>!c.sql.includes('fixture')));
 assert.equal(wbTariffRetryAt(new Headers({'x-ratelimit-retry':'8000'}),now),now+8000000);
});
test('UI endpoint reads only PostgreSQL, keeps accounts scoped and does not load financial reports',async()=>{
 const calls=[];const client={query:async(sql,args)=>{calls.push({sql,args});assert.match(sql,/^SELECT/);
  if(sql.includes('wb_delivery_tariffs'))return{rows:[{payload:{warehouses},fetched_at:now}]};
  if(sql.includes('wb_card_group_snapshots')){assert.equal(args[0],'WB2');return{rows:[{payload:{cards:data.cards},fetched_at:now}]};}
  assert.match(sql,/marketplace_order_lines/);assert.equal(args[0],'WB2');return{rows:[]};}};
 const result=await loadWbDeliveryTariffs('WB2',client,now,'fixture');assert.equal(result.cards[0].nmId,'10');assert.equal(result.warehouses[0].name,'Алматы');assert.equal(result.fx,null);assert.equal(calls.length,3);
 assert.equal(JSON.stringify(result).includes('fixture'),false);assert.equal(calls.some(c=>/wb_finance/.test(c.sql)),false);
});
test('asynchronous tariff completion updates only read-only slots while a price editor is open',async()=>{
 let requests=0,paints=0;const slot={dataset:{deliveryIndex:'0'},innerHTML:''};
 const input={value:'12345'};
 const ctx=browser({priceExpanded:{index:0,market:'WB'},MILLIONER_API:'https://fixture.invalid',
  activeRows:()=>[row],paintPrices:()=>{paints++},
  document:{getElementById:()=>null,querySelectorAll:()=>[slot]},
  fetch:async url=>{requests++;assert.match(url,/\/api\/market-prices\/delivery-tariffs\?market=WB$/);return{ok:true,json:async()=>data};},input});
 await Promise.all([runInNewContext('loadPriceDelivery("WB")',ctx),runInNewContext('loadPriceDelivery("WB")',ctx)]);
 assert.equal(requests,1);assert.equal(paints,0);assert.equal(input.value,'12345');assert.match(slot.innerHTML,/Доставка WB ≈/);
 await runInNewContext('loadPriceDelivery("WB")',ctx);assert.equal(requests,1);
});
