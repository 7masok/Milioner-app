(function(root){
 'use strict';
 const DAY=86400000;
 function num(x){const n=Number(String(x).replace(',','.'));return Number.isFinite(n)?n:0;}
 function day(date){const parts=String(date).slice(0,10).split('-').map(Number);return Date.UTC(parts[0],parts[1]-1,parts[2])/DAY;}
 function today(){const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
 function date(d){return new Date(Math.floor(d)*DAY).toISOString().slice(0,10);}
 function rate(item){return item.rateMode==='history'?(num(item.activeDays)>0?num(item.sales)/num(item.activeDays):null):(item.daily===null||item.daily===''||item.daily===undefined?null:num(item.daily));}
 function sameCluster(a,b){return !b.clusterOverride&&a.clusterId&&b.clusterId?a.clusterId===b.clusterId:a.cluster===b.cluster;}
 function routeFor(item,routes){return routes.find(r=>r.source!=='Ozon planned'&&r.cluster===item.cluster)||routes.find(r=>sameCluster(item,r));}
 function events(item,shipments,base){return shipments.filter(s=>s.sku===item.sku&&sameCluster(item,s)&&s.status==='in_transit'&&!s.unconfirmed&&!(s.linkedOzonId&&shipments.some(remote=>remote.id===s.linkedOzonId&&remote.source==='Ozon API'))).map(s=>({t:day(s.eta)-base,q:num(s.qty),id:s.id})).filter(s=>s.q>0&&Number.isFinite(s.t)).sort((a,b)=>a.t-b.t);}
 function project(stock,r,ev,end){let remaining=stock,lost=0,last=0,firstGap=null;for(const e of ev.filter(e=>e.t>=0&&e.t<=end).concat([{t:end,q:0}])){const demand=r*(e.t-last);if(demand>remaining+1e-9&&r>0){if(firstGap===null)firstGap=last+remaining/r;lost+=demand-remaining;}remaining=Math.max(0,remaining-demand)+e.q;last=e.t;}return {remaining,lost,firstGap};}
 function calculate(item,route,settings,shipments,now){
  const base=day(now||today()), r=rate(item), lead=route?num(route.prepare)+num(route.travel)+num(route.accept):null;
  if(item.stock===null||item.stock===undefined||item.stock==='')return {item,missing:'Укажи текущий остаток',qty:0,priority:4};
  if(r===null||lead===null)return {item,missing:r===null?'Укажи продажи':'Укажи срок доставки',qty:0,priority:4};
  const safety=num(settings.safety), cover=num(settings.cover), ev=events(item,shipments,base), overdue=ev.filter(e=>e.t<0);
  const awaitingQty=shipments.filter(s=>s.sku===item.sku&&sameCluster(item,s)&&s.status==='in_transit'&&!s.unconfirmed&&!(s.linkedOzonId&&shipments.some(remote=>remote.id===s.linkedOzonId&&remote.source==='Ozon API'))&&(!s.eta||!Number.isFinite(day(s.eta))||day(s.eta)<base)).reduce((q,s)=>q+Math.max(0,num(s.qty)),0);
  const arrival=project(num(item.stock),r,ev,lead), future=ev.filter(e=>e.t>lead&&e.t<=lead+cover+safety);
  let needed=0,cumulative=0;for(const e of future){needed=Math.max(needed,r*(e.t-lead)-arrival.remaining-cumulative);cumulative+=e.q;}
  needed=Math.max(needed,r*(cover+safety)-arrival.remaining-cumulative);
  const calculated=Math.max(0,Math.ceil(needed-1e-9)), ozon=item.ozon===null||item.ozon===undefined||item.ozon===''?null:num(item.ozon);
  let qty=settings.ozonFloor&&ozon!==null?Math.max(calculated,ozon):calculated;
  const pack=Math.max(1,num(item.pack)||1);qty=Math.ceil(qty/pack)*pack;
  const long=project(num(item.stock),r,ev,3650), depletion=r>0?(long.firstGap===null?3650:long.firstGap):null;
  const dispatch=depletion===null?null:Math.floor(depletion-lead-safety);
  const priority=arrival.lost>0?0:dispatch!==null&&dispatch<=0?1:dispatch!==null&&dispatch<=7?2:3;
  return {item,r,lead,eta:date(base+lead),qty,calculated,ozon,pack,arrivalStock:arrival.remaining,lost:arrival.lost,overdue:overdue.length,awaitingQty,inTransitQty:ev.filter(e=>e.t>=0).reduce((q,e)=>q+e.q,0),dispatch,deadline:dispatch===null?null:date(base+dispatch),depletion,priority,missing:null};
 }
 function allocate(plans,stocks){const sorted=plans.slice().sort((a,b)=>a.priority-b.priority||(a.dispatch??1e9)-(b.dispatch??1e9)||b.r-a.r);const available={};for(const s of stocks)available[s.sku]=num(s.qty);for(const p of sorted){if(!(p.item.sku in available)){p.allocated=null;p.shortage=null;continue;}const left=available[p.item.sku], n=Math.min(p.qty,Math.floor(left/(p.pack||1))*(p.pack||1));p.allocated=n;p.shortage=p.qty-n;available[p.item.sku]-=n;}return sorted;}
 function plan(state,now){const shipments=root.Supplies?root.Supplies.withRouteDates(state.shipments,state.inboundRoutes||[]):state.shipments,routes=root.Supplies?root.Supplies.routesForState(state):state.routes;return allocate(state.items.map(i=>calculate(i,routeFor(i,routes),state.settings,shipments,now)),state.ownStocks||[]);}
 function csvRows(text){const sep=text.split(/\r?\n/)[0].includes(';')?';':',';const rows=[];let row=[],value='',quoted=false;for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){value+='"';i++;}else quoted=!quoted;}else if(c===sep&&!quoted){row.push(value);value='';}else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(value);if(row.some(x=>x.trim()))rows.push(row);row=[];value='';}else value+=c;}row.push(value);if(row.some(x=>x.trim()))rows.push(row);if(quoted)throw Error('Незакрытые кавычки в CSV');return rows;}
 const api={num,day,date,today,rate,project,calculate,plan,csvRows,routeFor,sameCluster};root.Planner=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
