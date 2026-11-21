// The server uses the shipped calculation functions, without running UI startup,
// timers, renderers or browser initialization. Marketplace I/O is GET-only and
// supplied by the worker from a PostgreSQL read snapshot.
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {parse} from 'acorn';
const root=new URL('../../',import.meta.url);
let definitions;
function calculationDefinitions(){
 if(definitions)return definitions;
 const out=new Map();
 function collect(body,source){for(const n of body){
  if(n.type==='FunctionDeclaration'&&n.id)out.set(n.id.name,{code:source.slice(n.start,n.end),function:true});
  else if(n.type==='VariableDeclaration'){for(const d of n.declarations)if(d.id.type==='Identifier'&&d.init)out.set(d.id.name,{code:source.slice(d.init.start,d.init.end)});}
  else if(n.type==='ExpressionStatement'&&n.expression.type==='AssignmentExpression'){
   const a=n.expression;if(a.left.type==='MemberExpression'&&a.left.object.name==='window'&&['loadBusinessMarketplaceDaily','loadOzonBusinessDaily','kaspiAdsBreakdown'].includes(a.left.property.name))out.set(a.left.property.name,{code:source.slice(a.right.start,a.right.end)});
  }
  if(n.type==='TryStatement')collect(n.block.body,source);
  if(n.type==='ExpressionStatement'&&n.expression.type==='CallExpression'&&['FunctionExpression','ArrowFunctionExpression'].includes(n.expression.callee.type)&&n.expression.callee.body.type==='BlockStatement')collect(n.expression.callee.body.body,source);
 }}
 for(const name of ['index.html','kaspi-status-compat-v1.js','kaspi-report-v2.js','kaspi-ads-v2-original.js','business-dashboard-v1.js']){
  const raw=readFileSync(new URL(name,root),'utf8'),source=name==='index.html'?raw.match(/<script>\s*([\s\S]*?)<\/script>/)[1]:raw;
  collect(parse(source,{ecmaVersion:'latest',sourceType:'script'}).body,source);
 }
 return definitions=out;
}
export function createBusinessReportRuntime({state,market,readApi,now=Date.now(),forecastMarkets=[market]}){
 const storage=new Map(),offset=18000000,Clock=class extends Date{
  constructor(...args){super(args.length>1?Date.UTC(...args)-offset:args.length?args[0]:now)}static now(){return now}
  getTimezoneOffset(){return -300}
 };
 for(const part of ['FullYear','Month','Date','Day','Hours','Minutes','Seconds','Milliseconds'])Clock.prototype['get'+part]=function(){return new Date(this.getTime()+offset)['getUTC'+part]()};
 for(const part of ['FullYear','Month','Date','Hours','Minutes','Seconds','Milliseconds'])Clock.prototype['set'+part]=function(...args){const d=new Date(this.getTime()+offset),value=d['setUTC'+part](...args)-offset;this.setTime(value);return value};
 const ctx={state,Date:Clock,Intl,Map,Set,WeakMap,JSON,URL,AbortController,console,
  MILLIONER_API:'https://report.internal',localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,String(v))},
  sessionStorage:{getItem:()=>null,setItem(){}},document:{readyState:'loading',getElementById:()=>null,querySelector:()=>null,querySelectorAll:()=>[],addEventListener(){}},
  setTimeout:fn=>setImmediate(fn),clearTimeout:clearImmediate,location:{origin:'https://report.internal',hostname:'report.internal',protocol:'https:',pathname:'/'},
  apiJson:async url=>readApi(new URL(url).pathname+new URL(url).search),getReportMarket:()=>market,
  financialSales:()=>state.sales||[],reportPeriod:0,reportCustomFrom:'',reportCustomTo:'',
 };
 ctx.window=ctx;vm.createContext(ctx,{codeGeneration:{strings:false,wasm:false}});
 const defs=new Map(calculationDefinitions());
 const adsNames=new Set(['DAY','OFFSET','LIMIT','countKeys','iso','dayStart','number','sum','format','value','cash','hasActivity','kaspiSkus','warehouseUnitCost','testPriceTerms','testEnd','active','baselineStart','coverageIncludes','campaignRows','campaignMetrics','productTotal','targetCpc','bidHistory','weeklyBid','minBid','tests','bidLimit','testProfit']);
 function loadAdsCalculations(){
  const adsSource=readFileSync(new URL('kaspi-campaign-workbench.js',root),'utf8');
  const body=parse(adsSource,{ecmaVersion:'latest'}).body[0].expression.callee.body.body;
  for(const node of body){
   if(node.type==='FunctionDeclaration'&&adsNames.has(node.id.name))vm.runInContext(adsSource.slice(node.start,node.end),ctx);
   if(node.type==='VariableDeclaration')for(const d of node.declarations)if(adsNames.has(d.id.name))
    Object.defineProperty(ctx,d.id.name,{configurable:true,writable:true,value:vm.runInContext('('+adsSource.slice(d.init.start,d.init.end)+')',ctx)});
  }
 }

 for(const [name,def]of defs){if(Object.hasOwn(ctx,name))continue;
  let initialized=false,value,evaluating=false;
  Object.defineProperty(ctx,name,{configurable:true,enumerable:true,get(){if(!initialized){if(evaluating)throw Error('Report dependency cycle: '+name);evaluating=true;try{value=vm.runInContext('('+def.code+')',ctx,{timeout:1000});initialized=true}finally{evaluating=false}}return value},set(next){value=next;initialized=true}});
 }
 // No network or business write capability is available in this context.
 ctx.save=()=>{throw Error('Report calculations cannot save warehouse data')};ctx.fetch=()=>{throw Error('Report calculations cannot access the network')};
 return {
  async kaspiAdvertising({from,to,confirmedDays,bidChanges,test}){
   ctx.confirmedAdDays=new Set(confirmedDays);ctx.bidChanges=bidChanges;ctx.emptyTests={};
   loadAdsCalculations();
   const range={from,to:test?ctx.iso(now):to}, snapshot=await ctx.loadKaspiOrders(0,{range});
   const model=ctx.buildModel(snapshot,0,range,null,true);
   const finance=snapshot.historyIncomplete||snapshot.returns.some(row=>!row.code&&!row.id&&!row.orderCode&&!row.orderId)
    ? null : {byCode:new Map(model.buyouts.flatMap(row=>[row.id,row.code].filter(Boolean).map(code=>[code,row]))),
     returned:new Set(snapshot.returns.flatMap(row=>[row.id,row.code,row.orderCode,row.orderId].filter(Boolean).map(String)))};
   if(test){
    const orders=await readApi('/api/orders?market=Kaspi&history=1&limit=15000&after='+ctx.dayStart(from)+'&before='+(ctx.dayStart(to)+86400000));
    ctx.data={finance,orders};
    return ctx.testProfit(test,now);
   }
   const totals={byProduct:new Map(model.rows.filter(row=>row.productId).map(row=>[String(row.productId),row])),
    historyIncomplete:snapshot.historyIncomplete,incomplete:Boolean(snapshot.historyIncomplete||model.pendingOrders||model.adsDateMissing
     ||snapshot.returns.length||model.rows.some(row=>!row.productId&&(row.revenue!==0||row.ads>0)))};
   const recentRange={from:ctx.iso(ctx.dayStart(to)-29*86400000),to};
   const recentSnapshot=await ctx.loadKaspiOrders(0,{range:recentRange});
   const recentModel=ctx.buildModel(recentSnapshot,0,recentRange);
   const recentTotals={...totals,byProduct:new Map(recentModel.rows.filter(row=>row.productId)
    .map(row=>[String(row.productId),row])),historyIncomplete:recentSnapshot.historyIncomplete};
   const campaigns=ctx.campaignRows(state.kaspiAdExpenses||[],from,to,ctx.kaspiAdsMatchProduct,to);
   const claims=new Map();
   for(const campaign of campaigns)for(const row of campaign.products.values())for(const code of new Set(row.lines.flatMap(line=>line.orderCodes||[]))){
    const key=code+'|'+row.productId;claims.set(key,(claims.get(key)||0)+1);
   }
   return {campaigns:campaigns.filter(campaign=>campaign.latest),incomplete:totals.incomplete,
    metrics(row,campaign,current){
     const metrics=ctx.campaignMetrics(row,finance,claims);
     const history=ctx.bidHistory(row,campaign,finance,claims,from,to);
     if(current.orders!==metrics.orders||!Number.isFinite(current.spend)||Math.abs(current.spend-row.spend)>.01){delete metrics.profit;delete metrics.buyouts;delete metrics.maxCpc;}
     if(current.clicks!==metrics.clicks)delete metrics.maxCpc;
     Object.assign(metrics,ctx.productTotal(row.productId,totals));
     for(const key of ['views','clicks','orders','bid','score'])if(Number.isFinite(current[key]))metrics[key]=current[key];
     const item=ctx.prod(row.productId),cost=ctx.warehouseUnitCost(item);
     const rates=metrics.feeRate!=null?metrics:ctx.productTotal(row.productId,recentTotals);
     const decisionMetrics=metrics.totalProfit<0&&!metrics.totalPreliminary
      ? {...metrics,profit:Math.min(metrics.profit??0,metrics.totalProfit)} : metrics;
     return {...metrics,cost,...ctx.testPriceTerms(cost,rates.feeRate==null?null:rates),
      bidProposal:ctx.weeklyBid({...decisionMetrics,weekStart:ctx.dayStart(to)+86400000},history)};
    }};
  },
  async forecast(days=30){
   const end=Math.floor((now+18000000)/86400000)*86400000-18000000+86400000,range={from:new Date(end-days*86400000+18000000).toISOString().slice(0,10),to:new Date(end-1+18000000).toISOString().slice(0,10)},rows=[],incompleteSources=[];
   for(const source of forecastMarkets){try{
    if(source==='Kaspi'){const model=ctx.buildModel(await ctx.loadKaspiOrders(0,{range}),0,range);for(const x of model.rows)if(x.productId)rows.push([String(x.productId),Number(x.qty)||0,Number(x.profit)||0,source]);}
    else if(source==='Ozon'){const model=ctx.ozonSummaryFrom(await ctx.loadOzonProfitData(),0,null,range);for(const x of model.products||[])if(x.productId)rows.push([String(x.productId),Math.max(0,Number(x.qty)||0),Number(x.profit)||0,source]);}
    else {const model=await ctx.loadWbModel(source,0,{range});for(const x of model.products||[]){const pid=ctx.wbLiveProductId(source,x);if(pid)rows.push([pid,Math.max(0,Number(x.saleQty??x.qty)||0),(Number(x.netBeforeCost)||0)-ctx.wbReportProductCost(x,pid,source,0,range).cost,source]);}}
   }catch{incompleteSources.push(source)}}
   const totals=new Map();for(const [pid,qty,profit,source]of rows){const x=totals.get(pid)||{qty:0,profit:0,sources:{}};x.qty+=qty;x.profit+=profit;const part=x.sources[source]||{qty:0,profit:0};part.qty+=qty;part.profit+=profit;x.sources[source]=part;totals.set(pid,x)}const result=new Map([...totals].map(([pid,x])=>[pid,{...x,unitProfit:x.qty?x.profit/x.qty:0}]));result.incompleteSources=incompleteSources;return result;
  },
  async auditBuyerTransit(orders,days){
   state.wbOrderFeed=orders;
   const stats=await this.forecast(days),snapshot=ctx.marketplaceToBuyerSnapshot();
   const forecast=ctx.marketplaceToBuyerProfitSummary(stats,snapshot);
   return {outstanding:snapshot.orderUnits,priced:forecast.knownUnits,unpriced:forecast.missingUnits,
    deliveredByStatistics:orders.filter(order=>order.buyerTransitClosed===true).reduce((sum,order)=>sum+(Number(order.qty)||0),0),
    positive:Math.round(forecast.positive),negative:Math.round(forecast.negative),net:forecast.total===null?null:Math.round(forecast.total),
    financeReady:!stats.incompleteSources.length};
  },
  async calculate({from,to,orders,ozonFeed=[],unitProfit=new Map(),partialMarkets=[]}){
   state.settings||={};state.settings.reportMarket=market;state.ozonOrderFeed=ozonFeed;
   ctx.reportCustomFrom=new Date(from+18000000).toISOString().slice(0,10);ctx.reportCustomTo=new Date(to-1+18000000).toISOString().slice(0,10);
   ctx.allMarketUnitProfit30=unitProfit;ctx.businessSyncMarket();
   const range={from:new Date(from+18000000).toISOString().slice(0,10),to:new Date(to-1+18000000).toISOString().slice(0,10)};
   const summaries=await ctx.loadBusinessMarketplaceDaily(range,{market}),groups=ctx.businessOrderGroups({start:from,end:to},orders),days=[];
   for(let start=from;start<to;start+=86400000){const day=new Date(start+18000000).toISOString().slice(0,10),summary=summaries.find(r=>r.day===day)?.summary;if(!summary)throw Error('Нет дневной основы '+day);
    const result=ctx.businessMakeDay(start,groups,summary);result.ordersPartialMarkets=partialMarkets;days.push(JSON.parse(JSON.stringify(result)));
   }
   return days;
  }
 };
}
