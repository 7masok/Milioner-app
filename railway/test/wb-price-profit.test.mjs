import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {buildWbPriceProfit,wbObservedExchangeRate,loadWbPriceProfit} from '../src/wb-price-profit.js';
const now=Date.parse('2026-10-18T13:00:00Z'),DAY=86400000;
const order=(raw={},extra={})=>({order_id:'o1',creation_date:now-3600000,raw_json:{order:{currencyCode:643,convertedCurrencyCode:398,price:10000,convertedPrice:60000,...raw}},...extra});
const finance=(id,op,raw={},extra={})=>({rrd_id:String(id),nm_id:'100',operation:op,rr_date:now-DAY,sale_date:now-DAY,qty:1,raw_json:{sellerOperName:op,currency:'KZT',srid:'s1',shkId:'u1',quantity:1,...raw},...extra});
const sale=(id=1,raw={},extra={})=>finance(id,'Продажа',{retailPriceWithDisc:1000,forPay:700,...raw},extra);
const delivery=(id=2,raw={},extra={})=>finance(id,'Логистика',{deliveryService:120,deliveryAmount:1,...raw},extra);
const base={now,priceRows:[{remoteId:'100',productId:'p',currency:'RUB'}],orderRows:[order()],products:[{id:'p',cost:200}],purchases:[]};
const build=rows=>buildWbPriceProfit({...base,financeRows:rows});
test('retention includes acquiring once; ordinary delivery and current landed cost remain separate',()=>{
 const rows=[sale(1,{acquiringFee:20,ppvzSalesCommission:280}),delivery()];const before=JSON.stringify(rows),m=build(rows).models[0];
 assert.equal(m.available,true);assert.equal(m.feesRate,.3);assert.equal(m.logisticsPerUnit,120);assert.equal(m.unitCostKzt,200);assert.equal(m.fx.rate,6);assert.equal(m.sampleUnits,1);assert.equal(m.days,30);
 assert.equal(150*(1-.05)*m.fx.rate*(1-m.feesRate)-m.logisticsPerUnit-m.unitCostKzt,278.5);assert.equal(JSON.stringify(rows),before);
});
test('cancelled/returned/rebilled/repeated delivery attempts never inflate normal average',()=>{
 for(const more of [delivery(3),finance(3,'Возврат'),delivery(3,{returnAmount:1,deliveryService:80}),finance(3,'Логистика',{deliveryService:80,deliveryAmount:1,bonusTypeName:'Повторная доставка'}),finance(3,'Логистика',{rebillLogisticCost:90})])assert.equal(build([sale(),delivery(),more]).models[0].available,false);
 const rows=[sale(),delivery(),finance(3,'Логистика',{srid:'cancelled-old',deliveryService:400,deliveryAmount:1})];assert.equal(build(rows).models[0].available,false,'same physical unit has a prior attempt');
 assert.equal(build([sale(),delivery(2,{deliveryAmount:2})]).models[0].available,false);
 assert.equal(build([sale(),delivery(2,{deliveryAmount:undefined})]).models[0].available,false);
});
test('fee average is revenue weighted, delivery unit weighted; currencies and stores are separate',()=>{
 const rows=[sale(),delivery(),sale(3,{srid:'s2',shkId:'u2',quantity:2,retailPriceWithDisc:500,forPay:800}),delivery(4,{srid:'s2',shkId:'u2',deliveryAmount:2,deliveryService:180}),sale(5,{currency:'RUB',srid:'r',shkId:'r',retailPriceWithDisc:100,forPay:50}),delivery(6,{currency:'RUB',srid:'r',shkId:'r',deliveryService:30})];
 const m=build(rows).models[0];assert.equal(m.expenseCurrency,'KZT');assert.equal(m.feesRate,.25);assert.equal(m.logisticsPerUnit,100);assert.equal(m.sampleUnits,3);
 const rub=build([sale(1,{currency:'RUB',retailPriceWithDisc:100,forPay:70}),delivery(2,{currency:'RUB',deliveryService:20})]).models[0];assert.equal(rub.expenseCurrency,'RUB');assert.equal(rub.logisticsPerUnit,20);
});
test('30-day samples preferred; 90-day fallback explicitly identified; old/unknown/partial data stays unknown',()=>{
 const old=[sale(1,{}, {sale_date:now-40*DAY,rr_date:now-40*DAY}),delivery()];assert.equal(build(old).models[0].days,90);
 assert.equal(build([sale(1,{}, {sale_date:now-91*DAY}),delivery()]).models[0].available,false);
 for(const [s,d] of [[sale(1,{currency:'UNKNOWN'}),delivery(2,{currency:'UNKNOWN'})],[sale(1,{forPay:undefined}),delivery()],[sale(1,{retailPriceWithDisc:undefined}),delivery()]])assert.equal(build([s,d]).models[0].available,false);
 assert.equal(buildWbPriceProfit({...base,financeRows:[sale(),delivery()],truncated:true}).models[0].available,false);
 assert.match(buildWbPriceProfit({...base,financeRows:[sale(),delivery()],orderRows:[]}).models[0].reason,/курса|пары/);
 assert.match(buildWbPriceProfit({...base,financeRows:[sale(),delivery()],products:[{id:'p',cost:0}]}).models[0].reason,/себестоимость/);
});
test('WB exchange uses matching RUB/KZT pairs from newest local day and rejects stale/contradictory inputs',()=>{
 assert.equal(wbObservedExchangeRate([order()],now).rate,6);
 assert.equal(wbObservedExchangeRate([order({currencyCode:398,convertedCurrencyCode:643,price:60000,convertedPrice:10000})],now).rate,6);
 for(const row of [order({currencyCode:840}),order({convertedCurrencyCode:643}),order({convertedPrice:0}),order({finalPrice:5000,convertedFinalPrice:5000}),order({}, {creation_date:now-8*DAY})])assert.equal(wbObservedExchangeRate([row],now),null);
 const fx=wbObservedExchangeRate([order(),order({convertedPrice:50000},{order_id:'old',creation_date:now-DAY})],now);assert.equal(fx.rate,6);assert.equal(fx.samples,1);
});
test('cost reads remaining lots, warehouse landed delivery and bundle components without mutating FIFO',()=>{
 const purchases=[{productId:'p',status:'received',qty:10,remainingQty:2,landedUnitCost:100},{productId:'p',status:'received',qty:1,remainingQty:1,landedUnitCost:400}];
 const before=JSON.stringify(purchases);assert.equal(buildWbPriceProfit({...base,financeRows:[sale(),delivery()],purchases}).models[0].unitCostKzt,200);assert.equal(JSON.stringify(purchases),before);
 assert.equal(buildWbPriceProfit({...base,financeRows:[sale(),delivery()],purchases:[{productId:'p',status:'at_warehouse',qty:10,buyTotal:1000,delivery:200}]}).models[0].unitCostKzt,120);
 const models=buildWbPriceProfit({...base,financeRows:[sale(),delivery()],products:[{id:'p',kind:'bundle',components:[{productId:'c',qty:2}]},{id:'c',cost:90}]}).models;assert.equal(models[0].unitCostKzt,180);
});
test('server model is cached/deduplicated and reads only PostgreSQL, separately per market',async()=>{
 let reads=0;const client={query:async(sql,args)=>{reads++;assert.match(sql,/^SELECT/);if(sql.includes('wb_price_snapshots'))return{rows:[{payload:{rows:base.priceRows}}]};if(sql.includes('wb_finance_rows')){assert.equal(args[0],'WB2');return{rows:[sale(),delivery()]}};if(sql.includes('marketplace_order_lines'))return{rows:[order()]};if(sql.includes('warehouse_products'))return{rows:base.products.map(payload=>({payload}))};return{rows:[]}}};
 const [a,b]=await Promise.all([loadWbPriceProfit('WB2',client,now),loadWbPriceProfit('WB2',client,now)]);assert.equal(reads,5);assert.equal(a,b);assert.equal(a.models[0].available,true);await loadWbPriceProfit('WB2',client,now+1);assert.equal(reads,5);
});
test('UI recalculates ruble price to positive/zero/negative tenge without clamping loss, and shows unknowns',()=>{
 const ui=readFileSync(new URL('../../prices-v1.js',import.meta.url),'utf8'),at=ui.indexOf('const priceProfitCache='),end=ui.indexOf('async function loadPriceProfit',at);
 const ctx={Map,Number,pEsc:String};runInNewContext(ui.slice(at,end)+';function putModel(m){priceProfitCache.set("WB",{data:{models:[m]}})}',ctx);
 const model=build([sale(),delivery()]).models[0];ctx.putModel(model);const row={remoteId:'100',market:'WB',currency:'RUB'};
 assert.match(ctx.priceProfitHtml(row,150),/Прибыль ≈ \+310 ₸/);assert.match(ctx.priceProfitHtml(row,50),/Прибыль ≈ -110 ₸/);assert.match(ctx.priceProfitHtml(row,320/4.2),/Прибыль ≈ 0 ₸/);
 ctx.putModel({...model,available:false,reason:'Нет себестоимости'});assert.match(ctx.priceProfitHtml(row,150),/Прибыль: —/);assert.match(ctx.priceProfitHtml(row,150),/Нет себестоимости/);
 assert.ok(ui.includes("loadPriceProfit(priceWorkbench.market)"));assert.ok(ui.includes('priceProfitHtml(item.row,item.final)'));
});
