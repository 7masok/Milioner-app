const DAY=86400000;
export function queryDay(now=Date.now()) {return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Almaty',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));}
export function shiftDay(day,n){return new Date(Date.parse(day+'T00:00:00Z')+n*DAY).toISOString().slice(0,10);}
export function queryRule(value={}){
 const basis=value.basis??'views',minSamples=Number(value.minSamples??100),minCartPercent=Number(value.minCartPercent??1);
 const clickMinViews=Number(value.clickMinViews??100),minClickPercent=Number(value.minClickPercent??1);
 const validCount=n=>Number.isSafeInteger(n)&&n>=1&&n<=10000000;
 const validPercent=n=>Number.isFinite(n)&&n>=0&&n<=100;
 if(!['views','clicks'].includes(basis)||!validCount(minSamples)||!validPercent(minCartPercent)||!validCount(clickMinViews)||!validPercent(minClickPercent))throw Object.assign(Error('Пороги количества — целые числа от 1 до 10 000 000. Проценты — от 0 до 100.'),{status:400});
 return {basis,minSamples,minCartPercent,clickEnabled:value.clickEnabled===true,clickMinViews,minClickPercent,autoExclude:value.autoExclude===true};
}
export function queryVerdict(row,rule){
 const samples=row[rule.basis]??null,carts=row.cartAdds;
 const percent=samples>0&&carts!=null?Number(carts)/samples*100:null;
 const clickPercent=row.views>0&&row.clicks!=null?Number(row.clicks)/row.views*100:null;
 let state='unknown';
 if(rule.clickEnabled&&row.views>=rule.clickMinViews&&clickPercent!=null&&clickPercent<rule.minClickPercent)state='poorClicks';
 else if(samples!=null&&carts!=null)state=samples<rule.minSamples?'collecting':percent<rule.minCartPercent?'poor':'good';
 return {state,percent,samples,clickPercent};
}
export function canAutoExclude(row,rule){
 if(!rule.autoExclude||row.orders==null||Number(row.orders)!==0)return false;
 return ['poor','poorClicks'].includes(queryVerdict(row,rule).state);
}
// Stable, disjoint 7-day segments remain short enough to refresh inside the WB horizon.
export function queryWindows(first,today){
 const out=[];let from=first;
 while(from<=today){const end=shiftDay(from,6);out.push({from,to:end<today?end:today});from=shiftDay(end,1);}
 return out;
}
export function normalizeQueryStats(data,campaignId,nmId){
 if(!data||!Array.isArray(data.stats))throw Error('WB вернул неизвестный формат статистики запросов');
 const records=data.stats.filter(x=>Number(x.advert_id)===Number(campaignId)&&Number(x.nm_id)===Number(nmId));
 if(records.length!==1)throw Error('WB не вернул однозначную группу запросов для кампании и артикула');
 const rows=records[0]?.stats??[];if(!Array.isArray(rows))throw Error('WB вернул неизвестный список запросов');
 const seen=new Set(),number=(v,integer=true)=>{if(v===null||v===undefined)return null;const n=Number(v);if(!Number.isFinite(n)||n<0||(integer&&!Number.isSafeInteger(n)))throw Error('Некорректный счётчик WB');return n;};
 return rows.map(x=>{const query=String(x.norm_query??'').trim();if(!query||query.length>2000||seen.has(query))throw Error('Некорректный или повторный запрос WB');seen.add(query);return {query,views:number(x.views),clicks:number(x.clicks),cartAdds:number(x.atbs),orders:number(x.orders),spend:number(x.spend,false),currency:String(x.currency??'')};});
}
