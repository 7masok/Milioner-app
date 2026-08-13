(function(){
const K=window.KaspiPay;if(!K||!window.kaspiPayRow)return;
const old=renderMarketplaceReportSheet;
const card=(label,value)=>'<div class="card"><div class="label">'+label+'</div><div class="num">'+value+'</div></div>';
renderMarketplaceReportSheet=function(){
 const market=marketplaceReportContext?.market,raw=Number(marketplaceReportContext?.days),days=raw===-1?-1:Math.max(1,raw||1);
 if(market!=='Kaspi')return old();
 const pay=K.breakdown(days);if(!pay.covered||!pay.rows)return old();
 const rows=marketplaceProductStats('Kaspi',days),profit=rows.reduce((a,x)=>a+Number(x.profit||0),0);
 const buttons='<div class="period" style="margin-top:0"><button class="chip '+(days===1?'active':'')+'" onclick="setMarketplaceReportPeriod(1)">Сегодня</button><button class="chip '+(days===-1?'active':'')+'" onclick="setMarketplaceReportPeriod(-1)">Вчера</button><button class="chip '+(days===7?'active':'')+'" onclick="setMarketplaceReportPeriod(7)">7 дней</button><button class="chip '+(days===30?'active':'')+'" onclick="setMarketplaceReportPeriod(30)">30 дней</button></div>';
 const actions='<div class="integration-actions"><button class="btn dark" onclick="openKaspiPayImport()">Импорт Kaspi Pay</button><button class="btn" onclick="showKaspiPayHistory()">История импортов</button></div>';
 const summary='<div class="cards">'+card('Покупки',K.money2(pay.grossPurchases))+card('Возвраты',K.money2(pay.returnAmount))+card('Чистая выручка',K.money2(pay.revenue))+card('Удержания',K.money2(pay.totalExpenses))+card('К выплате',K.money2(pay.payout))+card('Прибыль склада',K.money2(profit))+'</div>';
 const fees='<div class="item" style="margin-top:10px"><div class="muted">Состав удержаний</div><div style="margin-top:5px">Комиссия: <b>'+K.money2(pay.commission)+'</b> · Kaspi Pay: <b>'+K.money2(pay.kaspiPay)+'</b> · Доставка: <b>'+K.money2(pay.delivery)+'</b> · Карты: <b>'+K.money2(pay.cardCommission)+'</b> · Прочее: <b>'+K.money2(pay.paymentGuarantee+pay.kaspiTravel+pay.bonusProduct+pay.bonusReview)+'</b></div></div>';
 const daily='<div class="kaspi-audit-scroll" style="margin-top:10px"><table class="kaspi-audit-table" style="min-width:720px"><thead><tr><th>Дата</th><th>Покупки</th><th>Возвраты</th><th>Чистая выручка</th><th>Удержания</th><th>К выплате</th></tr></thead><tbody>'+pay.byDay.map(d=>'<tr><td>'+esc(d.date)+'</td><td>'+K.money2(d.grossPurchases)+'</td><td>'+K.money2(d.returnAmount)+'</td><td>'+K.money2(d.revenue)+'</td><td>'+K.money2(d.financialExpenses)+'</td><td><b>'+K.money2(d.payout)+'</b></td></tr>').join('')+'</tbody></table></div>';
 const table='<div class="kaspi-audit-scroll" style="margin-top:10px"><table class="kaspi-audit-table" style="min-width:1220px"><thead><tr><th>Товар</th><th>Кол.</th><th>Продажи</th><th>Себестоимость</th><th>Комиссия</th><th>По карте</th><th>Kaspi Pay</th><th>Доставка</th><th>Прочее</th><th>Реклама</th><th>Прибыль</th></tr></thead><tbody>'+rows.map(window.kaspiPayRow).join('')+'</tbody></table></div>';
 showSheet('<h3>Продажи Kaspi · факт Kaspi Pay</h3>'+buttons+actions+summary+fees+'<h3 style="margin-top:16px">По дням</h3>'+daily+'<h3 style="margin-top:16px">По товарам</h3>'+table+'<div class="link-note">Комиссии, Kaspi Pay, доставка и возвраты — из Excel Kaspi Pay. Себестоимость — из склада. Реклама — из отдельного отчёта Kaspi Маркетинг.</div>');
};
})();