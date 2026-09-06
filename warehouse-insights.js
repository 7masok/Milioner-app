(function(){
 'use strict';
 const DAY=86400000;
 const number=x=>Number.isFinite(Number(x))?Number(x):0;
 function analyze(products,orders,purchases,now=Date.now()){
  const demand=new Map(),seen=new Set(),since=now-25*DAY;
  let unmatched=0,oldest=null;
  for(const o of orders){
   const date=number(o.date);if(date<=0||date>now)continue;
   oldest=oldest===null?date:Math.min(oldest,date);
   if(date<since||o.cancelled)continue;
   if(o.key){if(seen.has(o.key))continue;seen.add(o.key);}
   if(!o.productId){unmatched++;continue;}
   demand.set(String(o.productId),(demand.get(String(o.productId))||0)+Math.max(0,number(o.qty)));
  }
  const inbound=new Map();
  for(const p of purchases){const key=String(p.productId),rows=inbound.get(key)||[];rows.push(p);inbound.set(key,rows);}
  const rows=products.map(p=>{
   const free=Math.max(0,number(p.stock)-number(p.reserved)),qty=demand.get(String(p.id))||0,daily=qty/25,days=daily>0?free/daily:null,cost=Math.max(0,number(p.cost));
   const lots=inbound.get(String(p.id))||[],scheduled=lots.filter(l=>Number.isFinite(l.days)&&l.days>=0&&l.qty>0).sort((a,b)=>a.days-b.days);
   let balance=free,time=0,gap=false;
   for(const lot of scheduled){balance-=daily*(lot.days-time);if(balance<0)gap=true;balance+=lot.qty;time=lot.days;}
   const next=scheduled[0]?.days??null;
   return {...p,free,qty,daily,days,cost,value:free*cost,inbound:lots.reduce((n,l)=>n+Math.max(0,number(l.qty)),0),next,gap:daily>0&&gap,unknownArrival:lots.some(l=>l.days===null),risk:daily>0&&(gap||(days<5&&(!scheduled.length||balance<daily*Math.max(0,5-time)))),noOrders:free>0&&qty===0};
  });
  return {rows,unmatched,oldest,periodDays:25,freeValue:rows.reduce((n,r)=>n+r.value,0),missingCost:rows.filter(r=>r.free>0&&!r.cost).length,quietValue:rows.filter(r=>r.noOrders).reduce((n,r)=>n+r.value,0)};
 }
 window.WarehouseInsights={analyze};
})();
