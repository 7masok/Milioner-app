(function(root){
'use strict';
const known=v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v));
const positive=v=>known(v)?Math.max(0,Number(v)):null;
const key=x=>x.clusterOverride?'name:'+x.cluster:x.clusterId?'id:'+x.clusterId:'name:'+(x.cluster||'Без кластера');
function same(a,b){return !b.clusterOverride&&a.clusterId&&b.clusterId?String(a.clusterId)===String(b.clusterId):a.cluster===b.cluster;}
function incoming(rows){const remote=new Set(rows.filter(s=>s.source==='Ozon API').map(s=>s.id));return rows.filter(s=>s.status==='in_transit'&&!s.unconfirmed&&!['COMPLETED','CANCELLED','REJECTED_AT_SUPPLY_WAREHOUSE','OVERDUE'].includes(s.ozonState)&&!(s.source!=='Ozon API'&&s.linkedOzonId&&remote.has(s.linkedOzonId)));}
function products(data){const shipments=incoming(data.shipments||[]);return(data.plans||[]).map(plan=>{
 const stock=positive(plan.item.stock),daily=positive(plan.r??(plan.item.rateMode==='history'&&Number(plan.item.activeDays)>0?Number(plan.item.sales)/Number(plan.item.activeDays):plan.item.daily));
 const cover=stock!==null&&daily>0?stock/daily:null,own=shipments.filter(s=>String(s.sku)===String(plan.item.sku)&&same(plan.item,s)),transit=own.reduce((sum,s)=>sum+(positive(s.qty)||0),0),uncertain=own.filter(s=>!s.eta||s.category==='delayed'||!known(s.qty));
 const demandKnown=stock!==null&&daily!==null,need=plan.missing?null:positive(plan.qty),state=!demandKnown||plan.missing?'missing':plan.lost>0?'urgent':need>0?'need':'ok';
 return{...plan,stock,daily,cover,need,transit,uncertain:uncertain.length,clusterKey:key(plan.item),name:plan.warehouseName||data.productNames?.[plan.item.sku]||plan.item.name||plan.item.sku,state};
 });}
function clusters(data){const rows=products(data),groups=new Map();for(const p of rows){if(!groups.has(p.clusterKey))groups.set(p.clusterKey,{key:p.clusterKey,name:p.item.cluster||'Без кластера',products:[],stock:0,stockUnknown:0,transit:0,need:0,needUnknown:0,urgent:0,minCover:null,lead:null,route:null,uncertain:0});const c=groups.get(p.clusterKey);c.products.push(p);if(p.stock===null)c.stockUnknown++;else c.stock+=p.stock;c.transit+=p.transit;if(p.need===null)c.needUnknown++;else c.need+=p.need;if(p.state==='urgent')c.urgent++;if(p.cover!==null)c.minCover=c.minCover===null?p.cover:Math.min(c.minCover,p.cover);c.lead=p.lead??c.lead;c.route=p.route||c.route;c.uncertain+=p.uncertain;}
 // Keep incoming directions visible even when Ozon has not returned product analytics.
 for(const s of incoming(data.shipments||[])){const k=key(s);if(!groups.has(k))groups.set(k,{key:k,name:s.cluster||'Без кластера',products:[],stock:null,stockUnknown:1,transit:positive(s.qty)||0,need:null,needUnknown:1,urgent:0,minCover:null,lead:null,route:null,uncertain:!s.eta?1:0});else if(!rows.some(p=>p.clusterKey===k&&String(p.item.sku)===String(s.sku)))groups.get(k).transit+=positive(s.qty)||0;}
 return[...groups.values()].sort((a,b)=>b.urgent-a.urgent||(a.minCover??Infinity)-(b.minCover??Infinity)||a.name.localeCompare(b.name,'ru'));}
function supplies(data){const remote=new Set((data.shipments||[]).filter(s=>s.source==='Ozon API').map(s=>s.id)),groups=new Map();for(const s of data.shipments||[]){if(s.source!=='Ozon API'&&s.linkedOzonId&&remote.has(s.linkedOzonId))continue;if(['archive'].includes(s.category))continue;const k=(s.source==='Ozon API'?'ozon:':'manual:')+(s.supplyId||s.orderId||s.id);if(!groups.has(k))groups.set(k,{key:k,rows:[],number:s.orderNumber||s.orderId||s.id});groups.get(k).rows.push(s);}return[...groups.values()].map(c=>({...c,qty:c.rows.every(s=>known(s.qty))?c.rows.reduce((n,s)=>n+Number(s.qty),0):null,eta:c.rows.every(s=>s.eta===c.rows[0].eta)?c.rows[0].eta:null}));}
root.FboDashboardModel={known,key,same,incoming,products,clusters,supplies};
})(typeof window==='object'?window:globalThis);
