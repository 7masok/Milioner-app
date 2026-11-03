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
 const defs=calculationDefinitions();
 for(const [name,def]of defs){if(Object.hasOwn(ctx,name))continue;
  let initialized=false,value,evaluating=false;
  Object.defineProperty(ctx,name,{configurable:true,enumerable:true,get(){if(!initialized){if(evaluating)throw Error('Report dependency cycle: '+name);evaluating=true;try{value=vm.runInContext('('+def.code+')',ctx,{timeout:1000});initialized=true}finally{evaluating=false}}return value},set(next){value=next;initialized=true}});
 }
 // No network or business write capability is available in this context.
 ctx.save=()=>{throw Error('Report calculations cannot save warehouse data')};ctx.fetch=()=>{throw Error('Report calculations cannot access the network')};
 return {
  async forecast(){
   const end=Math.floor((now+18000000)/86400000)*86400000-18000000+86400000,range={from:new Date(end-30*86400000+18000000).toISOString().slice(0,10),to:new Date(end-1+18000000).toISOString().slice(0,10)},rows=[],incompleteSources=[];
   for(const source of forecastMarkets){try{
    if(source==='Kaspi'){const model=ctx.buildModel(await ctx.loadKaspiOrders(0,{range}),0,range);for(const x of model.rows)if(x.productId)rows.push([String(x.productId),Number(x.qty)||0,Number(x.profit)||0,source]);}
    else if(source==='Ozon'){const model=ctx.ozonSummaryFrom(await ctx.loadOzonProfitData(),0,null,range);for(const x of model.products||[])if(x.productId)rows.push([String(x.productId),Math.max(0,Number(x.qty)||0),Number(x.profit)||0,source]);}
    else {const model=await ctx.loadWbModel(source,0,{range});for(const x of model.products||[]){const pid=ctx.wbLiveProductId(source,x);if(pid)rows.push([pid,Math.max(0,Number(x.saleQty??x.qty)||0),(Number(x.netBeforeCost)||0)-ctx.wbReportProductCost(x,pid,source,0,range).cost,source]);}}
   }catch{incompleteSources.push(source)}}
   const totals=new Map();for(const [pid,qty,profit,source]of rows){const x=totals.get(pid)||{qty:0,profit:0,sources:{}};x.qty+=qty;x.profit+=profit;const part=x.sources[source]||{qty:0,profit:0};part.qty+=qty;part.profit+=profit;x.sources[source]=part;totals.set(pid,x)}const result=new Map([...totals].map(([pid,x])=>[pid,{...x,unitProfit:x.qty?x.profit/x.qty:0}]));result.incompleteSources=incompleteSources;return result;
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
