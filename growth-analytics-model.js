(function(root){
'use strict';
const finite=v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v));
function opportunity(trend,stock,days){
 const known=trend&&trend.status!=='unknown'&&finite(trend.current),qty=known?Number(trend.current):null;
 const daily=qty===null?null:qty/days,cover=daily>0?stock/daily:null;
 let key='unknown',title='Проверьте полноту истории',text='Недостаточно данных для рекомендации.';
 if(known){if(stock<=0&&qty>0){key='stock';title='Верните товар в продажу';text='Есть спрос, свободного остатка нет. Проверьте поставку и резерв.'}
 else if(cover!==null&&cover<7){key='stock';title='Пополните запас';text='Меньше 7 дней по темпу заказов. Проверьте поставку перед усилением рекламы.'}
 else if(trend.pct!==null&&trend.pct<=-20){key='decline';title='Разберите падение спроса';text='Проверьте цену, карточку, показы и рекламные запросы.'}
 else if(qty===0&&stock>0){key='idle';title='Товар без заказов';text='Проверьте доступность карточки, цену и качество контента.'}
 else if(qty>0&&stock>0){key='growth';title='Кандидат для рекламного теста';text='Спрос и запас есть. Сначала проверьте маржу в калькуляторе; затем тестируйте небольшой бюджет.'}
 else{key='idle';title='Нет заказов и запаса';text='Проверьте доступность товара и необходимость пополнения.'}}
 return{key,title,text,qty,daily,cover};
}
function economics(input){
 const keys=['price','cost','fees','delivery','returns','target','buyout','conversion'];
 if(keys.some(k=>!finite(input[k])||Number(input[k])<0))return null;
 const x=Object.fromEntries(keys.map(k=>[k,Number(input[k])]));
 if(x.price<=0||x.buyout>100||x.conversion>100)return null;
 const margin=x.price-x.cost-x.fees-x.delivery-x.returns,breakEven=Math.max(0,margin)*x.buyout/100,order=Math.max(0,margin-x.target)*x.buyout/100;
 return{margin,breakEven,order,click:order*x.conversion/100,drr:order/x.price*100};
}
function campaign(row,from,to,days){
 const entries=new Map();for(const x of row.periodMetrics||[])if(x.date>=from&&x.date<=to)entries.set(x.date,x);
 const keys=['spend','revenue','orders','clicks','views','cartAdds'];
 const complete=entries.size===days&&[...entries.values()].every(x=>keys.every(k=>finite(x[k])&&Number(x[k])>=0));
 const sums=Object.fromEntries(keys.map(k=>[k,[...entries.values()].reduce((n,x)=>n+(Number(x[k])||0),0)]));
 return{...sums,complete,drr:complete&&sums.revenue>0?sums.spend/sums.revenue*100:null,cpo:complete&&sums.orders>0?sums.spend/sums.orders:null,cpc:complete&&sums.clicks>0?sums.spend/sums.clicks:null,ctr:complete&&sums.views>0?sums.clicks/sums.views*100:null,cr:complete&&sums.clicks>0?sums.orders/sums.clicks*100:null};
}
root.GrowthAnalyticsModel={opportunity,economics,campaign};
})(typeof window==='object'?window:globalThis);
